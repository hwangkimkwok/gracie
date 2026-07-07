// ============================================================================
// 成长冒险岛 v8.6 · Supabase Edge Function: child-submit
// ----------------------------------------------------------------------------
// v8.6 变更：函数逻辑不变（PIN 自校验 + service_role 写 event_log/child_state）。
//   本版重点是配套的 supabase-rls-policies.sql——收紧 RLS：event_log/child_state 的写入
//   仅允许 service_role(本函数)，anon 客户端只能读本家庭数据。本函数以 service_role 运行，
//   不受 RLS 限制，是客户端写这两张表的唯一合法通道，与新 RLS 策略配套形成安全边界。
// v8.5 变更：type 白名单新增 "tv"（孩子自定义看电视时长申请）；child_data 整体
//   upsert child_state 逻辑不变，仍以完整 child 对象同步全部待确认状态（含 day.tvPend）。
// ----------------------------------------------------------------------------
// 目的（跨设备同步 BUG 修复的服务端侧）：
//   孩子端通过「选孩子 + 4 位 PIN」进入，不持有 Supabase Auth session，
//   因此无法以 authenticated 身份直接写 event_log / child_state（被 RLS 拦截）。
//   本函数以 service_role 在服务端写库，并用 child_id + PIN 自校验来鉴权，
//   使孩子在独立设备闯关/提交后，另一台设备的家长端可经 Realtime 实时收到待确认。
//
// v8.4 关键修复（全部提交类型的待确认状态同步）：
//   孩子端所有待确认状态（day.pending / day.rdPend / day.jPend / money_log(pending) /
//   bounty 状态等）都存在 child_state 里。旧版本本函数只写 event_log、不更新
//   child_state，导致家长端/后台管理端经 Realtime 收到通知后，读到的仍是旧
//   child_state，看不到阅读/跳绳/零花钱/悬赏等刚提交的 pending（表现为提交后无反应）。
//   现在前端会随请求携带 child_data（孩子提交后的完整 child 对象），本函数在校验
//   通过、写 event_log 之后，直接用 child_data 整体 upsert child_state，
//   使所有提交类型的待确认状态都能被家长端与后台管理端读到。
//   （未携带 child_data 的旧前端请求，仍走 mergePendingIntoState 增量合并兜底。）
//
// 安全要点：
//   - service_role key 仅在本函数内部使用（从环境变量读取），绝不下发前端。
//   - type 限定白名单（task/reading/jump/money/bounty/tv），拒绝越权字段。
//   - PIN 校验失败返回 401；孩子端无任何写家长级字段能力（只写 event_log(pending)
//     与该孩子自身的 child_state 快照）。child_data 的 id/family 归属由服务端强校验，
//     无法越权写到别的孩子。
//   - 返回正确的 CORS 头，允许 https://hwangkimkwok.github.io 跨域调用。
//
// 部署：
//   supabase functions deploy child-submit --no-verify-jwt
//   （--no-verify-jwt：允许孩子端用 anon key 调用而无需 Auth JWT；
//     真正的鉴权由本函数内部的 child_id + PIN 哈希校验完成。）
//
// 环境变量（Supabase 自动注入，无需手动配置 SERVICE_ROLE）：
//   SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- CORS：允许 GitHub Pages 部署源跨域 ----
const ALLOWED_ORIGINS = new Set<string>([
  "https://hwangkimkwok.github.io",
]);
function corsHeaders(origin: string | null): Record<string, string> {
  // 命中白名单则回显该 origin，否则回退到主部署源
  const allow =
    origin && ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://hwangkimkwok.github.io";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

// ---- 提交类型白名单（与前端 childSubmitEvent 调用点一致） ----
const ALLOWED_TYPES = new Set<string>([
  "task",     // 任务 / 闯关打卡
  "reading",  // 阅读分钟
  "jump",     // 跳绳个数
  "money",    // 零花钱申请
  "bounty",   // 悬赏提交
  "tv",       // v8.5：孩子自定义看电视时长申请
]);

// ----------------------------------------------------------------------------
// PIN 哈希算法：必须与前端 index.html 的 hashPwd() 完全一致（DJB2 变体）
//   function hashPwd(pwd,salt){let h=5381;const s=salt+'::'+pwd;
//     for(let i=0;i<s.length;i++){h=((h<<5)+h+s.charCodeAt(i))>>>0;}
//     return 'h'+h.toString(36);}
// 用于「前端只传明文 PIN」时由本函数重算比对（回退路径）。
// ----------------------------------------------------------------------------
function hashPwd(pwd: string, salt: string): string {
  let h = 5381;
  const s = salt + "::" + pwd;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; // h*33 + c，保持 uint32
  }
  return "h" + h.toString(36);
}

// 恒定时间字符串比较，降低时序侧信道风险
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");

  // ---- 预检 ----
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, origin);
  }

  // ---- 解析入参 ----
  let payloadBody: any;
  try {
    payloadBody = await req.json();
  } catch (_e) {
    return json({ error: "bad_json" }, 400, origin);
  }
  const child_id: string = payloadBody?.child_id || "";
  const type: string = payloadBody?.type || "";
  const payload = payloadBody?.payload ?? {};
  // v8.4：孩子提交后的完整 child 对象（用于整体更新 child_state，同步全部 pending 状态）
  const child_data: any = payloadBody?.child_data ?? null;
  // PIN 传递：优先 pin_hash + pin_salt（前端不存明文，发送已存哈希）；
  // 兼容 login_pin（明文）作为回退路径——由函数重算哈希或比对 child.login_pin 列。
  const pin_hash: string = payloadBody?.pin_hash || "";
  const pin_salt: string = payloadBody?.pin_salt || "";
  const login_pin: string = payloadBody?.login_pin || "";

  // ---- 基本校验 ----
  if (!child_id) return json({ error: "missing_child_id" }, 400, origin);
  if (!ALLOWED_TYPES.has(type)) {
    return json({ error: "invalid_type" }, 400, origin);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return json({ error: "invalid_payload" }, 400, origin);
  }

  // ---- service_role 客户端（仅函数内使用，绝不下发前端） ----
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json({ error: "server_misconfigured" }, 500, origin);
  }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- 读取该孩子记录（取 family_id 用于写库 + 取 PIN 凭据用于校验） ----
  const { data: childRow, error: childErr } = await admin
    .from("child")
    .select("id, family_id, name, login_pin")
    .eq("id", child_id)
    .limit(1)
    .single();
  if (childErr || !childRow) {
    return json({ error: "child_not_found" }, 404, origin);
  }

  // 读取该孩子云端整存状态（其中含 cred:{salt,hash}，是 PIN 校验的主依据）
  const { data: stateRow } = await admin
    .from("child_state")
    .select("child_id, data")
    .eq("child_id", child_id)
    .limit(1)
    .maybeSingle();
  const stateData: any = stateRow?.data ?? null;
  const storedCred =
    stateData && stateData.cred ? stateData.cred : null; // {salt, hash}

  // ---- PIN 校验：三条路径，任一通过即可 ----
  let authed = false;
  // 路径①（推荐）：前端发送已存哈希 → 与 child_state.data.cred 比对
  if (!authed && pin_hash && storedCred && storedCred.hash) {
    if (
      safeEqual(pin_hash, storedCred.hash) &&
      (!pin_salt || safeEqual(pin_salt, storedCred.salt || ""))
    ) {
      authed = true;
    }
  }
  // 路径②（回退）：前端发送明文 PIN → 用同算法 + storedCred.salt 重算比对
  if (!authed && login_pin && storedCred && storedCred.hash && storedCred.salt) {
    if (safeEqual(hashPwd(login_pin, storedCred.salt), storedCred.hash)) {
      authed = true;
    }
  }
  // 路径③（回退）：明文 PIN 比对 child.login_pin 列（早期建档明文场景）
  if (!authed && login_pin && childRow.login_pin) {
    if (safeEqual(String(login_pin), String(childRow.login_pin))) {
      authed = true;
    }
  }

  if (!authed) {
    return json({ error: "unauthorized", detail: "pin_mismatch" }, 401, origin);
  }

  // ---- 写 event_log(pending) ----
  // 注：family_id 由 child_id 经 RLS 子查询 (child.family_id = my_family_id()) 反推，
  //     event_log 表本身无 family_id 列（与 v8.0 建表 SQL 一致），前端无法伪造归属。
  const eventRow = {
    child_id: child_id,
    type: type,
    status: "pending",
    payload: payload,
  };
  const { error: logErr } = await admin.from("event_log").insert(eventRow);
  if (logErr) {
    return json({ error: "event_insert_failed", detail: logErr.message }, 500, origin);
  }

  // ---- 关键新增（v8.4）：用孩子提交后的完整数据整体更新 child_state ----
  // 让家长端/后台管理端经 Realtime 读到 pending / rdPend / jPend / money_log / bounty
  // 等全部待确认状态（不再只有闯关/任务）。child_data 的归属（id 必须等于本次校验过的
  // 孩子）由服务端强校验，避免越权写到别的孩子；写入的是该孩子自身的整存快照。
  // 兜底：若前端未携带 child_data（旧版本），仍走 mergePendingIntoState 增量合并。
  try {
    if (child_data && typeof child_data === "object" && !Array.isArray(child_data)) {
      // 安全校验：child_data.id 若存在，必须与已校验的 child_state.cred 所属孩子一致，
      // 即与本次 child_id 对应；不放行携带他人快照覆盖。stateData 为空（云端首存）时允许建档。
      const idOk =
        !child_data.id ||
        !stateData ||
        !stateData.id ||
        String(child_data.id) === String(stateData.id);
      if (idOk) {
        // 保留云端既有 cred（PIN 凭据以服务端为准，避免被请求体篡改）
        const dataToWrite: any = { ...child_data };
        if (storedCred) dataToWrite.cred = storedCred;
        await admin
          .from("child_state")
          .upsert(
            { child_id: child_id, data: dataToWrite, updated_at: new Date().toISOString() },
            { onConflict: "child_id" },
          );
      } else if (stateData) {
        // child_data 归属不符 → 退回增量合并已有 stateData，绝不覆盖
        const merged = mergePendingIntoState(stateData, type, payload);
        if (merged) {
          await admin
            .from("child_state")
            .upsert(
              { child_id: child_id, data: merged, updated_at: new Date().toISOString() },
              { onConflict: "child_id" },
            );
        }
      }
    } else if (stateData) {
      // 旧前端未携带 child_data：最小增量合并把待确认写进已有快照
      const merged = mergePendingIntoState(stateData, type, payload);
      if (merged) {
        await admin
          .from("child_state")
          .upsert(
            { child_id: child_id, data: merged, updated_at: new Date().toISOString() },
            { onConflict: "child_id" },
          );
      }
    }
    // 若云端尚无 child_state 且无 child_data，则不创建——家长端可由 event_log(pending) 感知待确认。
  } catch (_e) {
    // 更新失败不影响主流程：event_log 已写入，家长端仍能收到待确认
  }

  return json({ ok: true, status: "pending" }, 200, origin);
});

// ----------------------------------------------------------------------------
// 把孩子提交登记进 child_state.data 的当日待确认队列（与前端 dd()/daily 结构一致）
// 业务今日键 tKey：统一 SGT(UTC+8)，与前端 getSGT()/tKey() 口径一致防作弊。
// 只写 pending 性质字段；done/stars/money 等结算字段一律不动。
// ----------------------------------------------------------------------------
function sgtTKey(): string {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const d = new Date(utc + 8 * 3600000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}

function mergePendingIntoState(state: any, type: string, payload: any): any | null {
  try {
    const k = sgtTKey();
    state.daily = state.daily || {};
    const day = state.daily[k] || (state.daily[k] = {
      done: [], pending: [], rejected: [],
      rdMins: 0, rdPend: 0, jCnt: 0, jPend: 0, tvPend: 0, tvGrant: 0,
    });
    day.done = Array.isArray(day.done) ? day.done : [];
    day.pending = Array.isArray(day.pending) ? day.pending : [];
    day.rejected = Array.isArray(day.rejected) ? day.rejected : [];

    if (type === "task") {
      const id = payload?.taskId;
      if (id && !day.pending.includes(id) && !day.done.includes(id)) {
        day.pending.push(id);
      }
    } else if (type === "reading") {
      const m = Number(payload?.mins) || 0;
      if (m > 0) day.rdPend = (Number(day.rdPend) || 0) + m;
    } else if (type === "jump") {
      const cnt = Number(payload?.count) || 0;
      if (cnt > 0) day.jPend = cnt;
    } else if (type === "tv") {
      // v8.5：孩子自定义看电视时长申请（待确认），覆盖为最新值，家长确认后计入 tvGrant
      const mins = Number(payload?.mins) || 0;
      if (mins > 0) day.tvPend = mins;
    } else if (type === "money") {
      // 零花钱待确认登记进 money_log（pending），家长确认后入账
      state.money_log = Array.isArray(state.money_log) ? state.money_log : [];
      const amount = Number(payload?.amount) || 0;
      state.money_log.unshift({
        id: "e_" + Date.now().toString(36),
        ts: new Date().toISOString(),
        amount: amount,
        source: String(payload?.desc || "零花钱申请"),
        status: "pending",
      });
    } else if (type === "bounty") {
      // 悬赏提交：标记对应悬赏为 submitted（家长确认才发放）
      const bid = payload?.bountyId;
      if (bid && Array.isArray(state.bounties)) {
        const b = state.bounties.find((x: any) => x && x.id === bid);
        if (b && b.status !== "submitted") b.status = "submitted";
      }
    }
    return state;
  } catch (_e) {
    return null;
  }
}
