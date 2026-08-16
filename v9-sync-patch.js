'use strict';

/* ============================================================
 成长冒险岛 v9.0.0 云同步补丁

 功能：
 1. 家长/后台写入改走 parent-save Edge Function
 2. 创建/加入家庭改走 family-setup Edge Function
 3. 修复 OUTBOX 重放重复入队
 4. 增加“绑定孩子设备”入口
 5. 孩子设备通过 child-pair 首次绑定
 6. 登录后自动补传离线记录
 ============================================================ */

window.GRACIE_V9_PATCH = true;

/* ------------------------------------------------------------
 1. 家长/后台：安全保存孩子完整状态
 ------------------------------------------------------------ */

const V9_PUSH_CHAINS = Object.create(null);

async function v9DoCloudPushChild(cobj, options) {
  options = options || {};

  if (!cobj || !cobj.id) {
    console.error('[v9] cloudPushChild 缺少孩子数据');
    return false;
  }

  if (!cloudWriteAllowed()) {
    console.info(
      '[v9] 非家长角色禁止推送完整状态',
      REALROLE
    );
    return false;
  }

  if (!cloudActive()) {
    if (!options.fromOutbox) {
      pushOutbox('state', cobj.id, cobj);
    }

    return false;
  }

  try {
    const cloudId =
      cobj._cloudId ||
      CLOUD.childIdMap[cobj.id] ||
      '';

    if (!CLOUD._lastPushTs) {
      CLOUD._lastPushTs = {};
    }

    CLOUD._lastPushTs[cobj.id] = Date.now();
    pruneLastPushTs();

    const result = await CLOUD.sb.functions.invoke(
      'parent-save',
      {
        body: {
          child_id: cloudId,
          child_data: cobj
        }
      }
    );

    const data = result && result.data;
    const error = result && result.error;

    if (
      error ||
      !data ||
      data.ok !== true ||
      !data.child_id
    ) {
      console.error(
        '[v9] parent-save 保存失败',
        error || data
      );

      if (!options.fromOutbox) {
        pushOutbox('state', cobj.id, cobj);
      }

      if (!options.silent && typeof toast === 'function') {
        toast(
          '⚠️ 云端保存失败，已保存在本机并等待补传'
        );
      }

      return false;
    }

    /*
     * Edge Function 首次创建孩子后会返回云端 UUID。
     * 将它写回本机，供 child-sync、child-submit 使用。
     */
    cobj._cloudId = data.child_id;
    CLOUD.childIdMap[cobj.id] = data.child_id;

    if (
      CACHE &&
      CACHE.childData &&
      CACHE.childData[cobj.id]
    ) {
      CACHE.childData[cobj.id]._cloudId =
        data.child_id;

      localSaveRoot(CACHE);
    }

    return true;
  } catch (error) {
    console.error(
      '[v9] cloudPushChild 异常',
      error
    );

    if (!options.fromOutbox) {
      pushOutbox('state', cobj.id, cobj);
    }

    if (!options.silent && typeof toast === 'function') {
      toast(
        '⚠️ 网络或云端异常，修改已保存在本机'
      );
    }

    return false;
  }
}

/*
 * 同一孩子的多次写入排队执行，避免首次创建云端孩子时产生重复记录。
 */
window.cloudPushChild = function cloudPushChild(
  cobj,
  options
) {
  options = options || {};

  if (!cobj || !cobj.id) {
    return Promise.resolve(false);
  }

  const key = cobj.id;
  const previous =
    V9_PUSH_CHAINS[key] || Promise.resolve();

  const task = previous
    .catch(function () {})
    .then(function () {
      /*
       * 执行时优先读取 CACHE 中的最新状态，
       * 避免排队期间继续修改后写入旧快照。
       */
      const latest =
        CACHE &&
        CACHE.childData &&
        CACHE.childData[key]
          ? CACHE.childData[key]
          : cobj;

      return v9DoCloudPushChild(
        latest,
        options
      );
    });

  V9_PUSH_CHAINS[key] = task;

  task.finally(function () {
    if (V9_PUSH_CHAINS[key] === task) {
      delete V9_PUSH_CHAINS[key];
    }
  });

  return task;
};

/* ------------------------------------------------------------
 2. 修复 OUTBOX 重放
 ------------------------------------------------------------ */

window.cloudFlushOutbox =
async function cloudFlushOutbox() {
  if (
    (!cloudActive() &&
      !(CLOUD.sb && CLOUD.online)) ||
    !CLOUD.outbox.length
  ) {
    return;
  }

  const items = CLOUD.outbox.slice();
  CLOUD.outbox = [];

  try {
    localStorage.removeItem(OUTBOX_KEY);
  } catch (error) {
    console.warn(
      '[v9] 清理旧 OUTBOX 失败',
      error
    );
  }

  const remain = [];

  for (const item of items) {
    try {
      if (item.kind === 'state') {
        if (
          cloudActive() &&
          cloudWriteAllowed()
        ) {
          const latest =
            CACHE &&
            CACHE.childData &&
            CACHE.childData[item.childLocalId]
              ? CACHE.childData[item.childLocalId]
              : item.data;

          const ok = await cloudPushChild(
            latest,
            {
              fromOutbox: true,
              silent: true
            }
          );

          if (!ok) {
            remain.push(item);
          }
        } else {
          remain.push(item);
        }

        continue;
      }

      if (item.kind === 'event') {
        const eventData = item.data || {};

        const currentChild =
          CACHE &&
          CACHE.childData &&
          CACHE.childData[item.childLocalId]
            ? CACHE.childData[item.childLocalId]
            : null;

        const cloudId =
          eventData.cloudId ||
          (
            currentChild &&
            (
              currentChild._cloudId ||
              CLOUD.childIdMap[currentChild.id]
            )
          ) ||
          CLOUD.childIdMap[item.childLocalId];

        const credential =
          (
            currentChild &&
            currentChild.cred
          ) ||
          (
            eventData.child_data &&
            eventData.child_data.cred
          ) ||
          {};

        if (!CLOUD.sb || !CLOUD.online || !cloudId) {
          remain.push(item);
          continue;
        }

        const result =
          await CLOUD.sb.functions.invoke(
            'child-submit',
            {
              body: {
                child_id: cloudId,
                pin_hash:
                  credential.hash || '',
                pin_salt:
                  credential.salt || '',
                type: eventData.type,
                payload:
                  eventData.payload || {}
              }
            }
          );

        if (result.error) {
          remain.push(item);
        }
      }
    } catch (error) {
      console.warn(
        '[v9] OUTBOX 单项补传失败',
        error
      );

      remain.push(item);
    }
  }

  CLOUD.outbox = remain;

  if (remain.length) {
    persistOutbox();
  } else {
    try {
      localStorage.removeItem(OUTBOX_KEY);
    } catch (error) {}
  }
};

/* ------------------------------------------------------------
 3. 登录后解析家庭并自动补传
 ------------------------------------------------------------ */

window.cloudAfterLogin =
async function cloudAfterLogin() {
  if (!CLOUD.sb || !CLOUD.session) {
    return;
  }

  try {
    const userId =
      CLOUD.session.user.id;

    const memberResult =
      await CLOUD.sb
        .from('member')
        .select('family_id,role')
        .eq('auth_user_id', userId)
        .limit(1);

    const members =
      memberResult.data || [];

    if (!members.length) {
      CLOUD._needFamily = true;
      CLOUD.familyId = null;
      CLOUD.memberRole = null;
      CLOUD.inviteCode = null;
      CLOUD.familyName = null;
      return;
    }

    CLOUD._needFamily = false;
    CLOUD.familyId =
      members[0].family_id;
    CLOUD.memberRole =
      members[0].role;

    const familyResult =
      await CLOUD.sb
        .from('family')
        .select(
          'invite_code,family_name'
        )
        .eq('id', CLOUD.familyId)
        .limit(1)
        .maybeSingle();

    if (familyResult.data) {
      CLOUD.inviteCode =
        familyResult.data.invite_code;

      CLOUD.familyName =
        familyResult.data.family_name;
    }

    await cloudPullAll();
    cloudSubscribeRealtime();
    await cloudFlushOutbox();

    if (
      typeof updateCloudBadge ===
      'function'
    ) {
      updateCloudBadge();
    }
  } catch (error) {
    console.warn(
      '[v9] cloudAfterLogin 失败',
      error
    );
  }
};

/* ------------------------------------------------------------
 4. 创建家庭：改走 family-setup
 ------------------------------------------------------------ */

window.createFamily =
async function createFamily() {
  if (!CLOUD.sb || !CLOUD.session) {
    setText(
      'fcErr',
      '请先登录家庭邮箱账号'
    );
    return;
  }

  setText('fcErr', '正在创建家庭…');

  try {
    const result =
      await CLOUD.sb.functions.invoke(
        'family-setup',
        {
          body: {
            action: 'create',
            family_name: '我的家庭'
          }
        }
      );

    const data = result.data;
    const error = result.error;

    if (
      error ||
      !data ||
      data.ok !== true
    ) {
      console.error(
        '[v9] 创建家庭失败',
        error || data
      );

      setText(
        'fcErr',
        data && data.error
          ? data.error
          : '创建家庭失败，请重新登录后重试'
      );

      return;
    }

    CLOUD.familyId =
      data.family_id;
    CLOUD.memberRole =
      data.role || 'admin';
    CLOUD._needFamily = false;
    CLOUD.inviteCode =
      data.invite_code || '';
    CLOUD.familyName =
      data.family_name || '我的家庭';

    /*
     * 第一次创建家庭时，把当前本机默认孩子上传云端。
     */
    const rootData = R();

    if (
      rootData &&
      rootData.childData
    ) {
      for (
        const localId of
        Object.keys(rootData.childData)
      ) {
        await cloudPushChild(
          rootData.childData[localId],
          {
            silent: true
          }
        );
      }
    }

    await cloudPullAll();
    cloudSubscribeRealtime();

    closeM('mFamilyChoice');
    updateCloudBadge();

    alert(
      '🎉 家庭创建成功！\n\n' +
      '家庭邀请码：' +
      CLOUD.inviteCode +
      '\n\n请保存邀请码。绑定孩子手机时需要使用。'
    );

    goPinUI(
      AUTH_PENDING_ROLE === 'admin'
        ? '后台管理验证'
        : '家长验证'
    );
  } catch (error) {
    console.error(
      '[v9] createFamily 异常',
      error
    );

    setText(
      'fcErr',
      '创建异常：' +
      (
        error && error.message
          ? error.message
          : '未知错误'
      )
    );
  }
};

/* ------------------------------------------------------------
 5. 加入家庭：改走 family-setup
 ------------------------------------------------------------ */

window.joinFamilyByCode =
async function joinFamilyByCode() {
  if (!CLOUD.sb || !CLOUD.session) {
    setText(
      'fcErr',
      '请先登录家庭邮箱账号'
    );
    return;
  }

  const code =
    gv('fcCode')
      .trim()
      .toUpperCase();

  if (!/^[A-Z2-9]{6}$/.test(code)) {
    setText(
      'fcErr',
      '请输入正确的6位邀请码'
    );
    return;
  }

  setText(
    'fcErr',
    '正在校验邀请码…'
  );

  try {
    const result =
      await CLOUD.sb.functions.invoke(
        'family-setup',
        {
          body: {
            action: 'join',
            invite_code: code
          }
        }
      );

    const data = result.data;
    const error = result.error;

    if (
      error ||
      !data ||
      data.ok !== true
    ) {
      console.error(
        '[v9] 加入家庭失败',
        error || data
      );

      setText(
        'fcErr',
        data && data.error
          ? data.error
          : '加入家庭失败，请检查邀请码'
      );

      return;
    }

    CLOUD.familyId =
      data.family_id;
    CLOUD.memberRole =
      data.role || 'parent';
    CLOUD._needFamily = false;
    CLOUD.inviteCode =
      data.invite_code || code;
    CLOUD.familyName =
      data.family_name || '我的家庭';

    await cloudPullAll();
    cloudSubscribeRealtime();
    await cloudFlushOutbox();

    closeM('mFamilyChoice');
    updateCloudBadge();

    toast(
      '✅ 已加入家庭：' +
      CLOUD.familyName
    );

    goPinUI(
      AUTH_PENDING_ROLE === 'admin'
        ? '后台管理验证'
        : '家长验证'
    );
  } catch (error) {
    console.error(
      '[v9] joinFamilyByCode 异常',
      error
    );

    setText(
      'fcErr',
      '加入异常：' +
      (
        error && error.message
          ? error.message
          : '未知错误'
      )
    );
  }
};

/* ------------------------------------------------------------
 6. 孩子设备首次绑定弹窗
 ------------------------------------------------------------ */

function v9EnsurePairModal() {
  if (
    document.getElementById(
      'v9ChildPair'
    )
  ) {
    return;
  }

  const wrapper =
    document.createElement('div');

  wrapper.className = 'mbg';
  wrapper.id = 'v9ChildPair';

  wrapper.innerHTML =
    '<div class="msh">' +
      '<div class="mhdl"></div>' +
      '<div class="mttl">📲 绑定孩子设备</div>' +

      '<div class="hint" style="margin-top:0;margin-bottom:14px">' +
        '请先由家长创建家庭并保存孩子资料，然后在孩子手机输入家庭邀请码、孩子姓名和孩子PIN。' +
      '</div>' +

      '<div class="fgrp">' +
        '<label class="flbl">6位家庭邀请码</label>' +
        '<input type="text" class="tinp" id="v9PairCode" maxlength="6" placeholder="例如：A3F9K2" style="text-transform:uppercase;letter-spacing:3px;text-align:center;font-size:18px;font-weight:800">' +
      '</div>' +

      '<div class="fgrp">' +
        '<label class="flbl">孩子姓名</label>' +
        '<input type="text" class="tinp" id="v9PairName" placeholder="必须与家长端姓名完全一致">' +
      '</div>' +

      '<div class="fgrp">' +
        '<label class="flbl">孩子PIN（4位数字）</label>' +
        '<input type="password" inputmode="numeric" maxlength="4" class="tinp" id="v9PairPin" placeholder="默认 1234">' +
      '</div>' +

      '<div class="pin-err" id="v9PairErr" style="min-height:20px"></div>' +

      '<button class="btn bp bblock" id="v9PairSubmit" onclick="v9PairChildDevice()">绑定并进入孩子端</button>' +

      '<button class="btn bgray bblock" style="margin-top:8px" onclick="closeM(\'v9ChildPair\')">取消</button>' +
    '</div>';

  document.body.appendChild(wrapper);

  wrapper.addEventListener(
    'click',
    function (event) {
      if (event.target === wrapper) {
        wrapper.classList.remove('open');
      }
    }
  );
}

window.v9OpenChildPair =
function v9OpenChildPair() {
  v9EnsurePairModal();

  sv('v9PairCode', '');
  sv('v9PairName', '');
  sv('v9PairPin', '');
  setText('v9PairErr', '');

  openM('v9ChildPair');
};

/* ------------------------------------------------------------
 7. 执行孩子设备绑定
 ------------------------------------------------------------ */

window.v9PairChildDevice =
async function v9PairChildDevice() {
  if (!CLOUD.sb) {
    setText(
      'v9PairErr',
      '云端尚未就绪，请刷新页面后重试'
    );
    return;
  }

  const inviteCode =
    gv('v9PairCode')
      .trim()
      .toUpperCase();

  const childName =
    gv('v9PairName').trim();

  const pin =
    gv('v9PairPin').trim();

  if (
    !/^[A-Z2-9]{6}$/.test(
      inviteCode
    )
  ) {
    setText(
      'v9PairErr',
      '请输入正确的6位家庭邀请码'
    );
    return;
  }

  if (!childName) {
    setText(
      'v9PairErr',
      '请输入孩子姓名'
    );
    return;
  }

  if (!/^\d{4}$/.test(pin)) {
    setText(
      'v9PairErr',
      '请输入4位数字PIN'
    );
    return;
  }

  setText(
    'v9PairErr',
    '正在验证并绑定…'
  );

  const button =
    document.getElementById(
      'v9PairSubmit'
    );

  if (button) {
    button.disabled = true;
    button.style.opacity = '.55';
  }

  try {
    const result =
      await CLOUD.sb.functions.invoke(
        'child-pair',
        {
          body: {
            invite_code: inviteCode,
            child_name: childName,
            pin: pin
          }
        }
      );

    const data = result.data;
    const error = result.error;

    if (
      error ||
      !data ||
      data.ok !== true ||
      !data.child_id ||
      !data.child_data
    ) {
      console.error(
        '[v9] child-pair 失败',
        error || data
      );

      setText(
        'v9PairErr',
        data && data.error
          ? data.error
          : '绑定失败，请核对邀请码、姓名和PIN'
      );

      return;
    }

    let incoming =
      JSON.parse(
        JSON.stringify(data.child_data)
      );

    incoming =
      migrateChild(incoming);

    /*
     * 云端 JSON 中保留的是本应用本地孩子 ID。
     * 云端 child UUID 单独放在 _cloudId。
     */
    incoming._cloudId =
      data.child_id;

    const oldRoot =
      localGetRoot() || initRoot();

    const pairedRoot = {
      adminCred:
        oldRoot.adminCred ||
        makeCred('8888'),

      parentCred:
        oldRoot.parentCred ||
        makeCred('1234'),

      children: [incoming.id],

      childData: {
        [incoming.id]: incoming
      },

      curChild: incoming.id,

      seq:
        oldRoot.seq || 1
    };

    CACHE = pairedRoot;
    CID = incoming.id;

    CLOUD.childIdMap = {
      [incoming.id]:
        data.child_id
    };

    localSaveRoot(pairedRoot);

    try {
      localStorage.removeItem(
        OUTBOX_KEY
      );
    } catch (error) {}

    CLOUD.outbox = [];

    /*
     * 孩子端不保留家长邮箱 Auth 会话。
     */
    await cloudSignOutQuiet();

    CLOUD.familyId = null;
    CLOUD.inviteCode = null;
    CLOUD.familyName = null;
    CLOUD.memberRole = null;
    CLOUD._needFamily = false;

    REALROLE = 'child';
    ROLE = 'child';
    IMP = false;
    CUR_TAB = 'quest';

    localStorage.setItem(
      ROOT + '_session',
      JSON.stringify({
        realrole: 'child',
        cid: incoming.id
      })
    );

    closeM('v9ChildPair');
    enterApp();

    toast(
      '✅ 孩子设备绑定成功'
    );

    startChildSyncPolling();
  } catch (error) {
    console.error(
      '[v9] 绑定孩子设备异常',
      error
    );

    setText(
      'v9PairErr',
      '绑定异常：' +
      (
        error && error.message
          ? error.message
          : '未知错误'
      )
    );
  } finally {
    if (button) {
      button.disabled = false;
      button.style.opacity = '1';
    }
  }
};

/* ------------------------------------------------------------
 8. 在登录页加入“绑定孩子设备”按钮
 ------------------------------------------------------------ */

function v9InsertPairButton() {
  const roleSelect =
    document.getElementById(
      'roleSelect'
    );

  if (
    !roleSelect ||
    document.getElementById(
      'v9PairButton'
    )
  ) {
    return;
  }

  const button =
    document.createElement('button');

  button.id = 'v9PairButton';
  button.className = 'role-card';

  button.innerHTML =
    '<span class="role-ico">📲</span>' +
    '<span class="role-info">' +
      '<span class="role-t">绑定孩子设备</span>' +
      '<span class="role-d">首次在另一台手机使用时，通过家庭邀请码绑定</span>' +
    '</span>' +
    '<span class="role-arrow">›</span>';

  button.onclick =
    window.v9OpenChildPair;

  roleSelect.appendChild(button);
}

/*
 * 包装原登录页渲染函数，确保每次退出登录后绑定入口仍存在。
 */
if (
  typeof window.renderLogin ===
  'function'
) {
  const v9OriginalRenderLogin =
    window.renderLogin;

  window.renderLogin =
  function renderLoginV9() {
    v9OriginalRenderLogin();

    setTimeout(
      v9InsertPairButton,
      0
    );
  };
}

/*
 * 原 index.html 可能在补丁加载时仍处于异步 init，
 * 因此短时间轮询插入按钮。
 */
let v9PairButtonAttempts = 0;

const v9PairButtonTimer =
  setInterval(function () {
    v9InsertPairButton();
    v9EnsurePairModal();

    v9PairButtonAttempts += 1;

    if (
      document.getElementById(
        'v9PairButton'
      ) ||
      v9PairButtonAttempts >= 40
    ) {
      clearInterval(
        v9PairButtonTimer
      );
    }
  }, 250);

console.info(
  '[成长冒险岛] v9.0.0 云同步补丁已加载'
);
