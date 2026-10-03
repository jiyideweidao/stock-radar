'use strict';

/**
 * 本地多智能体研判引擎（自研，**不调用任何大模型**）。
 *
 * 编排结构参照 TradingAgents 那一类「分析师团队 -> 多空研究员辩论 -> 交易员 -> 风控」
 * 的经典多智能体范式（编排思路属于通用工程范式），但这里每个角色的结论都由
 * 本机已有的真实数据 + 明写规则推导，因此：离线可用、结果可复现、每条结论可追溯到数值。
 *
 * 与「个股体检」的分工：
 *   - 个股体检：逐条对照知识库规则，回答「是否满足你自己写下的规则」；
 *   - 智能体研判：让不同视角各自成文，再把多空两方的论据摆在一起做一次辩论，
 *     最后交给交易员与风控各出一份结论。视角更全，但同样不构成买卖建议。
 *
 * 所有角色输出统一结构：
 *   { id, name, role, avatar, stance, confidence, summary, findings[], note? }
 *   stance: 'bull' | 'bear' | 'neutral'
 *   findings[]: { label, value, note, stance, weight }
 */

const quotes = require('../sources/quotes');
const ths = require('../sources/ths');
const market = require('../sources/market');
const news = require('../sources/news');
const guba = require('../sources/guba');
const futures = require('../sources/futures');
const coal = require('../sources/coal');
const indicators = require('./indicators');

/**
 * 个股 -> 产业链。用于把「股价」和「它所在的商品产业链」接上：
 * 煤炭股的煤价、棉花股（如新赛股份）的郑棉，都是这类公司利润的直接上游。
 * 关键字是「按名称匹配」的兜底方案，用户也可以在调用时用 industry 显式指定。
 */
const INDUSTRY_CHAIN = [
  { id: 'coal', name: '煤炭', keywords: ['煤', '焦', '动力煤', '焦炭'], symbols: ['JM0', 'J0', 'ZC0'],
    note: '焦煤/焦炭/动力煤主连' },
  { id: 'cotton', name: '棉花纺织', keywords: ['棉', '纱', '纺织', '服装', '巾', '纺'], symbols: ['CF0', 'CY0'],
    note: '郑棉/棉纱主连' },
  { id: 'steel', name: '钢铁', keywords: ['钢', '冶', '轧', '特钢'], symbols: ['RB0', 'I0'],
    note: '螺纹钢/铁矿石主连' },
  { id: 'nonferrous', name: '有色', keywords: ['铜', '铝', '锌', '镍', '钨', '钼', '黄金', '金矿', '有色'], symbols: ['CU0', 'AL0', 'AU0'],
    note: '沪铜/沪铝/沪金主连' },
  { id: 'energy', name: '能源化工', keywords: ['油', '石化', '化工', '燃气', '甲醇', '烯'], symbols: ['SC0', 'TA0', 'MA0'],
    note: '原油/PTA/甲醇主连' },
  { id: 'agri', name: '农业', keywords: ['糖', '蔗', '橡胶', '豆', '饲料', '养殖', '种业', '种植', '农', '林', '牧', '渔', '粮'], symbols: ['SR0', 'M0', 'RU0'],
    note: '白糖/豆粕/橡胶主连' },
  { id: 'building', name: '建材', keywords: ['水泥', '玻璃', '纯碱', '建材'], symbols: ['FG0', 'SA0'],
    note: '玻璃/纯碱主连' }
];

/**
 * 少数「看行业和概念都猜不出来」的个股，人工核对主营后写死在这里。
 * 例：新赛股份（600540）的东财行业是「种植业」、概念里也没有「棉」字，
 *     但它的主营就是棉花种植与加工，郑棉价格直接决定它的利润弹性。
 * 这张表只收「主营单一、指向明确」的标的，拿不准的宁可不写（不猜）。
 */
const CHAIN_OVERRIDE = {
  '600540': 'cotton'   // 新赛股份：棉花种植与加工
};

/**
 * 匹配所属产业链，匹配不到返回 null（不硬凑）。
 * 顺序很关键：行业 > 股票名称 > 概念板块。
 *   行业最可靠；名称次之；概念板块最杂（「铜缆高速连接」会把科技股误判成有色），
 *   所以概念放在最后兜底，宁可漏判也不要错判。
 */
function matchChain(name, profile) {
  const p = profile || {};
  if (p.code && CHAIN_OVERRIDE[p.code]) {
    return INDUSTRY_CHAIN.find((c) => c.id === CHAIN_OVERRIDE[p.code]) || null;
  }
  const stages = [
    String(p.industry || ''),
    String(name || ''),
    (p.concepts || []).join(' ')
  ];
  for (const text of stages) {
    if (!text) continue;
    for (const chain of INDUSTRY_CHAIN) {
      for (const kw of chain.keywords) {
        if (text.indexOf(kw) >= 0) return chain;
      }
    }
  }
  return null;
}

const round = (v, d) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, d === undefined ? 2 : d);
  return Math.round(n * f) / f;
};
const numOr = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? null : fallback);
};

/** 一条论据：label 是指标名，value 是数值（必须来自真实数据），note 说明它意味着什么。 */
function finding(label, value, note, stance, weight) {
  return {
    label: label,
    value: value,
    note: note,
    stance: stance === 'bull' || stance === 'bear' ? stance : 'neutral',
    weight: Number.isFinite(Number(weight)) ? Number(weight) : 1
  };
}

/** 把一组论据折算成 -100 ~ 100 的多空倾向，同时给出参与计权的论据条数。 */
function tally(findings) {
  let score = 0;
  let max = 0;
  let sided = 0;
  for (const f of findings) {
    const w = f.weight;
    max += w;
    if (f.stance === 'bull') { score += w; sided++; }
    else if (f.stance === 'bear') { score -= w; sided++; }
  }
  const pct = max ? Math.round((score / max) * 100) : 0;
  return { pct: pct, sided: sided, total: findings.length };
}

function stanceOf(pct) {
  if (pct >= 20) return 'bull';
  if (pct <= -20) return 'bear';
  return 'neutral';
}

const STANCE_TEXT = { bull: '偏多', bear: '偏空', neutral: '中性' };

/**
 * 置信度分两层：先看倾向有多强，再看有没有足够多的论据支撑。
 * 只有一两条论据时不允许给出高置信度——数据不足时的「果断」是假果断。
 */
function confidenceOf(pct, sided) {
  if (sided < 3) return Math.min(40, 20 + Math.abs(pct) / 4);
  const base = 45 + Math.abs(pct) * 0.45;
  return Math.round(Math.min(92, base));
}

/** 收尾：把 findings 折算成统一节点结构。 */
function buildAgent(meta, findings, summaryFn) {
  const t = tally(findings);
  const stance = stanceOf(t.pct);
  return {
    id: meta.id,
    name: meta.name,
    role: meta.role,
    avatar: meta.avatar,
    stance: stance,
    stanceText: STANCE_TEXT[stance],
    score: t.pct,
    confidence: confidenceOf(t.pct, t.sided),
    evidenceCount: t.sided,
    findings: findings,
    summary: summaryFn(stance, t)
  };
}

/* ------------------------------------------------------------------ *
 * 一、分析师团队：四个视角各自看一遍，互不干扰
 * ------------------------------------------------------------------ */

/** 技术面分析师：只看价格与量能，不看消息。 */
function techAnalyst(ctx) {
  const t = ctx.tech;
  const ind = t && t.indicators;
  const findings = [];

  if (!t || !t.ready || !ind) {
    findings.push(finding('数据完整性', '不足', 'K 线不足 30 根，技术面无法评估', 'neutral', 3));
    return buildAgent(
      { id: 'tech', name: '技术面分析师', role: '只读价格与量能', avatar: 'chart' },
      findings,
      () => 'K 线数据不足 30 根，技术面给不出结论。'
    );
  }

  const close = ctx.last.close;

  // 均线排列：趋势的第一层判断
  if (ind.ma5 !== null && ind.ma10 !== null && ind.ma20 !== null) {
    if (ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20) {
      findings.push(finding('均线排列', '多头排列', 'MA5 ' + ind.ma5 + ' > MA10 ' + ind.ma10 + ' > MA20 ' + ind.ma20 + '，趋势结构完整', 'bull', 3));
    } else if (ind.ma5 < ind.ma10 && ind.ma10 < ind.ma20) {
      findings.push(finding('均线排列', '空头排列', 'MA5 ' + ind.ma5 + ' < MA10 ' + ind.ma10 + ' < MA20 ' + ind.ma20 + '，属于应回避的下跌结构', 'bear', 3));
    } else {
      findings.push(finding('均线排列', '交织', 'MA5/MA10/MA20 相互缠绕，方向不明', 'neutral', 2));
    }
  }

  if (ind.ma20 !== null) {
    const above = close >= ind.ma20;
    findings.push(finding(
      '收盘 vs MA20',
      (above ? '站上 ' : '跌破 ') + ind.ma20,
      above ? '收盘 ' + close + ' 在 MA20 上方，中期结构未破' : '收盘 ' + close + ' 在 MA20 下方，中期结构转弱',
      above ? 'bull' : 'bear', 2
    ));
  }
  if (ind.ma60 !== null) {
    const above60 = close >= ind.ma60;
    findings.push(finding(
      '收盘 vs MA60',
      (above60 ? '站上 ' : '跌破 ') + ind.ma60,
      above60 ? '长期均线仍在上方支撑' : '跌破 MA60，长期结构走坏',
      above60 ? 'bull' : 'bear', 2
    ));
  }

  // MA20 斜率：走平或下行的「站上」不算有效
  if (ctx.ma20SlopePct !== null && ctx.ma20SlopePct !== undefined) {
    const s = ctx.ma20SlopePct;
    findings.push(finding(
      'MA20 五日斜率',
      (s > 0 ? '+' : '') + s + '%',
      s > 0.5 ? 'MA20 明确上行，趋势有动能' : s < -0.5 ? 'MA20 下行，反弹容易被均线压回' : 'MA20 走平，趋势进入无方向状态',
      s > 0.5 ? 'bull' : s < -0.5 ? 'bear' : 'neutral', 2
    ));
  }

  if (ind.dif !== null && ind.dea !== null) {
    const macdBull = ind.dif > ind.dea;
    const aboveZero = ind.dif > 0 && ind.dea > 0;
    findings.push(finding(
      'MACD',
      (macdBull ? 'DIF 在 DEA 上方' : 'DIF 在 DEA 下方') + ' / 柱 ' + ind.macdHist,
      (macdBull ? 'MACD 处于多头动能' : 'MACD 处于空头动能') + (aboveZero ? '，且位于零轴上方（强多头区间）' : '，且位于零轴下方（弱市区间）'),
      macdBull && aboveZero ? 'bull' : macdBull ? 'bull' : aboveZero ? 'neutral' : 'bear', macdBull && aboveZero ? 3 : 2
    ));
  }

  if (ind.j !== null && ind.j !== undefined) {
    if (ind.j > 100) findings.push(finding('KDJ 的 J 值', ind.j, 'J 值超买（>100），短线过热，追高风险大', 'bear', 2));
    else if (ind.j < 0) findings.push(finding('KDJ 的 J 值', ind.j, 'J 值超卖（<0），短线有反抽需求', 'bull', 2));
    else findings.push(finding('KDJ 的 J 值', ind.j, 'J 值处于中性区间', 'neutral', 1));
  }

  if (ind.rsi14 !== null && ind.rsi14 !== undefined) {
    if (ind.rsi14 >= 70) findings.push(finding('RSI(14)', ind.rsi14, 'RSI 超买，短期回调概率上升', 'bear', 2));
    else if (ind.rsi14 <= 30) findings.push(finding('RSI(14)', ind.rsi14, 'RSI 超卖，短期存在修复空间', 'bull', 2));
    else findings.push(finding('RSI(14)', ind.rsi14, 'RSI 中性，无超买超卖信号', 'neutral', 1));
  }

  if (ind.rangePosition20 !== null && ind.rangePosition20 !== undefined) {
    const pos = ind.rangePosition20;
    const overheated = (ind.j !== null && ind.j > 100) || (ind.rsi14 !== null && ind.rsi14 >= 70);
    if (pos >= 85 && overheated) findings.push(finding('20 日区间位置', pos + '%', '处于区间高位且指标过热，属于典型的追高区', 'bear', 3));
    else if (pos >= 85) findings.push(finding('20 日区间位置', pos + '%', '接近 20 日高点，向上空间需靠突破打开', 'bear', 1));
    else if (pos <= 20) findings.push(finding('20 日区间位置', pos + '%', '处于区间低位，需先看到止跌信号再谈机会', 'bear', 1));
    else findings.push(finding('20 日区间位置', pos + '%', '处于区间中部，上下空间相对均衡', 'neutral', 1));
  }

  if (ind.volRatio !== null && ind.volRatio !== undefined) {
    const up = ctx.last.close >= (ctx.prev ? ctx.prev.close : ctx.last.close);
    if (ind.volRatio >= 1.5) {
      findings.push(finding('量能', '10 日均量 ' + ind.volRatio + ' 倍', up ? '放量上行，量价配合' : '放量下行，抛压真实', up ? 'bull' : 'bear', 2));
    } else if (ind.volRatio <= 0.7) {
      findings.push(finding('量能', '10 日均量 ' + ind.volRatio + ' 倍', '明显缩量，多空都在观望', 'neutral', 1));
    }
  }

  if (ctx.change5Pct !== null && ctx.change5Pct !== undefined) {
    const c5 = ctx.change5Pct;
    findings.push(finding(
      '近 5 日涨跌',
      (c5 > 0 ? '+' : '') + c5 + '%',
      c5 > 5 ? '五日涨幅偏大，短线获利盘积累' : c5 < -5 ? '五日跌幅偏大，存在超跌反弹条件' : '五日波动温和',
      c5 > 5 ? 'bear' : c5 < -5 ? 'bull' : 'neutral', 1
    ));
  }

  // 明写的技术信号（indicators 已经算好的金叉/死叉等）
  const sig = (t.signals || []).filter((s) => s.type !== 'neutral').slice(0, 4);
  for (const s of sig) {
    findings.push(finding('技术信号·' + s.group, s.type === 'bullish' ? '看多' : '看空', s.text, s.type === 'bullish' ? 'bull' : 'bear', 1));
  }

  return buildAgent(
    { id: 'tech', name: '技术面分析师', role: '只读价格与量能', avatar: 'chart' },
    findings,
    (stance, t2) => '技术面 ' + t2.sided + ' 条有效信号中多空相抵后倾向「' + STANCE_TEXT[stance] + '」（' +
      (t2.pct > 0 ? '+' : '') + t2.pct + '），当前趋势判定为「' + t.trend + '」。'
  );
}

/** 资金面分析师：看主力真金白银往哪边走。 */
function capitalAnalyst(ctx) {
  const f = ctx.fundFlow;
  const findings = [];

  if (!f) {
    findings.push(finding('资金流数据', '缺失', '未取到个股资金流，资金面无法评估', 'neutral', 3));
    return buildAgent(
      { id: 'capital', name: '资金面分析师', role: '只读主力资金', avatar: 'flow' },
      findings,
      () => '未取到资金流数据，资金面给不出结论。'
    );
  }

  const amount = numOr(ctx.quote && ctx.quote.amountYuan, null);
  const fmtYi = (v) => (v === null ? '—' : (v / 1e8).toFixed(2) + ' 亿');

  if (f.mainNet !== undefined && f.mainNet !== null) {
    const net = f.mainNet;
    const bull = net > 0;
    findings.push(finding(
      '主力净额',
      (net > 0 ? '+' : '') + fmtYi(net),
      bull ? '主力资金净流入，当日有承接' : '主力资金净流出，当日有派发',
      bull ? 'bull' : 'bear', 3
    ));
  }
  if (f.mainPct !== undefined && f.mainPct !== null) {
    const p = f.mainPct;
    const strong = Math.abs(p) >= 5;
    findings.push(finding(
      '主力净占比',
      (p > 0 ? '+' : '') + p + '%',
      strong ? (p > 0 ? '净占比超过 5%，主力介入力度明显' : '净占比低于 -5%，主力撤离力度明显') : '净占比不大，主力态度不明确',
      strong ? (p > 0 ? 'bull' : 'bear') : 'neutral', strong ? 2 : 1
    ));
  }

  if (f.superNet !== undefined && f.superNet !== null) {
    const s = f.superNet;
    const b = s > 0;
    findings.push(finding('超大单净额', (b ? '+' : '') + fmtYi(s), b ? '超大单（机构/大户）净买入' : '超大单净卖出', b ? 'bull' : 'bear', 2));
  }
  if (f.bigNet !== undefined && f.bigNet !== null) {
    const b = f.bigNet > 0;
    findings.push(finding('大单净额', (b ? '+' : '') + fmtYi(f.bigNet), b ? '大单净买入' : '大单净卖出', b ? 'bull' : 'bear', 1));
  }

  // 散户与主力反向 = 典型的派发/吸筹特征，是很有价值的一条
  if (f.smallNet !== undefined && f.smallNet !== null && f.mainNet !== undefined) {
    const retailIn = f.smallNet > 0;
    const mainIn = f.mainNet > 0;
    if (retailIn && !mainIn) {
      findings.push(finding('散户 vs 主力', '反向', '散户净买入 ' + fmtYi(f.smallNet) + '，主力净卖出 ' + fmtYi(f.mainNet) + '，是典型的「散户接盘」结构', 'bear', 3));
    } else if (!retailIn && mainIn) {
      findings.push(finding('散户 vs 主力', '反向', '散户净卖出 ' + fmtYi(f.smallNet) + '，主力净买入 ' + fmtYi(f.mainNet) + '，筹码向主力集中', 'bull', 3));
    } else {
      findings.push(finding('散户 vs 主力', '同向', '主力与散户同向，说明是普涨普跌而非结构性吸筹', 'neutral', 1));
    }
  }

  if (amount) {
    findings.push(finding('成交额', fmtYi(amount), '成交额反映当日资金参与度，可与资金流方向结合看', 'neutral', 1));
  }

  return buildAgent(
    { id: 'capital', name: '资金面分析师', role: '只读主力资金', avatar: 'flow' },
    findings,
    (stance, t2) => '资金面多空折算后倾向「' + STANCE_TEXT[stance] + '」（' +
      (t2.pct > 0 ? '+' : '') + t2.pct + '），主力净额为 ' +
      (f.mainNet > 0 ? '流入' : '流出') + ' ' + fmtYi(Math.abs(f.mainNet)) + '。'
  );
}

/** 舆情分析师：新闻口径为主，股吧情绪只作辅助（噪声大）。 */
function sentimentAnalyst(ctx) {
  const findings = [];
  const s = ctx.stockNews && ctx.stockNews.sentiment;
  const items = (ctx.stockNews && ctx.stockNews.items) || [];

  if (!s || !items.length) {
    findings.push(finding('新闻样本', '0 条', '近期没有抓到与该股相关的新闻，舆情面无法评估', 'neutral', 3));
  } else {
    const score = s.score;
    findings.push(finding(
      '新闻情感分',
      (score > 0 ? '+' : '') + score + '（' + s.label + '）',
      '基于 ' + items.length + ' 条相关新闻的正负词加权（近的新闻权重更高）',
      score >= 15 ? 'bull' : score <= -15 ? 'bear' : 'neutral', Math.abs(score) >= 45 ? 3 : 2
    ));

    // 舆情与价格背离：消息好但股价跌，说明利好没兑现或被用来出货
    const c5 = ctx.change5Pct;
    if (c5 !== null && c5 !== undefined) {
      if (score >= 20 && c5 < -3) {
        findings.push(finding('舆情 vs 价格', '负背离', '舆情偏多（' + score + '）但近 5 日下跌 ' + c5 + '%，利好未被价格确认', 'bear', 3));
      } else if (score <= -20 && c5 > 3) {
        findings.push(finding('舆情 vs 价格', '正背离', '舆情偏空（' + score + '）但近 5 日上涨 ' + c5 + '%，利空可能已提前消化', 'bull', 2));
      } else {
        findings.push(finding('舆情 vs 价格', '一致', '舆情（' + score + '）与近 5 日涨跌（' + c5 + '%）方向一致，消息被价格印证', 'neutral', 1));
      }
    }

    const terms = (s.topTerms || []).slice(0, 5);
    if (terms.length) {
      const bull = terms.filter((t) => t.polarity === 'bullish').length;
      const bear = terms.filter((t) => t.polarity === 'bearish').length;
      findings.push(finding(
        '高频词',
        terms.map((t) => t.term).join('、'),
        '看多词 ' + bull + ' 个 / 看空词 ' + bear + ' 个，是情感分的主要来源',
        bull > bear ? 'bull' : bear > bull ? 'bear' : 'neutral', 1
      ));
    }
  }

  // 股吧：人多的地方噪声大，只在「极度一致」时才当反向信号用
  const g = ctx.guba;
  if (g && g.sentiment) {
    const gs = g.sentiment.score;
    const hot = g.count || 0;
    if (Math.abs(gs) >= 45 && hot >= 20) {
      findings.push(finding(
        '股吧情绪',
        gs + '（' + g.sentiment.label + '）· ' + hot + ' 帖',
        gs > 0 ? '散户情绪一边倒看多，人多的地方要小心' : '散户情绪一边倒看空，往往是阶段性底部特征',
        gs > 0 ? 'bear' : 'bull', 2
      ));
    } else {
      findings.push(finding('股吧情绪', gs + '（' + g.sentiment.label + '）· ' + hot + ' 帖', '股吧情绪分歧或样本太少，参考价值有限', 'neutral', 1));
    }
  }

  const warned = findings.some((f) => f.label === '股吧情绪' && f.stance === 'bear' && f.weight === 2);
  return buildAgent(
    { id: 'sentiment', name: '舆情分析师', role: '读新闻与股吧', avatar: 'news' },
    findings,
    (stance, t2) => (items.length ? '共 ' + items.length + ' 条相关新闻，' : '没有抓到相关新闻，') +
      '舆情面倾向「' + STANCE_TEXT[stance] + '」（' + (t2.pct > 0 ? '+' : '') + t2.pct + '）' +
      (warned ? '；股吧情绪已到极度一致区间，按反向信号处理。' : '。')
  );
}

/** 产业链分析师：把个股接回它所在的商品链（煤价、棉价这些是上游成本/售价）。 */
function industryAnalyst(ctx) {
  const findings = [];
  const chain = ctx.chain;

  if (!chain) {
    findings.push(finding('产业链匹配', '未匹配', '东财行业为「' + ((ctx.profile && ctx.profile.industry) || '未知') + '」，未命中已收录的商品产业链，本环节跳过、不强行归因', 'neutral', 2));
    return buildAgent(
      { id: 'industry', name: '产业链分析师', role: '商品链联动', avatar: 'chain' },
      findings,
      () => '该股未匹配到已收录的商品产业链（目前覆盖煤炭、棉花纺织、钢铁、有色、能源化工、农业、建材），本环节跳过。'
    );
  }

  const rel = (ctx.futures || []).filter((x) => chain.symbols.indexOf(x.symbol) >= 0 && x.available);
  if (!rel.length) {
    findings.push(finding('商品行情', '未取到', chain.name + '相关合约当前没有返回行情（可能停牌或已不活跃）', 'neutral', 3));
  }

  for (const r of rel) {
    const pct = numOr(r.changePct, null);
    if (pct === null) continue;
    const strong = Math.abs(pct) >= 1;
    findings.push(finding(
      r.name + '（' + r.symbol + '）',
      (pct > 0 ? '+' : '') + pct + '% · ' + r.last + ' ' + r.unit,
      pct > 0 ? '上游' + chain.name + '价格走强，对' + chain.name + '产业链公司是顺风' : '上游' + chain.name + '价格走弱，' + chain.name + '产业链公司承压',
      pct > 0 ? 'bull' : 'bear', strong ? 2 : 1
    ));
  }

  // 煤炭专属：港口库存直接决定煤价，库存累积 = 煤价压力
  if (chain.id === 'coal' && ctx.coalSeries && ctx.coalSeries.ports && ctx.coalSeries.ports.length) {
    const ports = ctx.coalSeries.ports.filter((p) => p.latest && p.deltaPct !== null);
    if (ports.length) {
      const avg = round(ports.reduce((acc, p) => acc + p.deltaPct, 0) / ports.length, 2);
      findings.push(finding(
        '港口库存变化',
        (avg > 0 ? '+' : '') + avg + '%（' + ports.length + ' 港均值）',
        avg > 1 ? '港口库存累积，压制煤价' : avg < -1 ? '港口库存去化，对煤价有支撑' : '港口库存变化平缓，供需矛盾不突出',
        avg > 1 ? 'bear' : avg < -1 ? 'bull' : 'neutral', 2
      ));
    }
  }

  return buildAgent(
    { id: 'industry', name: '产业链分析师', role: '商品链联动', avatar: 'chain' },
    findings,
    (stance, t2) => '该股归属「' + chain.name + '」链（' + chain.note + '），产业链维度倾向「' +
      STANCE_TEXT[stance] + '」（' + (t2.pct > 0 ? '+' : '') + t2.pct + '）。'
  );
}

/* ------------------------------------------------------------------ *
 * 二、研究员团队：同一批证据，分别站在多空两侧各写一份
 * ------------------------------------------------------------------ */

/**
 * 反驳不编造事实，只回答「你这条论据在什么条件下才失效」。
 * 这样既让辩论有实质内容，又不会把推测写成结论。
 */
const REBUTTAL_CONDITION = {
  '均线排列': 'MA5 重新上穿 MA10 与 MA20，把空头排列拆掉',
  '收盘 vs MA20': '收盘重新站回 MA20 上方，并且连续 3 个交易日不再跌回去',
  '收盘 vs MA60': '收盘收复 MA60',
  'MA20 五日斜率': 'MA20 的斜率由负转正',
  'MACD': 'DIF 重新上穿 DEA，或 MACD 柱由绿翻红',
  'KDJ 的 J 值': 'J 值从超买区回落并重新金叉',
  'RSI(14)': 'RSI 回落到 50 附近后重新抬升',
  '20 日区间位置': '放量突破 20 日高点，把「高位」变成「突破位」',
  '量能': '出现新的放量阳线，把缩量僵局打破',
  '主力净额': '主力资金由净流出转为连续净流入',
  '主力净占比': '主力净占比回到 0 轴上方',
  '散户 vs 主力': '主力资金重新转为净流入',
  '新闻情感分': '出现实质性的正面公告（订单、业绩、政策），而不是媒体转述',
  '舆情 vs 价格': '价格用一根放量阳线确认消息面',
  '股吧情绪': '股吧情绪从极端回到分歧区',
  '港口库存变化': '港口库存由累积转为持续去化'
};

function rebuttalOf(label) {
  for (const key of Object.keys(REBUTTAL_CONDITION)) {
    if (String(label).indexOf(key) >= 0) return REBUTTAL_CONDITION[key];
  }
  return '出现与它方向相反的新数据，并且被价格确认';
}

/** 把四个分析师的论据按立场分成两堆，各自取最有分量的几条。 */
function researcher(side, analysts) {
  const isBull = side === 'bull';
  const own = [];
  const other = [];
  for (const a of analysts) {
    for (const f of a.findings) {
      const item = { label: f.label, value: f.value, note: f.note, weight: f.weight, from: a.name, stance: f.stance };
      if (f.stance === side) own.push(item);
      else if (f.stance === (isBull ? 'bear' : 'bull')) other.push(item);
    }
  }
  own.sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
  other.sort((a, b) => b.weight - a.weight);

  const top = own.slice(0, 5);
  const findings = top.map((f) =>
    finding(f.label, f.value, f.note + '（来源：' + f.from + '）', side, f.weight));

  const strongest = other[0] || null;
  let summary;
  if (!top.length) {
    summary = '找不到支撑' + (isBull ? '看多' : '看空') + '的硬数据，这一方本次没有可站得住的论据。';
  } else {
    summary = (isBull ? '多头' : '空头') + '方最有力的 ' + top.length + ' 条论据是：' +
      top.map((f) => f.label + '（' + f.value + '）').join('、') + '。';
  }
  if (strongest) {
    summary += ' 对方最有力的一条是「' + strongest.label + '：' + strongest.value + '」——' +
      (isBull ? '多头' : '空头') + '要成立，需要看到' + rebuttalOf(strongest.label) + '；在此之前这条不能被忽略。';
  }

  const t = tally(findings);
  return {
    id: side === 'bull' ? 'bull' : 'bear',
    name: isBull ? '多头研究员' : '空头研究员',
    role: isBull ? '只找上涨的理由' : '只找下跌的理由',
    avatar: isBull ? 'bull' : 'bear',
    stance: side,
    stanceText: STANCE_TEXT[side],
    score: t.pct,
    confidence: confidenceOf(t.pct, t.sided),
    evidenceCount: t.sided,
    findings: findings,
    opponent: strongest ? { label: strongest.label, value: strongest.value, rebuttalCondition: rebuttalOf(strongest.label), from: strongest.from } : null,
    summary: summary
  };
}

/* ------------------------------------------------------------------ *
 * 三、交易员：把多空两方摆在一起，给一个可执行的框架（不是买卖指令）
 * ------------------------------------------------------------------ */

/** 各分析师的权重：技术面最重，产业链最轻（传导链条长、见效慢）。 */
const ANALYST_WEIGHT = { tech: 3, capital: 2.5, sentiment: 2, industry: 1.5 };

function traderAgent(ctx, analysts, bull, bear) {
  const findings = [];

  // 只有真正给出了数据的分析师才参与加权，避免「没数据」被当成「中性」稀释结论
  let sum = 0;
  let wsum = 0;
  for (const a of analysts) {
    const w = ANALYST_WEIGHT[a.id];
    if (!w || !a.evidenceCount) continue;
    sum += a.score * w;
    wsum += w;
  }
  const composite = wsum ? Math.round(sum / wsum) : 0;

  const ind = ctx.tech && ctx.tech.indicators ? ctx.tech.indicators : {};
  const bars = ctx.bars || [];
  const win = bars.slice(-20);
  const hi20 = win.length ? Math.max.apply(null, win.map((b) => b.high)) : null;
  const lo20 = win.length ? Math.min.apply(null, win.map((b) => b.low)) : null;
  const close = ctx.last ? ctx.last.close : null;

  findings.push(finding(
    '四维合成倾向',
    (composite > 0 ? '+' : '') + composite,
    '技术面 ×3 / 资金面 ×2.5 / 舆情 ×2 / 产业链 ×1.5 加权；只计入有数据的维度',
    stanceOf(composite), 3
  ));
  findings.push(finding(
    '多空辩论结果',
    '多头 ' + bull.evidenceCount + ' 条 vs 空头 ' + bear.evidenceCount + ' 条',
    '多头论据更强时倾向做多，反之亦然；条数接近说明分歧大，应当降低仓位',
    bull.evidenceCount > bear.evidenceCount + 1 ? 'bull' : bear.evidenceCount > bull.evidenceCount + 1 ? 'bear' : 'neutral', 2
  ));

  // 参考区间与止损：全部落在 MA20 / 20 日高低这些「看得见」的价位上
  const ma20 = ind.ma20 !== null && ind.ma20 !== undefined ? ind.ma20 : null;
  const aboveMa20 = ma20 !== null && close !== null && close >= ma20;

  /**
   * 位置决定「买点」这件事到底存不存在：
   *   站上 MA20 -> 可以把「回踩 MA20」当作低吸区间；
   *   跌破 MA20 -> 均线在头顶压着，这时再报一个低吸区间就是自欺欺人，
   *                改成告诉用户「要先收复哪个价位」。
   * （早期版本无论位置都拿 MA20 当区间下沿，结果出现「下沿高于上沿」的倒挂。）
   */
  const plan = {
    mode: aboveMa20 ? 'trend-follow' : 'wait-reclaim',
    zoneLow: null,
    zoneHigh: null,
    reclaimLevel: null,
    stopRef: null,
    stopBasis: null,
    stopPct: null,
    targetRef: null,
    riskReward: null,
    maxPositionPct: null
  };

  if (plan.mode === 'trend-follow') {
    plan.zoneLow = round(ma20, 2);
    plan.zoneHigh = round(close, 2);
  } else if (ma20 !== null) {
    plan.reclaimLevel = round(ma20, 2);
  }

  // 止损：优先 MA20 下方 2%；若它已经跑到现价上方（逆势），退回 20 日低点下方 1%
  if (ma20 !== null && close) {
    const byMa = round(ma20 * 0.98, 2);
    if (byMa < close) {
      plan.stopRef = byMa;
      plan.stopBasis = 'MA20 下方 2%';
    } else if (lo20) {
      plan.stopRef = round(lo20 * 0.99, 2);
      plan.stopBasis = '20 日低点下方 1%';
    }
    if (plan.stopRef !== null && plan.stopRef < close) {
      plan.stopPct = round(((close - plan.stopRef) / close) * 100, 2);
    } else {
      plan.stopRef = null;
      plan.stopBasis = null;
    }
  }

  if (plan.stopPct !== null && plan.stopPct > 0) {
    plan.maxPositionPct = round(Math.min(30, (2 / plan.stopPct) * 100), 1);
  }

  plan.targetRef = hi20 ? round(hi20, 2)
    : (ind.bollUpper !== null && ind.bollUpper !== undefined ? round(ind.bollUpper, 2) : null);

  // 盈亏比只在顺势位置算：逆势时「目标价」远在头顶，算出来的高盈亏比是假象
  if (plan.mode === 'trend-follow' && plan.targetRef && plan.stopRef && close) {
    plan.riskReward = round((plan.targetRef - close) / (close - plan.stopRef), 2);
  }

  if (plan.mode === 'trend-follow') {
    findings.push(finding(
      '参考回踩区间',
      plan.zoneLow + ' ~ ' + plan.zoneHigh,
      '现价站上 MA20，可把 MA20（' + plan.zoneLow + '）当作回踩支撑，区间上沿取现价',
      'bull', 2
    ));
  } else {
    findings.push(finding(
      '当前位置',
      plan.reclaimLevel === null ? '在 MA20 下方' : '需先收复 ' + plan.reclaimLevel,
      '现价 ' + close + ' 在 MA20' + (plan.reclaimLevel === null ? '' : '（' + plan.reclaimLevel + '）') +
        ' 下方，按「回踩均线买入」的逻辑当前并不成立，先看能不能收回这条线，再谈区间',
      'bear', 2
    ));
  }

  findings.push(finding(
    '参考止损位',
    plan.stopRef === null ? '无法计算' : plan.stopRef + '（距现价 ' + plan.stopPct + '%，基准：' + plan.stopBasis + '）',
    '止损位按「看得见的价位」定，不按心情定；先有止损，才谈得上仓位',
    'neutral', 2
  ));
  findings.push(finding(
    '参考仓位上限',
    plan.maxPositionPct === null ? '无法计算' : plan.maxPositionPct + '%',
    '同时满足「单笔风险 ≤ 总资金 2%」与「单只 ≤ 总仓位 30%」后取更严的那个',
    'neutral', 2
  ));
  if (plan.riskReward !== null) {
    findings.push(finding(
      '盈亏比（到 20 日高点）',
      plan.riskReward + ' : 1',
      plan.riskReward >= 2 ? '盈亏比达到 2:1 以上，值得纳入观察' : '盈亏比不足 2:1，即便方向看对，空间也不够',
      plan.riskReward >= 2 ? 'bull' : 'bear', 2
    ));
  } else if (plan.mode === 'wait-reclaim') {
    findings.push(finding(
      '盈亏比',
      '暂不计算',
      '现价在 MA20 下方属逆势位置，此时用 20 日高点算盈亏比会得到一个虚高的数字，所以不给',
      'neutral', 1
    ));
  }

  const t = tally(findings);
  const stance = stanceOf(composite);
  return {
    id: 'trader',
    name: '交易员',
    role: '综合多空给出执行框架',
    avatar: 'target',
    stance: stance,
    stanceText: STANCE_TEXT[stance],
    score: composite,
    confidence: confidenceOf(composite, bull.evidenceCount + bear.evidenceCount),
    evidenceCount: bull.evidenceCount + bear.evidenceCount,
    findings: findings,
    plan: plan,
    composite: composite,
    summary: '四维合成后倾向「' + STANCE_TEXT[stance] + '」（' + (composite > 0 ? '+' : '') + composite + '）。' +
      '多空双方分别给出 ' + bull.evidenceCount + ' 条与 ' + bear.evidenceCount + ' 条论据。' +
      (Math.abs(bull.evidenceCount - bear.evidenceCount) <= 1
        ? '两方论据数量接近，属于分歧较大的状态，若参与应明显降低仓位。'
        : '论据数量差距明显，方向相对清晰。') +
      (plan.mode === 'trend-follow'
        ? ' 现价站在 MA20 上方，' + plan.zoneLow + ' ~ ' + plan.zoneHigh + ' 是回踩可参考的区间。'
        : ' 现价已在 MA20 下方，按均线逻辑当前没有回踩买点，先看能否收复 ' + plan.reclaimLevel + '。') +
      ' 以上价位与仓位都是由均线、20 日区间和「单笔 2% 风险」规则推出来的参考值，不是买卖指令。'
  };
}

/* ------------------------------------------------------------------ *
 * 四、风控经理：逐条否决项，宁可错过，不可做错
 * ------------------------------------------------------------------ */

function riskAgent(ctx, analysts) {
  const ind = ctx.tech && ctx.tech.indicators ? ctx.tech.indicators : {};
  const bars = ctx.bars || [];
  const win = bars.slice(-20);
  const lo20 = win.length ? Math.min.apply(null, win.map((b) => b.low)) : null;
  const close = ctx.last ? ctx.last.close : null;
  const vetoes = [];
  const findings = [];

  const veto = (label, detail, weight) => {
    vetoes.push({ label: label, detail: detail });
    findings.push(finding(label, '否决项', detail, 'bear', weight || 3));
  };
  const pass = (label, detail) => findings.push(finding(label, '通过', detail, 'bull', 2));

  if (!ctx.tech || !ctx.tech.ready) {
    veto('数据不足', 'K 线不足 30 根，无法计算均线与波动区间，任何结论都不可靠', 3);
  } else {
    if (ind.ma5 !== null && ind.ma10 !== null && ind.ma20 !== null && ind.ma5 < ind.ma10 && ind.ma10 < ind.ma20) {
      veto('空头排列', 'MA5 < MA10 < MA20，属于知识库里明确写「不参与」的下跌结构', 3);
    } else {
      pass('均线结构', '未构成空头排列');
    }
    if (ind.ma60 !== null && ind.ma60 !== undefined && close < ind.ma60) {
      veto('跌破 MA60', '收盘 ' + close + ' 低于 MA60 ' + ind.ma60 + '，长期结构转弱', 3);
    } else if (ind.ma60 !== null) {
      pass('长期结构', '收盘仍在 MA60 上方');
    }
    if (ind.rangePosition20 >= 85) {
      const over = (ind.j !== null && ind.j > 100) || (ind.rsi14 !== null && ind.rsi14 >= 70);
      if (over) veto('高位追涨', '处于 20 日区间 ' + ind.rangePosition20 + '% 高位且指标过热，正是知识库里的追高风险区', 3);
      else findings.push(finding('高位', '警示', '处于 20 日区间 ' + ind.rangePosition20 + '% 高位，追高性价比低', 'bear', 2));
    }
  }

  const cap = ctx.fundFlow;
  if (cap && cap.mainNet !== undefined && cap.mainNet !== null) {
    if (cap.mainNet < 0 && cap.smallNet > 0) veto('主力派发', '主力净流出而散户净流入，是典型的派发结构，与「不接下跌中的货」冲突', 3);
    else if (cap.mainNet > 0) pass('资金面', '主力资金净流入 ' + (cap.mainNet / 1e8).toFixed(2) + ' 亿');
  }

  const s = ctx.stockNews && ctx.stockNews.sentiment;
  if (s && ctx.change5Pct !== null && ctx.change5Pct !== undefined) {
    if (s.score >= 20 && ctx.change5Pct < -3) veto('舆情负背离', '消息面偏多但价格下跌，说明利好没被资金认可，谨防利好出尽', 2);
  }

  if (ctx.chain && ctx.chain.id === 'coal' && ctx.coalSeries && ctx.coalSeries.ports) {
    const ports = ctx.coalSeries.ports.filter((p) => p.latest && p.deltaPct !== null);
    if (ports.length) {
      const avg = ports.reduce((acc, p) => acc + p.deltaPct, 0) / ports.length;
      if (avg > 2) veto('产业链逆风', '港口库存均值上升 ' + round(avg, 2) + '%，煤价承压，会直接压制煤炭股利润预期', 2);
    }
  }

  if (!vetoes.length) {
    findings.push(finding('否决项汇总', '0 条', '没有触发任何否决项，但这只代表「没有明显硬伤」，不代表值得买入', 'neutral', 1));
  }

  const t = tally(findings);
  return {
    id: 'risk',
    name: '风控经理',
    role: '逐条检查否决项',
    avatar: 'shield',
    stance: vetoes.length ? 'bear' : stanceOf(t.pct),
    stanceText: vetoes.length ? '存在否决项' : STANCE_TEXT[stanceOf(t.pct)],
    score: t.pct,
    confidence: vetoes.length ? 80 : 55,
    evidenceCount: t.sided,
    findings: findings,
    vetoed: vetoes.length > 0,
    vetoes: vetoes,
    summary: vetoes.length
      ? '触发 ' + vetoes.length + ' 条否决项：' + vetoes.map((v) => v.label).join('、') + '。按「宁可错过，不可做错」的原则，存在否决项时不应参与。'
      : '未触发否决项。注意：这不等于「可以买」，只是说明没有发现明显的结构性风险。'
  };
}

/* ------------------------------------------------------------------ *
 * 编排：按「分析师 -> 辩论 -> 交易员 -> 风控」跑完整条链路
 * ------------------------------------------------------------------ */

/**
 * @param {string} code 6 位股票代码
 * @param {{industry?:string}} [opts] industry 可显式指定产业链 id，跳过名称匹配
 * @returns {Promise<object>} 完整研判报告
 */
async function runAgents(code, opts) {
  const options = opts || {};
  const c = String(code || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(c)) {
    const err = new Error('股票代码必须是 6 位数字（如 600519）');
    err.status = 400;
    throw err;
  }

  const gaps = [];

  // 第一步：行情 + K 线 + 资金流。产业链要靠名称匹配，所以必须等 name 出来。
  const [quote, kline, daily, flow, profile] = await Promise.all([
    ths.fetchQuote(c).catch(() => null),
    quotes.getKline(c, 260).catch(() => null),
    ths.fetchDaily(c, 260).catch(() => null),
    market.getFundFlow([c]).catch(() => null),
    quotes.getProfile(c).catch(() => null)
  ]);
  if (!quote) gaps.push('实时行情（同花顺）');
  if (!flow) gaps.push('个股资金流（东方财富）');
  if (!profile) gaps.push('行业与概念（东方财富）');

  const bars = (kline && kline.length ? kline : (daily && daily.rows ? daily.rows : [])) || [];
  if (!bars.length) {
    const err = new Error('未取得 K 线数据，智能体研判无法运行');
    err.status = 502;
    throw err;
  }

  const name = (quote && quote.name) || (daily && daily.name) || '';
  const tech = indicators.analyze(bars);
  const closes = bars.map((b) => b.close);
  const i = bars.length - 1;
  const last = bars[i];
  const prev = bars[i - 1] || null;
  const ma20Series = indicators.sma(closes, 20);
  const ma20Now = ma20Series[i];
  const ma20Prev = ma20Series[i - 5];
  const ma20SlopePct = ma20Now && ma20Prev ? round(((ma20Now - ma20Prev) / ma20Prev) * 100, 2) : null;
  const change5Pct = bars.length >= 6 ? round((last.close / bars[i - 5].close - 1) * 100, 2) : null;

  // 第二步：产业链匹配 -> 只抓该链相关的商品行情（不匹配就跳过，不做无谓请求）
  const chain = options.industry
    ? INDUSTRY_CHAIN.find((x) => x.id === options.industry) || null
    : matchChain(name, profile);

  const [futuresList, coalSeries, stockNews, board] = await Promise.all([
    chain ? futures.getFuturesRealtime().catch(() => { gaps.push('商品期货行情（新浪）'); return null; }) : Promise.resolve(null),
    chain && chain.id === 'coal' ? Promise.resolve().then(() => coal.buildSeries()).catch(() => { gaps.push('港口库存（本地 CSV）'); return null; }) : Promise.resolve(null),
    news.getStockNews(name, c, 15).catch(() => { gaps.push('个股新闻（东方财富）'); return null; }),
    guba.fetchBoard(c, 40).catch(() => { gaps.push('股吧（新浪股市汇）'); return null; })
  ]);

  const ctx = {
    code: c,
    name: name,
    quote: quote,
    bars: bars,
    last: last,
    prev: prev,
    tech: tech,
    ma20SlopePct: ma20SlopePct,
    change5Pct: change5Pct,
    fundFlow: flow && flow.length ? flow[0] : null,
    profile: profile,
    chain: chain,
    futures: futuresList || [],
    coalSeries: coalSeries,
    stockNews: stockNews || { items: [], sentiment: null },
    guba: board
  };

  // 第三步：四个分析师各看一遍
  const analysts = [techAnalyst(ctx), capitalAnalyst(ctx), sentimentAnalyst(ctx), industryAnalyst(ctx)];

  // 第四步：多空研究员各自成文（必须带上对对方最强论据的回应）
  const bull = researcher('bull', analysts);
  const bear = researcher('bear', analysts);

  // 第五步：交易员合成 + 风控把关
  const trader = traderAgent(ctx, analysts, bull, bear);
  const risk = riskAgent(ctx, analysts);

  const overall = risk.vetoed ? '存在否决项' : STANCE_TEXT[trader.stance];
  const confidence = risk.vetoed ? Math.min(trader.confidence, 45) : Math.round((trader.confidence + risk.confidence) / 2);

  return {
    code: c,
    name: name,
    ready: true,
    updatedAt: new Date().toISOString(),
    quote: quote,
    profile: profile ? { industry: profile.industry, concepts: profile.concepts.slice(0, 12) } : null,
    chain: chain ? { id: chain.id, name: chain.name, note: chain.note } : null,
    klineSummary: {
      bars: bars.length,
      last: last.close,
      change5Pct: change5Pct,
      ma20SlopePct: ma20SlopePct,
      trend: tech.ready ? tech.trend : '数据不足'
    },
    analysts: analysts,
    debate: { bull: bull, bear: bear },
    trader: trader,
    risk: risk,
    verdict: { stance: risk.vetoed ? 'bear' : trader.stance, text: overall, composite: trader.composite, confidence: confidence },
    dataGaps: gaps,
    disclaimer: '本研判由本机规则引擎按公开数据推导，输出的是「各视角怎么看 + 规则怎么判」，不构成任何投资建议；' +
      '数据缺失的维度会在「数据缺口」里列出，请勿把缺数据的结论当成中性结论。'
  };
}

module.exports = {
  runAgents,
  matchChain,
  INDUSTRY_CHAIN,
  ANALYST_WEIGHT,
  // 以下导出给离线自检用，不参与运行时编排
  _internals: { finding, tally, stanceOf, confidenceOf, researcher, rebuttalOf, REBUTTAL_CONDITION, traderAgent, riskAgent, techAnalyst }
};
