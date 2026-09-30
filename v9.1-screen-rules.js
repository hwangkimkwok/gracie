'use strict';

/* ============================================================
 成长冒险岛 v9.1 屏幕与阅读规则补丁

 1. 家长确认阅读后自动折算屏幕存折
 2. 不再进入“可兑换阅读余额”
 3. 屏幕时间依次使用：
    免费时间 → 今日运动时间 → 跨天屏幕存折
 4. 免费时间只消耗当日免费额度，不扣存折
 ============================================================ */

window.GRACIE_V91_SCREEN_RULES = true;

/* 保存原始函数，供补丁内部复用 */
const V91_ORIGINAL_DD = window.dd;
const V91_ORIGINAL_RENDER = window.render;

/* ------------------------------------------------------------
 一、补充每日数据字段
 ------------------------------------------------------------ */

window.dd = function ddV91(c, key) {
  const day = V91_ORIGINAL_DD(c, key);

  if (day.freeUsed === undefined) {
    day.freeUsed = 0;
  }

  if (day.bankUsed === undefined) {
    day.bankUsed = 0;
  }

  if (day.jUsed === undefined) {
    day.jUsed = 0;
  }

  return day;
};

/* ------------------------------------------------------------
 二、周五、周末免费额度
 ------------------------------------------------------------ */

function v91ConfiguredFreeTotal(c) {
  const dow = sgtDow();
  const cfg = c.cfg || {};

  if (dow === 5) {
    return Math.max(
      0,
      Number(cfg.freeDisplayFriday) || 0
    );
  }

  if (dow === 6) {
    return Math.max(
      0,
      Number(cfg.freeDisplaySaturday) || 0
    );
  }

  if (dow === 0) {
    return Math.max(
      0,
      Number(cfg.freeDisplaySunday) || 0
    );
  }

  return 0;
}

window.displayFreeMin = function displayFreeMinV91(c) {
  const day = dd(c);
  const total = v91ConfiguredFreeTotal(c);
  const used = Math.max(
    0,
    Number(day.freeUsed) || 0
  );

  return Math.max(0, total - used);
};

window.freeDisplayText = function freeDisplayTextV91(c) {
  const remain = displayFreeMin(c);

  if (remain <= 0) {
    return '';
  }

  return (
    '今日免费剩余：' +
    remain +
    '分钟，使用时优先抵扣，不扣屏幕存折'
  );
};

/* ------------------------------------------------------------
 三、实际可用时间
 ------------------------------------------------------------ */

window.availMin = function availMinV91(c) {
  const day = dd(c);

  if (day.rl) {
    return 0;
  }

  return (
    displayFreeMin(c) +
    sportRemain(c) +
    Math.max(0, Number(c.bank) || 0)
  );
};

/* ------------------------------------------------------------
 四、使用屏幕时间时的扣减顺序
 ------------------------------------------------------------ */

window.consumeScreenTime =
function consumeScreenTimeV91(c, minutes) {
  const day = dd(c);

  let left = Math.max(
    0,
    Math.round(Number(minutes) || 0)
  );

  const requested = left;

  /*
   * 1. 优先使用周五、周末免费额度
   */
  const freeAvailable =
    displayFreeMin(c);

  const freeUsed =
    Math.min(left, freeAvailable);

  day.freeUsed =
    (Number(day.freeUsed) || 0) +
    freeUsed;

  left -= freeUsed;

  /*
   * 2. 再使用今日运动时间
   */
  const sportAvailable =
    sportRemain(c);

  const sportUsed =
    Math.min(left, sportAvailable);

  day.jUsed =
    (Number(day.jUsed) || 0) +
    sportUsed;

  left -= sportUsed;

  /*
   * 3. 最后扣跨天屏幕存折
   */
  const bankAvailable =
    Math.max(0, Number(c.bank) || 0);

  const bankUsed =
    Math.min(left, bankAvailable);

  c.bank = Math.max(
    0,
    bankAvailable - bankUsed
  );

  day.bankUsed =
    (Number(day.bankUsed) || 0) +
    bankUsed;

  left -= bankUsed;

  return {
    requested,
    freeUsed,
    sportUsed,
    bankUsed,
    insufficient: left
  };
};

/* ------------------------------------------------------------
 五、屏幕存折流水
 ------------------------------------------------------------ */

window.addScreenLedger =
function addScreenLedgerV91(
  c,
  type,
  change,
  remark,
  extra
) {
  const detail = extra || {};

  if (!Array.isArray(c.screenLedger)) {
    c.screenLedger = [];
  }

  c.screenLedger.unshift({
    id: uid(),
    ts: nowISO(),
    type: type,
    change: Number(change) || 0,
    freeUsed:
      Number(detail.freeUsed) || 0,
    sportUsed:
      Number(detail.sportUsed) || 0,
    bankUsed:
      Number(detail.bankUsed) || 0,
    readingMinutes:
      Number(detail.readingMinutes) || 0,
    remark: remark || '',
    balanceAfter:
      Math.max(0, Number(c.bank) || 0)
  });

  if (c.screenLedger.length > 500) {
    c.screenLedger.length = 500;
  }
};

/* ------------------------------------------------------------
 六、记录屏幕使用
 ------------------------------------------------------------ */

window.addScr = function addScrV91(minutes) {
  const r = R();
  const c = child(r);

  const amount = Math.max(
    0,
    Math.round(Number(minutes) || 0)
  );

  if (amount <= 0) {
    return;
  }

  if (amount > availMin(c)) {
    toast(
      '可用时间不足：免费、运动和屏幕存折合计不足'
    );
    return;
  }

  const day = dd(c);
  const used = consumeScreenTime(c, amount);

  day.scrUsed =
    (Number(day.scrUsed) || 0) +
    amount;

  const parts = [];

  if (used.freeUsed > 0) {
    parts.push(
      '免费' + used.freeUsed + '分钟'
    );
  }

  if (used.sportUsed > 0) {
    parts.push(
      '运动' + used.sportUsed + '分钟'
    );
  }

  if (used.bankUsed > 0) {
    parts.push(
      '存折' + used.bankUsed + '分钟'
    );
  }

  addScreenLedger(
    c,
    'screen_use',
    -used.bankUsed,
    '使用屏幕：' + parts.join('，'),
    used
  );

  saveChild(r, c);
  render();

  toast(
    '📱 已记录' +
    amount +
    '分钟（' +
    parts.join('，') +
    '）'
  );
};

/* ------------------------------------------------------------
 七、重置今日屏幕记录
 ------------------------------------------------------------ */

window.resetScr = function resetScrV91() {
  if (!reqP()) {
    return;
  }

  if (
    !confirm(
      '确定重置今日屏幕使用记录？免费、运动和存折使用来源将一并恢复。'
    )
  ) {
    return;
  }

  const r = R();
  const c = child(r);
  const day = dd(c);

  const restoredBank =
    Number(day.bankUsed) || 0;

  c.bank =
    Math.max(0, Number(c.bank) || 0) +
    restoredBank;

  day.freeUsed = 0;
  day.jUsed = 0;
  day.bankUsed = 0;
  day.scrUsed = 0;

  addScreenLedger(
    c,
    'correction',
    restoredBank,
    '重置今日屏幕记录并恢复免费、运动和存折来源',
    {
      freeUsed: 0,
      sportUsed: 0,
      bankUsed: 0
    }
  );

  saveChild(r, c);
  render();

  toast(
    '✅ 已重置今日屏幕记录并恢复额度'
  );
};

/* ------------------------------------------------------------
 八、家长确认阅读后自动折算
 ------------------------------------------------------------ */

window.doReadingGrant =
function doReadingGrantV91(c, minutes) {
  const amount = Math.max(
    0,
    Math.floor(Number(minutes) || 0)
  );

  if (amount < 30) {
    return;
  }

  const sessions =
    Math.floor(amount / 30);

  const day = dd(c);

  day.rdMins =
    (Number(day.rdMins) || 0) +
    amount;

  day.read =
    (Number(day.read) || 0) +
    amount;

  c.lifetimeRead =
    (Number(c.lifetimeRead) || 0) +
    amount;

  /*
   * 普通日期：
   * 阅读30分钟 = 屏幕存折10分钟
   *
   * 假期：
   * 阅读30分钟 = 屏幕存折15分钟
   */
  const screenPerSession =
    isHoliday(c) ? 15 : 10;

  const screenMinutes =
    sessions * screenPerSession;

  c.bank =
    Math.max(0, Number(c.bank) || 0) +
    screenMinutes;

  day.bankAdded =
    (Number(day.bankAdded) || 0) +
    screenMinutes;

  /*
   * 新规则不再进入“可兑换阅读余额”。
   */
  if (
    c.readExchangeBalance === undefined
  ) {
    c.readExchangeBalance = 0;
  }

  const stars = sessions * 2;

  if (stars > 0) {
    addStar(
      c,
      stars,
      'task',
      '阅读' + amount + '分钟'
    );
  }

  addScreenLedger(
    c,
    'reading_auto',
    screenMinutes,
    '阅读' +
      amount +
      '分钟自动折算屏幕存折 +' +
      screenMinutes +
      '分钟',
    {
      readingMinutes: amount
    }
  );

  notify(
    c,
    'child',
    '📖 阅读已确认：' +
      amount +
      '分钟，+' +
      stars +
      '★，屏幕存折+' +
      screenMinutes +
      '分钟'
  );
};

/* ------------------------------------------------------------
 九、停用旧的二次阅读兑换入口
 ------------------------------------------------------------ */

window.submitReadingExchange =
function submitReadingExchangeV91() {
  toast(
    '阅读已改为家长确认后自动折算，无需再次提交兑换'
  );
};

/* ------------------------------------------------------------
 十、旧“可兑换阅读余额”一次性迁移
 ------------------------------------------------------------ */

let V91_MIGRATION_RUNNING = false;

async function v91MigrateLegacyReadingBalance() {
  if (V91_MIGRATION_RUNNING) {
    return;
  }

  if (
    typeof isParentAuth !== 'function' ||
    !isParentAuth() ||
    !ROLE
  ) {
    return;
  }

  let r;
  let c;

  try {
    r = R();
    c = child(r);
  } catch (error) {
    return;
  }

  const oldBalance =
    Math.max(
      0,
      Math.floor(
        Number(c.readExchangeBalance) || 0
      )
    );

  const sessions =
    Math.floor(oldBalance / 30);

  if (sessions <= 0) {
    return;
  }

  V91_MIGRATION_RUNNING = true;

  try {
    const convertedReading =
      sessions * 30;

    const screenPerSession =
      isHoliday(c) ? 15 : 10;

    const screenMinutes =
      sessions * screenPerSession;

    c.readExchangeBalance =
      oldBalance - convertedReading;

    c.bank =
      Math.max(0, Number(c.bank) || 0) +
      screenMinutes;

    addScreenLedger(
      c,
      'legacy_migration',
      screenMinutes,
      '旧可兑换阅读' +
        convertedReading +
        '分钟迁移为屏幕存折 +' +
        screenMinutes +
        '分钟',
      {
        readingMinutes:
          convertedReading
      }
    );

    saveChild(r, c);

    toast(
      '✅ 旧可兑换阅读已自动转入屏幕存折 +' +
      screenMinutes +
      '分钟'
    );
  } catch (error) {
    console.error(
      '[v9.1] 旧阅读余额迁移失败',
      error
    );
  } finally {
    V91_MIGRATION_RUNNING = false;
  }
}

/* ------------------------------------------------------------
 十一、修正页面文案和旧入口显示
 ------------------------------------------------------------ */

function v91RefreshScreenText() {
  if (!ROLE) {
    return;
  }

  let c;

  try {
    c = child(R());
  } catch (error) {
    return;
  }

  /*
   * 把旧的“仅提示、不参与计算”文案改为实际抵扣规则。
   */
  document
    .querySelectorAll(
      '.hint, .scrdtl, .tv-sub, .money-lbl'
    )
    .forEach(function (element) {
      if (
        element.textContent.includes(
          '仅作家庭规则提示'
        ) ||
        element.textContent.includes(
          '仅展示，不计入'
        )
      ) {
        element.textContent =
          '免费时间使用时优先抵扣，不扣今日运动时间或跨天屏幕存折。';
      }
    });

  /*
   * 隐藏孩子端旧“阅读兑换屏幕”卡片。
   */
  document
    .querySelectorAll('.card')
    .forEach(function (card) {
      const title =
        card.querySelector('.ctitle');

      if (
        ROLE === 'child' &&
        title &&
        title.textContent.includes(
          '阅读兑换屏幕'
        )
      ) {
        card.style.display = 'none';
      }
    });

  /*
   * 家长屏幕页原“可兑换阅读”统计改为“今日免费剩余”。
   */
  if (
    ROLE === 'parent' &&
    CUR_TAB === 'screen'
  ) {
    document
      .querySelectorAll('.sci')
      .forEach(function (item) {
        const label =
          item.querySelector('.scil');

        const value =
          item.querySelector('.scin');

        if (
          label &&
          label.textContent.trim() ===
            '可兑换阅读'
        ) {
          label.textContent =
            '今日免费剩余';

          if (value) {
            value.textContent =
              displayFreeMin(c);
          }
        }
      });
  }
}

/*
 * 包装 render，让每次页面刷新后修正文案。
 */
window.render = function renderV91() {
  V91_ORIGINAL_RENDER();

  setTimeout(function () {
    v91RefreshScreenText();
    v91MigrateLegacyReadingBalance();
  }, 0);
};

/*
 * 补丁加载时也尝试处理一次。
 */
setTimeout(function () {
  v91RefreshScreenText();
  v91MigrateLegacyReadingBalance();
}, 800);

console.info(
  '[成长冒险岛] v9.1 屏幕与阅读规则补丁已加载'
);
