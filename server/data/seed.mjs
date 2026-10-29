/**
 * seed.mjs — 确定性演示数据（固定随机种子，可复现）
 * ---------------------------------------------------------------------------
 * 刻意植入三类「真实世界脏数据」，让 v1 掩盖的缺陷在演示里暴露出来：
 *   1) **缺日**：3 个 SKU 只隔天落行（真实出库明细零出库日不落行）→ 检验「近 15 个自然日」口径；
 *   2) **数据过期**：2 个 SKU 的库存快照/销量停在 6–8 天前 → 检验新鲜度闸门；
 *   3) **超卖**：1 个 SKU 占用 > 实物（可售为负）→ 检验负可售标记。
 * 另外出库类型分 sale / transfer / delivery 三类，用于演示门店 vs 总部口径差异。
 */

export function todayStr(d = new Date(), timeZone = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

function mulberry32(a) {
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function addDaysStr(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

const STORES = [
  {
    id: 1,
    code: 'SH001',
    name: '上海静安嘉里中心店',
    warehouse_code: 'SH001-WH',
    warehouse_name: '静安前置仓',
    from_warehouse_code: 'HQ-SH',
    from_warehouse_name: '上海中心仓',
    region: '华东',
  },
  {
    id: 2,
    code: 'HZ002',
    name: '杭州西湖湖滨银泰店',
    warehouse_code: 'HZ002-WH',
    warehouse_name: '西湖前置仓',
    from_warehouse_code: 'HQ-HZ',
    from_warehouse_name: '杭州中心仓',
    region: '华东',
  },
];

const SUPPLIERS = [
  { id: 1, code: 'GYS001', name: '伊利华东供应链', lead_time_days: 5 },
  { id: 2, code: 'GYS002', name: '蒙牛华东配送中心', lead_time_days: 6 },
  { id: 3, code: 'GYS003', name: '农夫山泉上海仓', lead_time_days: 4 },
  { id: 4, code: 'GYS004', name: '元气森林长三角仓', lead_time_days: 8 },
  { id: 5, code: 'GYS005', name: '可口可乐申通仓', lead_time_days: 5 },
  { id: 6, code: 'GYS006', name: '本地生鲜集采中心', lead_time_days: 2 },
];

/** base = 日均基准销量（件）；pattern 决定星期分布；trend 为周环比 */
const PRODUCTS = [
  { name: '农夫山泉饮用水', spec: '550ml*24瓶/箱', unit: '箱', category: '饮料', base: 9.5, cost: 22, retail: 36, supplier: 3, pattern: 'flat', trend: 0.01 },
  { name: '东方树叶乌龙茶', spec: '500ml*15瓶/箱', unit: '箱', category: '饮料', base: 5.2, cost: 31, retail: 48, supplier: 3, pattern: 'flat', trend: 0.02 },
  { name: '元气森林气泡水', spec: '480ml*15瓶/箱', unit: '箱', category: '饮料', base: 4.1, cost: 38, retail: 58, supplier: 4, pattern: 'weekend_heavy', trend: 0.015 },
  { name: '可口可乐经典', spec: '330ml*24罐/箱', unit: '箱', category: '饮料', base: 6.8, cost: 26, retail: 42, supplier: 5, pattern: 'weekend_heavy', trend: 0.005 },
  { name: '伊利纯牛奶', spec: '250ml*24盒/箱', unit: '箱', category: '乳制品', base: 7.4, cost: 45, retail: 69, supplier: 1, pattern: 'flat', trend: 0.008 },
  { name: '伊利安慕希酸奶', spec: '205g*12盒/箱', unit: '箱', category: '乳制品', base: 3.6, cost: 52, retail: 79, supplier: 1, pattern: 'weekday_heavy', trend: 0.03 },
  { name: '蒙牛特仑苏', spec: '250ml*12盒/箱', unit: '箱', category: '乳制品', base: 2.8, cost: 58, retail: 88, supplier: 2, pattern: 'flat', trend: 0.012 },
  { name: '光明酸奶', spec: '100g*8杯/组', unit: '组', category: '乳制品', base: 8.6, cost: 12, retail: 19.9, supplier: 1, pattern: 'weekday_heavy', trend: -0.01 },
  { name: '乐事薯片原味', spec: '70g*12袋/箱', unit: '箱', category: '零食', base: 4.9, cost: 48, retail: 72, supplier: 5, pattern: 'weekend_heavy', trend: 0.02 },
  { name: '奥利奥夹心饼干', spec: '97g*12盒/箱', unit: '箱', category: '零食', base: 3.2, cost: 39, retail: 60, supplier: 5, pattern: 'flat', trend: 0.004 },
  { name: '卫龙辣条', spec: '106g*20包/箱', unit: '箱', category: '零食', base: 5.6, cost: 34, retail: 52, supplier: 5, pattern: 'weekend_heavy', trend: 0.025 },
  { name: '三只松鼠每日坚果', spec: '25g*30包/箱', unit: '箱', category: '零食', base: 2.1, cost: 96, retail: 139, supplier: 5, pattern: 'weekend_heavy', trend: 0.04 },
  { name: '金龙鱼调和油', spec: '5L*4桶/箱', unit: '箱', category: '粮油', base: 1.2, cost: 168, retail: 219, supplier: 6, pattern: 'flat', trend: 0.002 },
  { name: '福临门东北大米', spec: '5kg*4袋/箱', unit: '箱', category: '粮油', base: 1.5, cost: 132, retail: 179, supplier: 6, pattern: 'flat', trend: 0.003 },
  { name: '海天生抽', spec: '1.9L*6瓶/箱', unit: '箱', category: '粮油', base: 1.8, cost: 78, retail: 108, supplier: 6, pattern: 'flat', trend: 0.001 },
  { name: '湾仔码头水饺', spec: '720g*12袋/箱', unit: '箱', category: '速冻', base: 3.9, cost: 86, retail: 122, supplier: 6, pattern: 'weekend_heavy', trend: 0.018 },
  { name: '思念汤圆', spec: '500g*12袋/箱', unit: '箱', category: '速冻', base: 2.4, cost: 64, retail: 92, supplier: 6, pattern: 'weekend_heavy', trend: 0.01 },
  { name: '圣农鸡胸肉', spec: '500g*10袋/箱', unit: '箱', category: '速冻', base: 2.9, cost: 98, retail: 138, supplier: 6, pattern: 'weekday_heavy', trend: 0.022 },
  { name: '农夫山泉NFC橙汁', spec: '300ml*12瓶/箱', unit: '箱', category: '饮料', base: 2.2, cost: 68, retail: 96, supplier: 3, pattern: 'flat', trend: 0.035 },
  { name: '元气森林乳茶', spec: '450ml*15瓶/箱', unit: '箱', category: '饮料', base: 3.3, cost: 44, retail: 66, supplier: 4, pattern: 'weekend_heavy', trend: 0.028 },
  { name: '巴黎水气泡水', spec: '330ml*24瓶/箱', unit: '箱', category: '饮料', base: 1.1, cost: 78, retail: 118, supplier: 4, pattern: 'flat', trend: 0.006 },
  { name: '德芙巧克力', spec: '43g*24条/箱', unit: '箱', category: '零食', base: 2.6, cost: 88, retail: 128, supplier: 5, pattern: 'weekend_heavy', trend: 0.05 },
  { name: '旺旺雪饼', spec: '84g*20袋/箱', unit: '箱', category: '零食', base: 3.1, cost: 42, retail: 64, supplier: 5, pattern: 'flat', trend: -0.005 },
  { name: '蒙牛真果粒', spec: '240g*12盒/箱', unit: '箱', category: '乳制品', base: 4.4, cost: 41, retail: 62, supplier: 2, pattern: 'weekday_heavy', trend: 0.014 },
];

const DEAD_PRODUCTS = [
  { name: '旧款气泡水（已下架）', spec: '480ml*15瓶/箱', unit: '箱', category: '饮料', base: 0, cost: 36, retail: 55, supplier: 4, pattern: 'flat', trend: 0 },
  { name: '临期果汁（待处理）', spec: '300ml*12瓶/箱', unit: '箱', category: '饮料', base: 0, cost: 61, retail: 89, supplier: 3, pattern: 'flat', trend: 0 },
];

const PATTERNS = {
  flat: [1, 1, 1, 1, 1, 1, 1],
  weekend_heavy: [0.75, 0.8, 0.82, 0.85, 0.95, 1.3, 1.35], // 周日..周六
  weekday_heavy: [0.7, 1.15, 1.2, 1.18, 1.1, 0.95, 0.85],
};

/** 需要刻意植入门径缺陷的 SKU：按序号挑选，保证稳定 */
const SPARSE_INDEXES = new Set([2, 7, 12]); // 隔天落行（缺日）
const STALE_INDEXES = new Set([5, 18]); // 快照/销量停在 6–8 天前
const OVERSELL_INDEX = 9; // 占用 > 实物（可售为负）

/**
 * @param {{endDate?: string, days?: number, seed?: number}} [opts]
 */
export function buildSeedData(opts = {}) {
  const endDate = opts.endDate ?? todayStr();
  const days = opts.days ?? 90;
  const seed = opts.seed ?? 20261029;
  const rand = mulberry32(seed);
  const startDate = addDaysStr(endDate, -(days - 1));

  /** @type {any[]} */
  const skus = [];
  /** @type {any[]} */
  const inventory = [];
  /** @type {any[]} */
  const sales = [];

  const catalog = [
    ...PRODUCTS.map((p) => ({ ...p, dead: false })),
    ...DEAD_PRODUCTS.map((p) => ({ ...p, dead: true })),
  ];

  let skuId = 0;
  let productIndex = 0;
  for (const product of catalog) {
    for (const store of STORES) {
      skuId += 1;
      productIndex += 1;
      const seq = String(skuId).padStart(4, '0');
      const supplier = SUPPLIERS.find((s) => s.id === product.supplier) ?? SUPPLIERS[0];
      const storeFactor = store.id === 2 ? 0.82 : 1;
      const cost = Number((product.cost * (store.id === 2 ? 1.03 : 1)).toFixed(2));
      const retail = Number((product.retail * (store.id === 2 ? 1.05 : 1)).toFixed(2));
      const taxRate = ['乳制品', '饮料', '零食', '速冻'].includes(product.category) ? 0.13 : 0.09;
      const sparse = SPARSE_INDEXES.has(productIndex % 24);
      const stale = STALE_INDEXES.has(productIndex % 20);

      skus.push({
        id: skuId,
        store_id: store.id,
        code: `SP${store.code}${seq}`,
        sku_no: `${store.code}-${seq}`,
        name: product.name,
        spec: product.spec,
        category: product.category,
        unit: product.unit,
        cost_price: cost,
        retail_price: retail,
        tax_rate: taxRate,
        supplier_id: supplier.id,
        supplier_code: supplier.code,
        supplier_name: supplier.name,
        status: product.dead ? '停售' : '在售',
      });

      const wd = PATTERNS[product.pattern] ?? PATTERNS.flat;
      const avgWd = wd.reduce((a, b) => a + b, 0) / 7;
      const salesCutoff = stale ? addDaysStr(endDate, -8) : endDate;

      for (let d = 0; d < days; d++) {
        const date = addDaysStr(startDate, d);
        if (date > salesCutoff) break;
        // 缺日：隔天落行（模拟"零出库日不落行"）
        if (sparse && d % 3 !== 0) continue;

        const [y, m, dd] = date.split('-').map(Number);
        const weekDay = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
        let qty;
        if (product.dead) {
          qty = 0;
        } else {
          const trendF = Math.pow(1 + product.trend, d / 7);
          const promo = rand() < 0.03 ? 1.8 : 1;
          const noise = 1 + 0.32 * gaussian(rand);
          const raw = product.base * storeFactor * wd[weekDay] * trendF * promo * noise;
          qty = Math.max(0, Math.round(raw));
          if (rand() < 0.04) qty = 0;
        }
        if (qty > 0 || !sparse) {
          sales.push({
            sku_id: skuId,
            date,
            qty,
            outbound_type: 'sale',
            amount: Number((qty * retail * (0.82 + 0.28 * rand())).toFixed(2)),
          });
        }

        // 调拨出库：约 35% 的 SKU，每 7 天一次
        if (!product.dead && skuId % 3 === 0 && d % 7 === 3) {
          sales.push({
            sku_id: skuId,
            date,
            qty: Math.max(1, Math.round(product.base * storeFactor * 0.6)),
            outbound_type: 'transfer',
            amount: 0,
          });
        }
        // 配送出库：仅门店 1 模拟"总部发货"（用于演示总部口径）
        if (!product.dead && store.id === 1 && skuId % 4 === 1 && d % 10 === 6) {
          sales.push({
            sku_id: skuId,
            date,
            qty: Math.max(1, Math.round(product.base * 0.8)),
            outbound_type: 'delivery',
            amount: 0,
          });
        }
      }

      // ---- 库存快照 ----
      const estDaily = product.dead ? 0 : product.base * storeFactor * avgWd * Math.pow(1 + product.trend, 13);
      const bucket = skuId % 10;
      let sellable;
      if (product.dead) sellable = Math.round(60 + rand() * 440);
      else if (bucket === 0) sellable = 0;
      else if (bucket <= 2) sellable = Math.round(estDaily * (0.4 + rand() * 1.6));
      else if (bucket <= 5) sellable = Math.round(estDaily * (4 + rand() * 6));
      else if (bucket <= 8) sellable = Math.round(estDaily * (28 + rand() * 34));
      else sellable = Math.round(estDaily * (110 + rand() * 150));

      let locked = Math.round(Math.max(0, sellable) * (0.02 + rand() * 0.1));
      let onHand = Math.max(0, sellable) + locked;
      if (skuId === OVERSELL_INDEX) {
        onHand = 2;
        locked = 5; // 超卖：可售 = -3
      }
      let inTransit = 0;
      if (!product.dead && rand() < 0.3) {
        inTransit = Math.max(2, Math.round(estDaily * (2 + rand() * 6)));
      }
      const planStock = product.dead ? 0 : Math.round(estDaily * (10 + rand() * 22));

      inventory.push({
        sku_id: skuId,
        on_hand: onHand,
        locked,
        in_transit: inTransit,
        plan_stock: planStock,
        snapshot_date: stale ? addDaysStr(endDate, -6) : endDate,
      });
    }
  }

  const now = `${endDate} 00:00:00`;
  const plans = [
    {
      plan_id: 1,
      plan_name: '按日均销量补货',
      plan_type: 'avg_daily',
      config: { plan_type: 'avg_daily', purchase_cycle_days: 7, coverage_days: 15, coefficient_enabled: 0 },
      creator: '系统',
      created_time: '2023-01-01 00:00:00',
      remark: '系统默认设置',
      is_system: 1,
    },
    {
      plan_id: 2,
      plan_name: '按库存上限补货',
      plan_type: 'stock_upper',
      config: { plan_type: 'stock_upper', purchase_cycle_days: 7, coverage_days: 15, coefficient_enabled: 0 },
      creator: '系统',
      created_time: '2023-01-01 00:00:00',
      remark: '系统默认设置',
      is_system: 1,
    },
    {
      plan_id: 3,
      plan_name: '自定义方案 · 周末节假日加权',
      plan_type: 'custom',
      config: {
        plan_type: 'custom',
        purchase_cycle_days: 7,
        coverage_days: 15,
        coefficient_enabled: 1,
        weekend_coefficient_enabled: 1,
        weekend_coefficient: 1.1,
        holiday_coefficient_enabled: 1,
        holiday_coefficient: 1.2,
      },
      creator: '采购主管',
      created_time: now,
      remark: '周末与大促加权（官方综合系数口径）',
      is_system: 0,
    },
    {
      plan_id: 4,
      plan_name: '按需求波动补货（增强）',
      plan_type: 'sigma',
      config: {
        plan_type: 'sigma',
        purchase_cycle_days: 7,
        coverage_days: 10,
        lead_time_days: 5,
        service_level: 0.95,
        safety_days: 3,
        forecast_window: 14,
        seasonality: 1,
        trend_damping: 0.5,
        pack_size: 6,
        moq: 12,
        coefficient_enabled: 0,
      },
      creator: '算法',
      created_time: now,
      remark: '[增强] σ 服务水平法，非有赞口径',
      is_system: 0,
    },
  ];

  const holidays = [
    { date: '2026-11-11', name: '双十一大促（示例：按重大节假日系数处理）' },
    { date: '2027-01-01', name: '元旦' },
    { date: addDaysStr(endDate, 12), name: '示例大促日（数据日期 +12 天）' },
  ];

  const schedules = [
    {
      id: 'sched-daily-0900',
      name: '每日巡店补货（09:00）',
      cadence: 'daily@09:00',
      plan_id: 1,
      store_id: null,
      enabled: 1,
      next_run_at: `${addDaysStr(endDate, 1)}T09:00:00+08:00`,
    },
    {
      id: 'sched-every-6h',
      name: '每 6 小时快扫（含系数方案）',
      cadence: 'every:6h',
      plan_id: 3,
      store_id: 1,
      enabled: 1,
      next_run_at: `${endDate}T12:00:00+08:00`,
    },
  ];

  return {
    endDate,
    stores: STORES,
    suppliers: SUPPLIERS,
    skus,
    inventory,
    sales,
    plans,
    safetyConfig: { mode: 'dynamic', lower_fixed: 10, upper_fixed: 100, min_sellable_days: 7, max_sellable_days: 30 },
    holidays,
    schedules,
    dataQuality: {
      sparse_sku_indexes: [...SPARSE_INDEXES],
      stale_sku_indexes: [...STALE_INDEXES],
      oversell_sku_index: OVERSELL_INDEX,
    },
  };
}
