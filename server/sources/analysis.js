'use strict';

const quotes = require('./quotes');
const ths = require('./ths');
const indicators = require('../lib/indicators');
const news = require('./news');
const guba = require('./guba');
const market = require('./market');

/**
 * 个股体检：把「技术指标 + 舆情 + 股吧情绪 + 资金流」按知识库规则逐条判定。
 *
 * 设计原则：
 *  - 每条结论都要能追溯到具体数值或规则出处，不做黑箱打分；
 *  - 明确区分「事实」（价格、成交量、资金流）与「解释」（规则判定）；
 *  - 不给买卖建议，只输出「是否满足你自己写下的规则」。
 */

const PLAYBOOK_RULES = [
  {
    id: 'trend-above-ma20',
    from: '趋势与买卖点 / 均线',
    rule: '收盘价站稳 MA20 且 MA20 方向向上，才属于可持有的上升结构',
    evaluate: (d) => {
      const ind = d.tech.indicators;
      if (!ind || ind.ma20 === null) return { status: 'na', detail: '均线数据不足' };
      const above = d.last.close >= ind.ma20;
      const rising = d.ma20SlopePct !== null && d.ma20SlopePct > 0;
      if (above && rising) return { status: 'pass', detail: '收盘 ' + d.last.close + ' 站上 MA20 ' + ind.ma20 + '，MA20 近 5 日上行 ' + d.ma20SlopePct + '%' };
      if (above && !rising) return { status: 'warn', detail: '价格在 MA20 上方但 MA20 走平或下行（' + d.ma20SlopePct + '%），结构不稳' };
      return { status: 'fail', detail: '收盘 ' + d.last.close + ' 低于 MA20 ' + ind.ma20 + '，不属于上升结构' };
    }
  },
  {
    id: 'not-falling-knife',
    from: '趋势与买卖点',
    rule: '不接下跌趋势中的便宜货：均线空头排列时不参与',
    evaluate: (d) => {
      const ind = d.tech.indicators;
      if (!ind || ind.ma5 === null || ind.ma10 === null || ind.ma20 === null) return { status: 'na', detail: '均线数据不足' };
      if (ind.ma5 < ind.ma10 && ind.ma10 < ind.ma20) return { status: 'fail', detail: 'MA5<MA10<MA20 空头排列，属于应回避的下跌结构' };
      return { status: 'pass', detail: '未构成空头排列' };
    }
  },
  {
    id: 'volume-confirm',
    from: 'K线信号 / 量价',
    rule: '突破需要放量确认（成交量 ≥ 10 日均量的 1.5 倍）',
    evaluate: (d) => {
      const ind = d.tech.indicators;
      if (!ind || ind.volRatio === null) return { status: 'na', detail: '量能数据不足' };
      const broke = (d.tech.signals || []).some((s) => s.text.indexOf('放量突破') >= 0);
      if (broke) return { status: 'pass', detail: '出现放量突破信号（量能为 10 日均量 ' + ind.volRatio + ' 倍）' };
      if (ind.volRatio >= 1.5) return { status: 'pass', detail: '成交量为 10 日均量 ' + ind.volRatio + ' 倍，具备放量条件' };
      return { status: 'warn', detail: '成交量为 10 日均量 ' + ind.volRatio + ' 倍，未达放量标准，突破需谨慎' };
    }
  },
  {
    id: 'not-chasing-high',
    from: '股剩是怎么炼成的 / 反人性',
    rule: '不买在情绪顶部：20 日区间位置过高且指标过热时应回避',
    evaluate: (d) => {
      const ind = d.tech.indicators;
      if (!ind || ind.rangePosition20 === null || ind.rangePosition20 === undefined) return { status: 'na', detail: '区间数据不足' };
      const pos = ind.rangePosition20;
      const overheated = (ind.j !== null && ind.j > 100) || (ind.rsi14 !== null && ind.rsi14 >= 70);
      if (pos >= 85 && overheated) return { status: 'fail', detail: '处于 20 日区间 ' + pos + '% 高位且指标过热（J 或 RSI 超买），属于追高风险区' };
      if (pos >= 85) return { status: 'warn', detail: '处于 20 日区间 ' + pos + '% 高位，追高性价比低' };
      if (pos <= 20) return { status: 'warn', detail: '处于 20 日区间 ' + pos + '% 低位，需先确认止跌信号' };
      return { status: 'pass', detail: '处于 20 日区间 ' + pos + '%，位置相对合理' };
    }
  },
  {
    id: 'sentiment-price-consistency',
    from: '交易心理分析 / 一致性',
    rule: '舆情与价格应相互印证，出现背离时降低信任度',
    evaluate: (d) => {
      if (!d.newsSentiment) return { status: 'na', detail: '无舆情样本' };
      const s = d.newsSentiment.score;
      const chg5 = d.change5Pct;
      if (s >= 20 && chg5 !== null && chg5 < -3) return { status: 'fail', detail: '舆情偏多（' + s + '）但近 5 日下跌 ' + chg5 + '%，存在负背离' };
      if (s <= -20 && chg5 !== null && chg5 > 3) return { status: 'warn', detail: '舆情偏空（' + s + '）但近 5 日上涨 ' + chg5 + '%，利好可能已兑现' };
      return { status: 'pass', detail: '舆情（' + s + '）与近 5 日涨跌（' + chg5 + '%）未出现明显背离' };
    }
  },
  {
    id: 'guba-crowding',
    from: '股吧情绪（辅助）',
    rule: '股吧极度一致时需警惕（散户一致预期常是反向指标）',
    evaluate: (d) => {
      if (!d.guba || !d.guba.sentiment || d.guba.count < 8) return { status: 'na', detail: '股吧样本不足' };
      const s = d.guba.sentiment.score;
      if (s >= 45) return { status: 'warn', detail: '股吧情绪极度乐观（' + s + '），一致性偏高，注意反向风险' };
      if (s <= -45) return { status: 'warn', detail: '股吧情绪极度悲观（' + s + '），恐慌一致性偏高' };
      return { status: 'pass', detail: '股吧情绪（' + s + '）未达极端' };
    }
  },
  {
    id: 'fund-flow',
    from: '看盘方法和技巧 / 资金',
    rule: '主力资金净流入方向与价格方向一致时信号更可靠',
    evaluate: (d) => {
      if (!d.fundFlow) return { status: 'na', detail: '无资金流数据' };
      const net = d.fundFlow.mainNet;
      const yi = (net / 1e8).toFixed(2);
      const chg = d.change1Pct;
      if (net > 0 && chg !== null && chg > 0) return { status: 'pass', detail: '主力净流入 ' + yi + ' 亿元，与当日上涨方向一致' };
      if (net < 0 && chg !== null && chg < 0) return { status: 'pass', detail: '主力净流出 ' + yi + ' 亿元，与当日下跌方向一致' };
      if (net < 0 && chg !== null && chg > 0) return { status: 'warn', detail: '价格上涨但主力净流出 ' + yi + ' 亿元，需警惕承接不足' };
      return { status: 'warn', detail: '价格下跌但主力净流入 ' + yi + ' 亿元，可能是吸筹也可能是被动接盘' };
    }
  },
  {
    id: 'stop-loss-plan',
    from: '风控与仓位',
    rule: '下单前必须定义止损价，且单笔风险不超过总资金 2%',
    evaluate: (d) => {
      const ind = d.tech.indicators;
      if (!ind || ind.ma20 === null) return { status: 'na', detail: '无法计算参考止损位' };
      const refStop = Number((ind.ma20 * 0.98).toFixed(2));
      const stopPct = Number((((d.last.close - refStop) / d.last.close) * 100).toFixed(2));
      if (!(stopPct > 0)) return { status: 'na', detail: '止损幅度异常（现价已低于参考止损位），请人工复核' };
      // 两条约束必须同时满足，取更严的那一个：
      //   1) 单笔风险 <= 总资金 2%   -> 仓位 <= 2% / 止损幅度
      //   2) 单只个股 <= 总仓位 30%
      const byRiskPct = Number(((2 / stopPct) * 100).toFixed(1));
      const finalPct = Number(Math.min(30, byRiskPct).toFixed(1));
      const binding = byRiskPct <= 30 ? '由单笔 2% 风险上限决定' : '由单只 30% 集中度上限决定';
      return {
        status: finalPct < 30 ? 'warn' : 'info',
        detail: '以 MA20 下方 2% 作为参考止损位 ' + refStop + '（距现价 ' + stopPct + '%）；' +
          '同时满足「单笔风险 ≤ 2%」与「单只 ≤ 30%」两条规则后，最大仓位约为总资金的 ' + finalPct + '%（' + binding + '）'
      };
    }
  }
];

async function analyzeStock(code) {
  const c = String(code).replace(/\D/g, '');
  const [quote, daily, kline, flow] = await Promise.all([
    ths.fetchQuote(c).catch(() => null),
    ths.fetchDaily(c, 260).catch(() => null),
    quotes.getKline(c, 260).catch(() => []),
    market.getFundFlow([c]).catch(() => [])
  ]);

  const bars = (kline && kline.length ? kline : (daily ? daily.rows : [])) || [];
  if (!bars.length) return { code: c, ready: false, error: '未取得 K 线数据，无法体检' };

  const name = (quote && quote.name) || (daily && daily.name) || '';
  const [stockNews, board] = await Promise.all([
    news.getStockNews(name, c, 15).catch(() => ({ items: [], sentiment: null })),
    guba.fetchBoard(c, 40).catch(() => null)
  ]);

  const tech = indicators.analyze(bars);
  const closes = bars.map((b) => b.close);

  // 个股体检页的「日 K 线」卡片要用：只回传最近 120 根，尽量少占带宽。
  // MA 用**全量**收盘价算完再按同一窗口切，这样窗口最左边几根的均线也是真值，
  // 不会因为「从窗口内重新起算」而出现一段假的抬头。
  const KLINE_OUT = 120;
  const klineOut = bars.slice(-KLINE_OUT);
  const winFrom = Math.max(0, bars.length - KLINE_OUT);
  const maForChart = {
    ma5: indicators.sma(closes, 5).slice(winFrom),
    ma10: indicators.sma(closes, 10).slice(winFrom),
    ma20: indicators.sma(closes, 20).slice(winFrom)
  };
  const i = bars.length - 1;
  const last = bars[i];
  const ma20Series = indicators.sma(closes, 20);
  const ma20Now = ma20Series[i];
  const ma20Prev = ma20Series[i - 5];
  const ma20SlopePct = ma20Now && ma20Prev ? Number((((ma20Now - ma20Prev) / ma20Prev) * 100).toFixed(2)) : null;
  const change5Pct = bars.length >= 6 ? Number(((last.close / bars[i - 5].close - 1) * 100).toFixed(2)) : null;

  const d = {
    tech,
    last,
    ma20SlopePct,
    change5Pct,
    change1Pct: quote ? quote.changePct : null,
    newsSentiment: stockNews.sentiment,
    guba: board,
    fundFlow: flow[0] || null
  };

  const checks = PLAYBOOK_RULES.map((r) => {
    const res = r.evaluate(d);
    return { id: r.id, rule: r.rule, from: r.from, status: res.status, detail: res.detail };
  });

  const pass = checks.filter((x) => x.status === 'pass').length;
  const warn = checks.filter((x) => x.status === 'warn').length;
  const fail = checks.filter((x) => x.status === 'fail').length;
  const verdictScore = pass * 2 - warn - fail * 3;
  const verdict = verdictScore >= 4 ? '规则面偏多' : verdictScore <= -2 ? '规则面偏空' : '规则面中性';

  return {
    code: c,
    name,
    ready: true,
    updatedAt: new Date().toISOString(),
    quote,
    quoteSource: quote ? '同花顺' : null,
    tech,
    kline: klineOut,
    ma: maForChart,
    checks,
    counts: { pass, warn, fail, na: checks.filter((x) => x.status === 'na').length },
    verdict,
    verdictScore,
    news: { sentiment: stockNews.sentiment, items: stockNews.items.slice(0, 12) },
    guba: board
      ? { count: board.count, sentiment: board.sentiment, hotWords: board.hotWords, posts: board.posts.slice(0, 15), url: board.url, disclaimer: board.disclaimer }
      : null,
    fundFlow: d.fundFlow,
    disclaimer: '本体检仅按你知识库中的规则做一致性检查，输出的是「是否满足自定规则」，不构成买卖建议。'
  };
}

module.exports = { analyzeStock, PLAYBOOK_RULES };
