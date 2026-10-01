'use strict';

/**
 * 中文财经文本「利好 / 利空」规则引擎。
 *
 * 说明：这是可解释的词典 + 修饰词加权模型，不是大模型推理。
 * 优点是可复现、可审计、离线可用；局限是只认显式措辞，
 * 反讽与隐性利好（例如「不及预期但环比转正」）会偏保守。
 */

// 权重：3 强信号，2 明确信号，1 弱信号
const BULLISH = {
  '涨停': 3, '大涨': 3, '暴涨': 3, '飙升': 3, '涨停板': 3, '创历史新高': 3,
  '中标': 3, '大额订单': 3, '签订合同': 2, '订单': 1, '中选': 2, '战略合作': 2, '合作': 1,
  '回购': 3, '增持': 3, '举牌': 2, '股权激励': 2,
  '预增': 3, '扭亏': 3, '业绩增长': 3, '利润增长': 2, '订单增长': 2, '净利润增长': 3, '业绩预增': 3, '同比增长': 2, '营收增长': 2,
  '超预期': 3, '好于预期': 2, '高增长': 2, '创纪录': 2, '净利润大增': 3, '盈利': 1,
  '重组': 2, '资产注入': 3, '并购': 2, '收购': 2, '借壳': 2, '混改': 2,
  '提价': 3, '涨价': 3, '价格上调': 3, '供不应求': 3, '需求旺盛': 3, '订单饱满': 3,
  '库存下降': 3, '库存去化': 2, '减产': 2, '限产': 2, '停产整顿': 2,
  '政策支持': 2, '补贴': 2, '税收优惠': 2, '获批': 2, '核准': 2, '试点': 2, '纳入': 2,
  '分红': 2, '高股息': 2, '派息': 2,
  '利好': 2, '受益': 2, '龙头': 2, '放量上涨': 2, '连续上涨': 2, '反弹': 1, '回暖': 2,
  '产能释放': 1, '涨价函': 3, '出口增长': 2, '涨价预期': 2,
  '买入评级': 2, '上调评级': 2, '上调目标价': 2, '北向资金净买入': 2, '主力净流入': 2
};

const BEARISH = {
  '跌停': 3, '大跌': 3, '暴跌': 3, '闪崩': 3, '重挫': 3, '创年内新低': 3, '破位': 2,
  '亏损': 3, '预亏': 3, '巨亏': 3, '净利润下降': 3, '营收下降': 2, '同比下滑': 3, '业绩下滑': 3,
  '亏损扩大': 3, '不及预期': 3, '低于预期': 3, '下滑': 2, '减少': 1, '萎缩': 2, '下降': 1,
  '减持': 3, '清仓减持': 3, '质押': 2, '高比例质押': 3, '解禁': 2, '限售股解禁': 2,
  '退市': 3, '退市风险': 3, '立案': 3, '立案调查': 3, '调查': 2, '处罚': 3, '罚款': 2,
  '违规': 3, '被警示': 2, '问询函': 2, '监管函': 2, '关注函': 1, '通报批评': 2,
  '商誉减值': 3, '计提减值': 3, '资产减值': 3, '坏账': 3, '存货跌价': 3,
  '终止': 3, '终止重组': 3, '终止合作': 2, '取消订单': 3, '诉讼': 2, '仲裁': 2,
  '债务违约': 3, '逾期': 3, '资金链': 3, '破产': 3, '重整': 2, '停牌': 2,
  '利空': 2, '承压': 2, '风险提示': 2, '停产': 2, '事故': 3, '召回': 3,
  '降价': 2, '价格下跌': 3, '下调': 2, '下调评级': 3, '下调目标价': 3, '卖出评级': 3,
  '库存增加': 3, '库存高企': 3, '累库': 3, '产能过剩': 3, '需求疲软': 3, '需求走弱': 3,
  '裁员': 2, '停工': 2, '现金流紧张': 3, '违约': 3, '冻结': 3
};

const INTENSIFIER = ['大幅', '显著', '暴', '巨', '远超', '翻倍', '超预期'];
const NEGATORS = ['不', '未', '无', '没有', '不再', '尚未', '难以', '无法'];

const ALL_TERMS = Object.keys(BULLISH).concat(Object.keys(BEARISH)).sort((a, b) => b.length - a.length);

function polarityOf(term) {
  if (BULLISH[term] !== undefined) return 1;
  if (BEARISH[term] !== undefined) return -1;
  return 0;
}

function weightOf(term) {
  if (BULLISH[term] !== undefined) return BULLISH[term];
  if (BEARISH[term] !== undefined) return BEARISH[term];
  return 0;
}

function labelOf(score) {
  if (score >= 45) return '强烈偏多';
  if (score >= 15) return '偏多';
  if (score > -15) return '中性';
  if (score > -45) return '偏空';
  return '强烈偏空';
}

/**
 * 分析一段中文财经文本。
 * @returns {{score:number,label:string,hits:Array,positive:number,negative:number}}
 *   score 为 -100..100 的归一化情绪分。
 */
function analyze(text) {
  const src = String(text || '');
  const hits = [];
  const seen = new Set();
  let raw = 0;

  for (const term of ALL_TERMS) {
    let idx = src.indexOf(term);
    while (idx >= 0) {
      const key = term + '@' + idx;
      if (!seen.has(key)) {
        seen.add(key);
        const window = src.slice(Math.max(0, idx - 12), idx);
        const negated = NEGATORS.some((n) => window.endsWith(n));
        const intensified = INTENSIFIER.some((w) => window.indexOf(w) >= 0);
        const weight = weightOf(term) * (intensified ? 1.5 : 1);
        const polarity = polarityOf(term) * (negated ? -1 : 1);
        raw += polarity * weight;
        hits.push({
          term: term,
          polarity: polarity > 0 ? 'bullish' : 'bearish',
          weight: Number(weight.toFixed(1)),
          negated: negated,
          index: idx
        });
      }
      idx = src.indexOf(term, idx + term.length);
    }
  }

  const positive = hits.filter((h) => h.polarity === 'bullish').length;
  const negative = hits.filter((h) => h.polarity === 'bearish').length;
  // 归一化：单条文本出现约 4 个强信号基本顶格
  const score = Math.max(-100, Math.min(100, Math.round((raw / 12) * 100)));

  return { score: score, label: labelOf(score), hits: hits, positive: positive, negative: negative };
}

/** 聚合多条带情绪分的条目（例如某只股票的全部新闻），按时间衰减加权。 */
function aggregate(items, options) {
  const decayHours = (options && options.decayHours) || 72;
  const now = Date.now();
  let weighted = 0;
  let weightSum = 0;
  let positive = 0;
  let negative = 0;
  const termCount = new Map();

  for (const item of items) {
    const s = item.sentiment;
    if (!s) continue;
    if (s.positive) positive += s.positive;
    if (s.negative) negative += s.negative;
    for (const h of s.hits || []) termCount.set(h.term, (termCount.get(h.term) || 0) + 1);

    const ts = item.timestamp ? new Date(item.timestamp).getTime() : now;
    const ageHours = Number.isFinite(ts) ? Math.max(0, (now - ts) / 3600000) : 0;
    const decay = Math.exp(-ageHours / decayHours);
    weighted += s.score * decay;
    weightSum += decay;
  }

  const score = weightSum > 0 ? Math.round(weighted / weightSum) : 0;
  const topTerms = Array.from(termCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([term, count]) => ({ term: term, count: count, polarity: polarityOf(term) > 0 ? 'bullish' : 'bearish' }));

  return {
    score: score,
    label: labelOf(score),
    positive: positive,
    negative: negative,
    sampleSize: items.length,
    topTerms: topTerms
  };
}

module.exports = { analyze: analyze, aggregate: aggregate, labelOf: labelOf, BULLISH: BULLISH, BEARISH: BEARISH };
