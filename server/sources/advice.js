'use strict';

const quotes = require('./quotes');
const ths = require('./ths');
const indicators = require('../lib/indicators');
const screener = require('./screener');
const analysis = require('./analysis');
const { cached } = require('../lib/cache');

/**
 * 选股建议 与 走势分析。
 *
 * 重要口径说明：
 *  - 这里不做价格预测，也不输出「买/卖」指令。
 *  - 「建议」= 按知识库规则（analysis.PLAYBOOK_RULES）逐条核对后，把满足度更高、
 *    且风险条款没有被违反的候选股排在前面，并把每条规则的判定原文一并展示，方便复核。
 *  - 技术面规则只用 K 线数据即可判定；舆情/股吧/资金流三条规则在批量扫描时数据不足，
 *    会如实返回「不适用」，不计入得分。
 */

const RULE_LABEL = {
  'trend-above-ma20': 'MA20 结构',
  'not-falling-knife': '均线排列',
  'volume-confirm': '放量确认',
  'not-chasing-high': '位置高低',
  'sentiment-price-consistency': '舆情一致性',
  'guba-crowding': '股吧拥挤度',
  'fund-flow': '资金方向',
  'stop-loss-plan': '止损与仓位'
};

const DISCLAIMER =
  '本页只做「是否满足你自定交易规则」的一致性核对，不预测涨跌、不构成投资建议；' +
  '规则得分高只代表当前形态更符合手册里的入场前提，不代表一定上涨，也不排除突然的基本面利空。';

/** 取 K 线：优先东方财富（前复权），失败回落同花顺。 */
async function loadBars(code) {
  const c = String(code).replace(/\D/g, '');
  let bars = await quotes.getKline(c, 260).catch(() => []);
  if (!bars || bars.length < 30) {
    const daily = await ths.fetchDaily(c, 260).catch(() => null);
    const rows = (daily && daily.rows) || [];
    if (rows.length > (bars ? bars.length : 0)) bars = rows;
  }
  return bars || [];
}

/** 组装规则判定上下文（仅技术面，舆情/股吧/资金流留空 -> 规则自行返回 na）。 */
function buildContext(bars, extra) {
  const tech = indicators.analyze(bars);
  const closes = bars.map((b) => b.close);
  const i = bars.length - 1;
  const ma20Series = indicators.sma(closes, 20);
  const ma20Now = ma20Series[i];
  const ma20Prev = ma20Series[i - 5];
  const ma20SlopePct = ma20Now && ma20Prev ? Number((((ma20Now - ma20Prev) / ma20Prev) * 100).toFixed(2)) : null;
  const change5Pct = bars.length >= 6 ? Number(((bars[i].close / bars[i - 5].close - 1) * 100).toFixed(2)) : null;
  return Object.assign({
    tech: tech,
    last: bars[i],
    ma20SlopePct: ma20SlopePct,
    change5Pct: change5Pct,
    change1Pct: extra && extra.change1Pct !== undefined ? extra.change1Pct : null,
    newsSentiment: null,
    guba: null,
    fundFlow: null
  }, extra || {});
}

function runRules(ctx) {
  return analysis.PLAYBOOK_RULES.map((r) => {
    const res = r.evaluate(ctx);
    return { id: r.id, label: RULE_LABEL[r.id] || r.id, status: res.status, detail: res.detail };
  });
}

function scoreOf(checks) {
  const count = (s) => checks.filter((c) => c.status === s).length;
  const pass = count('pass');
  const warn = count('warn');
  const fail = count('fail');
  return { pass: pass, warn: warn, fail: fail, na: count('na'), info: count('info'), score: pass * 2 - warn - fail * 3 };
}

/** 支撑 / 压力 / 参考止损 / 建议仓位上限。 */
function keyLevels(bars) {
  const ind = indicators.analyze(bars).indicators;
  if (!ind) return null;
  const last = bars[bars.length - 1].close;
  const win20 = bars.slice(-20);
  const win60 = bars.slice(-60);
  const hi20 = Math.max.apply(null, win20.map((b) => b.high));
  const lo20 = Math.min.apply(null, win20.map((b) => b.low));
  const hi60 = Math.max.apply(null, win60.map((b) => b.high));
  const lo60 = Math.min.apply(null, win60.map((b) => b.low));
  const pool = [
    { name: 'MA20', value: ind.ma20 },
    { name: 'MA60', value: ind.ma60 },
    { name: '布林下轨', value: ind.bollLower },
    { name: '布林上轨', value: ind.bollUpper },
    { name: '近20日低', value: lo20 },
    { name: '近20日高', value: hi20 }
  ].filter((x) => Number.isFinite(x.value));
  const supports = pool.filter((x) => x.value <= last).sort((a, b) => b.value - a.value).slice(0, 3)
    .map((x) => ({ name: x.name, value: Number(x.value.toFixed(2)), distancePct: Number((((x.value - last) / last) * 100).toFixed(2)) }));
  const resistances = pool.filter((x) => x.value > last).sort((a, b) => a.value - b.value).slice(0, 3)
    .map((x) => ({ name: x.name, value: Number(x.value.toFixed(2)), distancePct: Number((((x.value - last) / last) * 100).toFixed(2)) }));
  const refStop = Number.isFinite(ind.ma20) ? Number((ind.ma20 * 0.98).toFixed(2)) : null;
  const stopPct = refStop ? Number((((last - refStop) / last) * 100).toFixed(2)) : null;
  const maxPositionPct = stopPct && stopPct > 0 ? Number(Math.min(30, (2 / stopPct) * 100).toFixed(1)) : null;
  return {
    last: Number(last.toFixed(2)),
    supports: supports,
    resistances: resistances,
    hi20: Number(hi20.toFixed(2)),
    lo20: Number(lo20.toFixed(2)),
    hi60: Number(hi60.toFixed(2)),
    lo60: Number(lo60.toFixed(2)),
    refStop: refStop,
    stopPct: stopPct,
    maxPositionPct: maxPositionPct
  };
}

/** 多周期走势判定：短期 / 中期 / 位置 / 量价，各给出依据句。 */
function horizonRead(bars) {
  const i = bars.length - 1;
  const closes = bars.map((b) => b.close);
  const ind = indicators.analyze(bars).indicators || {};
  const ma5 = indicators.sma(closes, 5)[i];
  const ma10 = indicators.sma(closes, 10)[i];
  const last = closes[i];
  const chg5 = i >= 5 ? Number(((last / closes[i - 5] - 1) * 100).toFixed(2)) : null;
  const chg20 = i >= 20 ? Number(((last / closes[i - 20] - 1) * 100).toFixed(2)) : null;
  const verdictOf = (n) => (n >= 2 ? '偏多' : n <= -2 ? '偏空' : '中性');

  // 短期
  const shortNotes = [];
  let sShort = 0;
  if (ma5 !== null && ma10 !== null) {
    if (ma5 > ma10) { sShort += 1; shortNotes.push('MA5（' + ma5 + '）在 MA10（' + ma10 + '）上方，短期均线多头'); }
    else { sShort -= 1; shortNotes.push('MA5（' + ma5 + '）在 MA10（' + ma10 + '）下方，短期均线偏空'); }
  }
  if (chg5 !== null) {
    if (chg5 > 0) { sShort += 1; shortNotes.push('近 5 日累计上涨 ' + chg5 + '%'); }
    else if (chg5 < 0) { sShort -= 1; shortNotes.push('近 5 日累计下跌 ' + Math.abs(chg5) + '%'); }
  }
  if (ind.volRatio !== null && ind.volRatio !== undefined) {
    shortNotes.push('成交量为 10 日均量的 ' + ind.volRatio + ' 倍' +
      (ind.volRatio >= 1.5 ? '（放量）' : ind.volRatio <= 0.6 ? '（缩量）' : '（平量）'));
    if (ind.volRatio >= 1.5 && chg5 !== null && chg5 > 0) sShort += 1;
    if (ind.volRatio >= 1.5 && chg5 !== null && chg5 < 0) sShort -= 1;
  }
  if (ind.rsi14 !== null) {
    if (ind.rsi14 >= 70) { sShort -= 1; shortNotes.push('RSI ' + ind.rsi14 + ' 已超买'); }
    if (ind.rsi14 <= 30) { sShort += 1; shortNotes.push('RSI ' + ind.rsi14 + ' 已超卖'); }
  }

  // 中期
  const midNotes = [];
  let sMid = 0;
  if (Number.isFinite(ind.ma20) && Number.isFinite(ind.ma60)) {
    if (ind.ma20 > ind.ma60) { sMid += 1; midNotes.push('MA20（' + ind.ma20 + '）在 MA60（' + ind.ma60 + '）上方，中期结构偏多'); }
    else { sMid -= 1; midNotes.push('MA20（' + ind.ma20 + '）低于 MA60（' + ind.ma60 + '），中期结构偏空'); }
    if (last > ind.ma60) { sMid += 1; midNotes.push('收盘站在 MA60 上方，中期未破位'); }
    else { sMid -= 1; midNotes.push('收盘位于 MA60 下方，中期结构走弱'); }
  }
  if (chg20 !== null) {
    if (chg20 > 0) { sMid += 1; midNotes.push('近 20 日累计上涨 ' + chg20 + '%'); }
    else if (chg20 < 0) { sMid -= 1; midNotes.push('近 20 日累计下跌 ' + Math.abs(chg20) + '%'); }
  }
  if (ind.macdHist !== null && ind.macdHist !== undefined) {
    midNotes.push('MACD 柱 ' + ind.macdHist + (ind.macdHist > 0 ? '（红柱）' : '（绿柱）') +
      '，DIF ' + ind.dif + ' / DEA ' + ind.dea);
  }

  const pos20 = ind.rangePosition20;
  const pos60 = keyLevels(bars) ? Math.round(((last - Math.min.apply(null, bars.slice(-60).map((b) => b.low))) /
    (Math.max.apply(null, bars.slice(-60).map((b) => b.high)) - Math.min.apply(null, bars.slice(-60).map((b) => b.low)) || 1)) * 100) : null;

  return {
    short: { label: '短期（5～10 日）', verdict: verdictOf(sShort), score: sShort, notes: shortNotes },
    mid: { label: '中期（20～60 日）', verdict: verdictOf(sMid), score: sMid, notes: midNotes },
    position: {
      pos20: pos20,
      pos60: pos60,
      read: pos20 === null ? '' : pos20 >= 85 ? '处于近 20 日高位区，追高性价比低'
        : pos20 <= 20 ? '处于近 20 日低位区，需先确认止跌' : '处于近 20 日区间中部，位置相对合理'
    }
  };
}

/** 一句话结论（措辞刻意保守，只描述形态）。 */
function summarize(agg, horizons, levels, tech) {
  const parts = [];
  // tech.trend 本身已带「技术面」前缀（技术面偏多/中性/偏空）
  parts.push((tech.trend || '技术面中性') + '（多头信号 ' + tech.bull + ' / 空头信号 ' + tech.bear + '）');
  parts.push('短期' + horizons.short.verdict + '、中期' + horizons.mid.verdict);
  if (agg.fail > 0) parts.push('有 ' + agg.fail + ' 条规则不通过，按纪律应先排除或等形态修复');
  else if (agg.warn > 0) parts.push('有 ' + agg.warn + ' 条规则需要留意');
  if (levels && levels.refStop) parts.push('若参与，参考止损 ' + levels.refStop + '（' + levels.stopPct + '%），仓位上限约 ' + levels.maxPositionPct + '%');
  return parts.join('；') + '。';
}

/** 单只个股的走势分析。 */
async function analyzeTrend(code) {
  const c = String(code).replace(/\D/g, '');
  return cached('advice:trend:' + c, 120000, async () => {
    const bars = await loadBars(c);
    if (!bars.length || bars.length < 30) {
      return { code: c, ready: false, error: 'K 线数据不足（少于 30 根），无法做走势判定' };
    }
    const ctx = buildContext(bars);
    const checks = runRules(ctx);
    const agg = scoreOf(checks);
    const levels = keyLevels(bars);
    const horizons = horizonRead(bars);
    const tech = ctx.tech;
    const name = (await ths.fetchQuote(c).catch(() => null) || {}).name || '';
    return {
      code: c,
      name: name,
      ready: true,
      updatedAt: new Date().toISOString(),
      bars: bars.length,
      range: bars[0].date + ' ~ ' + bars[bars.length - 1].date,
      tech: tech,
      checks: checks,
      counts: agg,
      keyLevels: levels,
      horizons: horizons,
      bullish: (tech.signals || []).filter((s) => s.type === 'bullish').slice(0, 6),
      bearish: (tech.signals || []).filter((s) => s.type === 'bearish').slice(0, 6),
      summary: summarize(agg, horizons, levels, tech),
      disclaimer: DISCLAIMER
    };
  });
}

/** 并发受限的 map，避免一次打太多请求把上游惹毛。 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * 选股建议：先用选股器圈出一个池子，再对池子里前 N 只做技术面规则体检并排序。
 */
async function suggest(options) {
  const o = options || {};
  const presetId = o.preset && screener.PRESETS[o.preset] ? o.preset : 'momentum';
  const preset = screener.PRESETS[presetId];
  const limit = Math.max(1, Math.min(20, Number(o.limit) || 8));
  const pages = Math.max(1, Math.min(6, Number(o.pages) || 2));

  return cached('advice:suggest:' + presetId + ':' + limit + ':' + pages, 120000, async () => {
    let scan = await screener.screen({ preset: presetId, pages: pages, limit: 60 });
    let relaxed = false;
    if (!scan.results.length) {
      // 普跌行情里「强势动量」这类严格条件常常一只都挑不出来。与其给一个空页面，
      // 不如退化成「相对强势」口径，并在说明里写清楚这是放宽后的观察名单。
      relaxed = true;
      scan = await screener.screen({
        sort: 'changepercent', asc: 0, pages: pages, limit: 60,
        excludeSt: true, minMarketCapYi: 20, maxMarketCapYi: 3000
      });
    }
    const analyzeCount = Math.min(scan.results.length, Math.max(limit * 2, 10), 16);
    const subset = scan.results.slice(0, analyzeCount);

    const rows = await mapLimit(subset, 4, async (row) => {
      const bars = await loadBars(row.code).catch(() => []);
      if (!bars.length || bars.length < 30) return null;
      const ctx = buildContext(bars, { change1Pct: row.changePct });
      const checks = runRules(ctx);
      const agg = scoreOf(checks);
      const levels = keyLevels(bars);
      return {
        code: row.code,
        name: row.name,
        price: row.price,
        changePct: row.changePct,
        turnoverRate: row.turnoverRate,
        pe: row.pe,
        pb: row.pb,
        marketCapYi: row.marketCapYi,
        amountYuan: row.amountYuan,
        bars: bars.length,
        counts: agg,
        checks: checks,
        keyLevels: levels,
        horizons: horizonRead(bars),
        tech: {
          trend: ctx.tech.trend,
          bull: ctx.tech.bull,
          bear: ctx.tech.bear,
          signals: (ctx.tech.signals || []).slice(0, 8)
        }
      };
    });

    const candidates = rows.filter(Boolean).sort((a, b) =>
      (b.counts.score - a.counts.score) || ((b.changePct || 0) - (a.changePct || 0)));

    return {
      updatedAt: new Date().toISOString(),
      preset: { id: presetId, label: preset.label, describe: preset.describe },
      presets: Object.entries(screener.PRESETS).map(([id, p]) => ({ id: id, label: p.label, describe: p.describe })),
      source: scan.source,
      scanned: scan.scanned,
      pool: scan.results.length,
      analyzed: candidates.length,
      relaxed: relaxed,
      note: (relaxed
        ? '「' + preset.label + '」（' + preset.describe + '）在本次扫描范围内一只都没命中，已退化为「相对强势」口径：' +
          '剔除 ST、市值 ≥20 亿、按当日涨幅排序取前若干只。这只是把观察范围缩小，不代表可以直接买入。'
        : '') +
        '本次只用 K 线可判定的 5 条技术面规则评分；舆情／股吧／资金流规则需要逐只单独取数，' +
        '在批量扫描中标为「不适用」，未计入得分。点开个股体检可以看到全部 8 条。',
      results: candidates.slice(0, limit),
      disclaimer: DISCLAIMER
    };
  });
}

module.exports = { analyzeTrend, suggest, loadBars, buildContext, runRules, scoreOf, keyLevels, horizonRead, RULE_LABEL, DISCLAIMER };
