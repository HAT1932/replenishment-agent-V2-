/**
 * assumptions.mjs — 假设登记表（H1–H8）
 * ---------------------------------------------------------------------------
 * 来源：`E:\Claude_PRD\notes\evidence-audit.md` §6.2（v1 证据链审计）。
 * 每一条都是「产品事实」与「工程推断」之间的缝隙；Suggestion.assumptions 必须引用这里的 id，
 * 前端 Citation strip 与 `#/assumptions` 页面直接消费本表。
 *
 * 纪律：**未经新证据推翻前，任何依赖该假设的结论都不得标 documented。**
 */

export const ASSUMPTIONS = Object.freeze([
  {
    id: 'H1',
    statement: '建议数量 = ceil(公式值)（向上取整，保证不断货方向）',
    confidence: 'medium',
    evidence: '截图 06 四行数据反算：0.067×7+10−1=9.469 → 输出 10，排除 floor/round（单点证据）',
    risk: '若可售天数实为 8，则 9.536 会让 round 同样成立；显示值 0.067 已舍入，判别力进一步下降',
    probe: '用可控商品（库存与近15天销量已知）在真实后台生成一次建议，反算取整方向',
  },
  {
    id: 'H2',
    statement: '日均销量的统计窗口 = 近 15 个自然日（含零销量日，缺日补 0）',
    confidence: 'medium',
    evidence: '教程正文「近 15 天」；帮助中心同款弹窗文案曾出现「近 16 天」',
    risk: '若为闭区间 T-15…T（16 个点），日均偏差约 6.7%，建议量同比例偏移',
    probe: '在后台看两款 SKU 的日均销量，用已知 15/16 天出库量反算口径',
  },
  {
    id: 'H3',
    statement: '综合系数窗口 = [预计到货日, 预计到货日 + 采购周期 − 1]（闭区间）',
    confidence: 'medium',
    evidence: '官方算例：12/5 到货、周期 5 天覆盖 12/5–12/9，分母为 5',
    risk: '文档文字表述是"到下一次补货发起时间"，与算例相差 1 天；窗口多一天 → 系数偏离 1/5 权重',
    probe: '设置周期 5 天、单日双休日系数 2，观察系数是否为 1.2 而不是 1.1667',
  },
  {
    id: 'H4',
    statement: '低库存预警判定 = (实物库存 + 在途库存) < 库存预警下限',
    confidence: 'medium',
    evidence: '教程正文（22065）与「采购订单为什么没有补货建议」（73351）两篇 A 级文档',
    risk: '另一篇官方文档（安全库存使用教程 42123）用的是「实时库存 < 下限」；两篇冲突，直接影响全量 SKU 是否产出建议',
    probe: '构造"实物 0 + 在途 100、下限 10"的商品，看后台是否显示低预警',
    policy_note: '本实现把口径做成显式 policy（physical_plus_transit | realtime），默认取文档正文口径',
  },
  {
    id: 'H5',
    statement: '动态预警上下限 = ceil(可售天数 × 日均销量)',
    confidence: 'low',
    evidence: '官方只给乘法公式，未说明取整',
    risk: '取整方向影响闸门（上限/下限差 1 件可能导致某 SKU 进/出建议）',
    probe: '设可售天数 7、日均 0.067，看后台下限显示 0 还是 1',
  },
  {
    id: 'H6',
    statement: '「按库存上限补货」里的「当前实物库存」= 实物库存（不减占用、不减在途）',
    confidence: 'medium',
    evidence: '教程仅五字表述，无算例',
    risk: '若线上用可售库存，则高占用商品的建议量会偏大',
    probe: '取一个高占用商品，看建议数量 = 上限 − 实物 还是 上限 − 可售',
  },
  {
    id: 'H7',
    statement: '日均销量分母含零销量日、不冲减退货/取消',
    confidence: 'medium',
    evidence: 'v1 实现与单测的工程选择；官方未定义',
    risk: '若后台按"有销量日"求均值，低频商品日均销量会被显著高估',
    probe: '取一个 15 天内仅 3 天有销量的 SKU，反算分母是 15 还是 3',
  },
  {
    id: 'H8',
    statement: '建议数量 ≤ 0 时不展示该行',
    confidence: 'low',
    evidence: '纯工程推断（v1 行为）',
    risk: '若线上展示 0/负值行，则本实现会"少显示"部分商品',
    probe: '构造库存充足商品，看补货建议列表是否出现该行',
  },
  {
    id: 'H9',
    statement: '补货建议能力没有开放平台接口，只能 UI/RPA 或自行重实现',
    confidence: 'high',
    evidence: '有赞云 81 个接口 + 56 条消息中无「补货建议/备货计划」能力（v1 证据链审计复核）',
    risk: '若存在未公开接口，集成路径可缩短；但当前不能假设其存在',
    probe: '在有赞云控制台按 replenish/suggest/备货 关键词检索',
  },
  {
    id: 'H10',
    statement: 'σ 方案（服务水平法安全库存）属于本实现增强，不是有赞行为',
    confidence: 'high',
    evidence: 'v1 README 与报告均以 [增强] 标注；官方文档无此口径',
    risk: '无（只要不标 documented）',
    probe: '无需验证；保持 provenance=enhancement',
  },
]);

export const ASSUMPTION_INDEX = Object.freeze(
  Object.fromEntries(ASSUMPTIONS.map((a) => [a.id, a])),
);

export function getAssumption(id) {
  return ASSUMPTION_INDEX[id] ?? null;
}

/** 给 UI/工具用的精简投影 */
export function listAssumptions() {
  return ASSUMPTIONS.map((a) => ({ ...a }));
}
