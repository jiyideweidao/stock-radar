'use strict';
/** 离线自检：不依赖外网，验证情绪引擎、煤炭台账、期货解析等核心逻辑。 */
const assert = require('assert');
const sentiment = require('../server/lib/sentiment');
const { unwrapJsonp } = require('../server/lib/http');
const coal = require('../server/sources/coal');
const futures = require('../server/sources/futures');
const coalImport = require('../server/sources/coalImport');
const indicators = require('../server/lib/indicators');
const guba = require('../server/sources/guba');
const analysis = require('../server/sources/analysis');
const advice = require('../server/sources/advice');
const market = require('../server/sources/market');
const embed = require('../server/sources/embed');
const translate = require('../server/lib/translate');
const net = require('../server/lib/net');
const qr = require('../server/lib/qr');

/* --- Reed-Solomon 独立校验工具：不复用 qr.js 里的实现，另写一份做交叉验证 --- */

const RS_EXP = new Uint8Array(512);
const RS_LOG = new Uint8Array(256);
(function rsInit() {
  let x = 1;
  for (let i = 0; i < 255; i++) { RS_EXP[i] = x; RS_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) RS_EXP[i] = RS_EXP[i - 255];
})();
function rsMul(a, b) { return a === 0 || b === 0 ? 0 : RS_EXP[RS_LOG[a] + RS_LOG[b]]; }

/** 生成多项式 (x-a^0)(x-a^1)...，最高次项在前，首项为 1。 */
function rsGeneratorPoly(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= rsMul(g[j], RS_EXP[i]); }
    g = next;
  }
  return g;
}

/** 码字多项式能否被生成多项式整除（长除法余数为全 0）。 */
function rsDivides(words, gen) {
  const buf = words.slice();
  for (let i = 0; i + gen.length <= buf.length; i++) {
    const factor = buf[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= rsMul(gen[j], factor);
  }
  return buf.slice(buf.length - gen.length + 1).every((b) => b === 0);
}

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('  OK  ' + name); }
  catch (err) { console.error('  FAIL ' + name + ' -> ' + err.message); process.exitCode = 1; }
}

console.log('情绪引擎');
check('利好文本得正分', () => {
  const r = sentiment.analyze('公司中标大额订单，净利润增长超预期，机构上调评级');
  assert.ok(r.score > 40, '期望强利好，实际 ' + r.score);
  assert.ok(r.hits.some((h) => h.term === '中标'));
});
check('利空文本得负分', () => {
  const r = sentiment.analyze('公司被立案调查，商誉减值，股东大幅减持');
  assert.ok(r.score < -40, '期望强利空，实际 ' + r.score);
});
check('否定词翻转极性', () => {
  const negated = sentiment.analyze('该股未涨停').score;
  const plain = sentiment.analyze('该股涨停').score;
  assert.ok(plain > 0, '未取反时应为正值: ' + plain);
  assert.ok(negated < 0, '取反后应为负值: ' + negated);
});
check('中性文本接近 0', () => {
  assert.strictEqual(sentiment.analyze('今日天气晴朗，公司召开例会').score, 0);
});
check('时间衰减聚合：新消息权重更高', () => {
  const fresh = { sentiment: sentiment.analyze('涨停'), timestamp: new Date().toISOString() };
  const old = { sentiment: sentiment.analyze('跌停'), timestamp: new Date(Date.now() - 30 * 86400000).toISOString() };
  const agg = sentiment.aggregate([old, fresh]);
  assert.ok(agg.score > 0, '近期利好应主导，实际 ' + agg.score);
});

console.log('JSONP 解析');
check('剥掉 cb(...) 包装', () => {
  assert.strictEqual(unwrapJsonp('cb({"a":1})'), '{"a":1}');
});
check('剥掉 var x=([...]) 与 script 前缀', () => {
  const raw = '/*<script>location.href="//sina.com";</script>*/\nvar _CF0=([{"d":"2005-01-04"}]);';
  assert.strictEqual(unwrapJsonp(raw), '[{"d":"2005-01-04"}]');
});

console.log('期货行情解析');
check('解析 nf_ 字段位并识别空合约', () => {
  const text = 'var hq_str_nf_CF0="棉花连续,150000,15825.000,15905.000,15785.000,15835.000,15835.000,15840.000,15835.000,15840.000,15795.000,1,256,547146.000,256818,郑,棉花,2026-09-24,1";\nvar hq_str_nf_ZC0="";';
  const rows = futures.parseSinaFutures(text);
  const cf = rows.find((r) => r.symbol === 'CF0');
  assert.strictEqual(cf.last, 15835);
  assert.strictEqual(cf.prevClose, 15795);
  assert.strictEqual(cf.change, 40);
  assert.strictEqual(cf.openInterest, 547146);
  assert.strictEqual(rows.find((r) => r.symbol === 'ZC0').available, false);
});

console.log('煤炭台账');
check('解析 CSV 并跳过表头', () => {
  const rows = coal.parseCsv('date,port,metric,value,unit,source\n2026-09-01,秦皇岛港,库存,500.5,万吨,手录');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].value, 500.5);
});
check('构建柱状图序列与环比', () => {
  const csv = [
    'date,port,metric,value,unit,source',
    '2026-09-01,秦皇岛港,库存,500,万吨,示例数据',
    '2026-09-08,秦皇岛港,库存,530,万吨,示例数据',
    '2026-09-01,曹妃甸港,库存,400,万吨,示例数据',
    '2026-09-08,曹妃甸港,库存,380,万吨,示例数据'
  ].join('\n');
  const series = coal.buildSeries(coal.parseCsv(csv));
  const qhd = series.ports.find((p) => p.port === '秦皇岛港');
  assert.strictEqual(qhd.latest.value, 530);
  assert.strictEqual(qhd.delta, 30);
  assert.strictEqual(series.totals[1].value, 910);
  assert.strictEqual(series.provenance.containsSampleData, true);
});
check('从新闻正文抽取库存与煤价读数', () => {
  const items = [{
    title: '秦皇岛港煤炭库存升至542.5万吨',
    summary: '5500大卡动力煤报987元/吨，市场情绪回暖。',
    timestamp: '2026-09-26T10:00:00+08:00'
  }];
  const ex = coal.extractFromNews(items);
  assert.strictEqual(ex.inventoryPoints.length, 1);
  assert.strictEqual(ex.inventoryPoints[0].port, '秦皇岛港');
  assert.strictEqual(ex.inventoryPoints[0].value, 542.5);
  assert.strictEqual(ex.pricePoints[0].value, 987);
});


console.log('技术指标');
check('MA / EMA 等长返回并以 null 填充起始段', () => {
  assert.deepStrictEqual(indicators.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = indicators.ema([1, 2, 3], 2);
  assert.strictEqual(e.length, 3);
  assert.ok(e[0] < e[1] && e[1] < e[2]);
});
check('MACD 在持续上涨序列中 DIF 与柱为正', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 10 + i * 0.2);
  const m = indicators.macd(closes);
  assert.strictEqual(m.dif.length, 60);
  assert.ok(m.dif[59] > 0, 'DIF 应为正，实际 ' + m.dif[59]);
  assert.ok(m.hist[59] > 0, '柱应为正，实际 ' + m.hist[59]);
});
check('KDJ 在单边下跌中 K 值偏低、J 低于 D', () => {
  const kline = Array.from({ length: 20 }, (_, i) => ({ open: 20 - i, high: 20 - i, low: 19 - i, close: 19.5 - i, volume: 1000 }));
  const r = indicators.kdj(kline, 9, 3, 3);
  assert.ok(r.k[19] < 50, 'K 应偏低，实际 ' + r.k[19]);
  assert.ok(r.j[19] < r.d[19], '下跌段 J 应低于 D，实际 J=' + r.j[19] + ' D=' + r.d[19]);
});
check('RSI 全涨为 100、全跌趋近 0', () => {
  assert.strictEqual(indicators.rsi(Array.from({ length: 20 }, (_, i) => 10 + i), 14)[19], 100);
  assert.ok(indicators.rsi(Array.from({ length: 20 }, (_, i) => 30 - i), 14)[19] < 1);
});
check('BOLL 满足 上轨 > 中轨 > 下轨', () => {
  const b = indicators.boll(Array.from({ length: 40 }, (_, i) => 10 + Math.sin(i / 3) * 2), 20, 2);
  assert.ok(b.upper[39] > b.mid[39] && b.mid[39] > b.lower[39]);
});
check('analyze：数据不足时 ready=false', () => {
  assert.strictEqual(indicators.analyze([{ open: 1, high: 1, low: 1, close: 1, volume: 1 }]).ready, false);
});
check('analyze：多空计数与信号表一致', () => {
  const kline = Array.from({ length: 80 }, (_, i) => {
    const c = 10 + i * 0.1;
    return { open: c - 0.05, high: c + 0.1, low: c - 0.1, close: c, volume: 1000 + i * 20 };
  });
  const r = indicators.analyze(kline);
  assert.strictEqual(r.ready, true);
  assert.ok(r.signals.length > 0);
  assert.strictEqual(r.bull, r.signals.filter((s) => s.type === 'bullish').length);
  assert.strictEqual(r.bear, r.signals.filter((s) => s.type === 'bearish').length);
  assert.ok(/偏多|中性|偏空/.test(r.trend));
});

console.log('股吧情绪');
check('口语化看多 / 看空词识别', () => {
  assert.ok(guba.gubaSentiment('明天涨停，主力要拉升了').score > 0);
  assert.ok(guba.gubaSentiment('垃圾股，割肉跑路').score < 0);
});
check('热词统计剔除股票名片段与纯数字', () => {
  const words = guba.topWords(['郑州煤电明天要涨停', '郑州煤电又是涨停', '600121 明天涨停'], 10, '郑州煤电');
  assert.ok(words.some((w) => w.word === '涨停' && w.count >= 3), JSON.stringify(words));
  assert.ok(!words.some((w) => w.word.indexOf('煤电') >= 0 || w.word.indexOf('郑州') >= 0), JSON.stringify(words));
});

console.log('煤炭进口抽取');
check('三种语序可抽取，无月份时不臆造月份', () => {
  const r = coalImport.extractFromNews([
    { title: '8月份，我国进口煤炭4209万吨，同比下降1.5%', timestamp: '2026-09-27T10:00:00+08:00' },
    { title: '进口煤炭4209万吨', timestamp: '2026-09-27T10:00:00+08:00' },
    { title: '8月中国炼焦煤进口量为1345.6万吨', timestamp: '2026-09-10T10:00:00+08:00' }
  ]);
  assert.strictEqual(r.importPoints.length, 2, JSON.stringify(r.importPoints));
  const c = r.importPoints.find((p) => p.variety === '煤及褐煤');
  assert.strictEqual(c.period, '2026-08');
  assert.strictEqual(c.value10kt, 4209);
  assert.strictEqual(c.yoyPct, -1.5);
  assert.strictEqual(r.importPoints.find((p) => p.variety === '炼焦煤').value10kt, 1345.6);
});
check('次年 1 月报道的 12 月数据归入上一年', () => {
  const r = coalImport.extractFromNews([{ title: '12月份，我国进口煤炭5800万吨', timestamp: '2026-01-20T10:00:00+08:00' }]);
  assert.strictEqual(r.importPoints[0].period, '2025-12');
});
check('非煤炭品种不被误抽', () => {
  const r = coalImport.extractFromNews([{ title: '乙二醇进口量为120万吨', timestamp: '2026-09-10T10:00:00+08:00' }]);
  assert.strictEqual(r.importPoints.length, 0);
});
check('进口月度台账可解析并计算同比', () => {
  const rows = coalImport.parseCsv([
    'period,variety,value_10kt,yoy_pct,amount_usd,source',
    '2025-08,煤及褐煤,3800,-5,100,示例数据',
    '2026-08,煤及褐煤,3385.8,-10.8,90,示例数据'
  ].join('\n'));
  const series = coalImport.buildSeries(rows);
  const g = series.groups.find((x) => x.variety === '煤及褐煤');
  assert.strictEqual(g.latest.value, 3385.8);
  assert.strictEqual(g.yoyComputed, -10.9);
  assert.strictEqual(series.provenance.containsSampleData, true);
});

console.log('知识库规则');
check('8 条规则、id 唯一、字段完整', () => {
  const ids = analysis.PLAYBOOK_RULES.map((r) => r.id);
  assert.strictEqual(ids.length, 8, ids.join(','));
  assert.strictEqual(new Set(ids).size, 8);
  for (const r of analysis.PLAYBOOK_RULES) assert.ok(r.rule && r.from && typeof r.evaluate === 'function', r.id);
});
check('输入缺失时返回 na 而不是抛错', () => {
  for (const r of analysis.PLAYBOOK_RULES) {
    const res = r.evaluate({ tech: { indicators: null, signals: [] }, last: null });
    assert.strictEqual(res.status, 'na', r.id + ' -> ' + JSON.stringify(res));
  }
});
check('趋势规则：站上上行 MA20 判 pass，跌破判 fail，走平判 warn', () => {
  const rule = analysis.PLAYBOOK_RULES.find((r) => r.id === 'trend-above-ma20');
  const base = { tech: { indicators: { ma20: 10 } }, last: { close: 10.5 }, ma20SlopePct: 1.2 };
  assert.strictEqual(rule.evaluate(base).status, 'pass');
  assert.strictEqual(rule.evaluate({ ...base, last: { close: 9.5 } }).status, 'fail');
  assert.strictEqual(rule.evaluate({ ...base, ma20SlopePct: -0.5 }).status, 'warn');
});
check('不接飞刀：空头排列判 fail，多头排列判 pass', () => {
  const rule = analysis.PLAYBOOK_RULES.find((r) => r.id === 'not-falling-knife');
  assert.strictEqual(rule.evaluate({ tech: { indicators: { ma5: 8, ma10: 9, ma20: 10 } } }).status, 'fail');
  assert.strictEqual(rule.evaluate({ tech: { indicators: { ma5: 10, ma10: 9.5, ma20: 9 } } }).status, 'pass');
});
check('追高规则：高位过热判 fail，中位判 pass', () => {
  const rule = analysis.PLAYBOOK_RULES.find((r) => r.id === 'not-chasing-high');
  assert.strictEqual(rule.evaluate({ tech: { indicators: { rangePosition20: 92, j: 110, rsi14: 78 } } }).status, 'fail');
  assert.strictEqual(rule.evaluate({ tech: { indicators: { rangePosition20: 50, j: 50, rsi14: 50 } } }).status, 'pass');
});
check('风控规则：止损幅度越大允许仓位越小且不超过 30%', () => {
  const rule = analysis.PLAYBOOK_RULES.find((r) => r.id === 'stop-loss-plan');
  const tight = rule.evaluate({ tech: { indicators: { ma20: 10 } }, last: { close: 10.2 } });
  const wide = rule.evaluate({ tech: { indicators: { ma20: 10 } }, last: { close: 11 } });
  assert.strictEqual(tight.status, 'info');
  assert.strictEqual(wide.status, 'warn');
  assert.ok(wide.detail.indexOf('18.3') >= 0, wide.detail);
});
check('舆情 / 股吧一致性规则可识别背离与极端', () => {
  const cons = analysis.PLAYBOOK_RULES.find((r) => r.id === 'sentiment-price-consistency');
  assert.strictEqual(cons.evaluate({ newsSentiment: { score: 30 }, change5Pct: -5 }).status, 'fail');
  assert.strictEqual(cons.evaluate({ newsSentiment: { score: 5 }, change5Pct: -1 }).status, 'pass');
  const crowd = analysis.PLAYBOOK_RULES.find((r) => r.id === 'guba-crowding');
  assert.strictEqual(crowd.evaluate({ guba: { count: 20, sentiment: { score: 50 } } }).status, 'warn');
  assert.strictEqual(crowd.evaluate({ guba: { count: 20, sentiment: { score: 3 } } }).status, 'pass');
  assert.strictEqual(crowd.evaluate({ guba: { count: 2, sentiment: { score: 50 } } }).status, 'na');
});


console.log('英文快讯机翻');
check('只翻英文稿：中文条目一条都不发请求', () => {
  assert.strictEqual(translate.needsTranslation('棉花期货主力合约涨停，新疆棉加工进度加快'), false);
  assert.strictEqual(translate.needsTranslation('央行今日开展 5000 亿元 MLF 操作'), false);
  assert.strictEqual(translate.needsTranslation('CPI 3.2%'), false, '纯数字短串不该当英文稿');
  assert.strictEqual(translate.needsTranslation('AAPL'), false, '太短的不翻');
  assert.strictEqual(translate.needsTranslation('UBS raises Marvell Technology price target to 335 from 310.'), true);
  assert.strictEqual(translate.needsTranslation('Trump to announce a 15 billion dollar Iowa steel plant plan'), true);
});
check('括号里的英文股票代码先摘掉再翻', () => {
  assert.strictEqual(
    translate.prepForTranslate('UBS raises Marvell Technology (MRVL.O) price target to 335 from 310.'),
    'UBS raises Marvell Technology price target to 335 from 310.'
  );
  assert.strictEqual(
    translate.prepForTranslate('SpaceX (SPCX.O) said its Starship reached orbit.'),
    'SpaceX said its Starship reached orbit.'
  );
  // 整条就是代码时不硬删，避免翻出空串
  assert.strictEqual(translate.prepForTranslate('(MRVL.O)'), '(MRVL.O)');
});
check('同一件事的两种写法共用一份译文（缓存键一致）', () => {
  const a = translate.cacheKey('UBS raises Marvell Technology (MRVL.O) price target to 335 from 310.');
  const b = translate.cacheKey('UBS   raises Marvell Technology price target to 335 from 310.  ');
  assert.strictEqual(a, b);
});
check('金额与数量级改成中文财经写法', () => {
  const D = String.fromCharCode(36);
  assert.strictEqual(translate.tidy('目标价从310 ' + D + '上调至335 ' + D + '。'), '目标价从310美元上调至335美元。');
  assert.strictEqual(translate.tidy('将宣布' + D + '15 bln美元的钢铁厂计划'), '将宣布150亿美元的钢铁厂计划');
  assert.strictEqual(translate.tidy('产能 20 mln 吨'), '产能2000万吨');
  assert.strictEqual(translate.tidy('投资' + D + '1.5 bln'), '投资15亿美元');
  // 没有货币符号时不要凭空加「美元」
  assert.strictEqual(translate.tidy('出口 15 bln 桶'), '出口150亿桶');
});
check('译文缓存落在 server/data 下，且状态可查', () => {
  const path = require('path');
  const dataDir = path.join(__dirname, '..', 'server', 'data');
  assert.ok(translate.CACHE_FILE.indexOf(dataDir) === 0, '缓存文件必须在 server/data 里: ' + translate.CACHE_FILE);
  const st = translate.stats();
  assert.ok(typeof st.cached === 'number', 'stats().cached 应为数字');
  assert.ok(st.providers && typeof st.providers === 'object', 'stats().providers 应存在');
});

console.log('第三方页面嵌入（金融界）');
check('嵌入白名单只含金融界固定几个页面，不接受任意 URL', () => {
  const items = embed.list();
  assert.strictEqual(items.length, 3);
  items.forEach((x) => {
    assert.ok(x.url.startsWith('https://summary.jrj.com.cn/'), '越界域名: ' + x.url);
    assert.ok(x.id && x.name, '缺 id 或名称');
  });
});
check('未在白名单里的 key 会被明确拒绝', () => {
  assert.throws(() => embed.resolve('../../etc/passwd'), /不支持的嵌入项/);
  assert.throws(() => embed.resolve('http://evil.example.com'), /不支持的嵌入项/);
  assert.throws(() => embed.resolve('__proto__'), /不支持的嵌入项/);
  assert.throws(() => embed.resolve('constructor'), /不支持的嵌入项/);
  assert.throws(() => embed.resolve(undefined), /不支持的嵌入项/);
  assert.strictEqual(embed.resolve('dpyt').url, 'https://summary.jrj.com.cn/dataCenter/dpyt/');
});
check('能识别 X-Frame-Options 的三种写法', () => {
  assert.ok(embed.frameBlock(new Headers({ 'x-frame-options': 'DENY' })));
  assert.ok(embed.frameBlock(new Headers({ 'x-frame-options': 'SAMEORIGIN' })));
  assert.ok(embed.frameBlock(new Headers({ 'x-frame-options': 'sameorigin' })));
  // 金融界「大盘云图」实测就是这个情况：什么限制都没有
  assert.strictEqual(embed.frameBlock(new Headers({})), null);
});
check('能识别 CSP frame-ancestors 限制', () => {
  assert.ok(embed.frameBlock(new Headers({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })));
  assert.ok(embed.frameBlock(new Headers({ 'content-security-policy': "frame-ancestors 'self'" })));
  assert.strictEqual(embed.frameBlock(new Headers({ 'content-security-policy': 'frame-ancestors *' })), null);
  assert.strictEqual(embed.frameBlock(new Headers({ 'content-security-policy': 'frame-ancestors http://127.0.0.1:8787' })), null);
});

console.log('市场数据口径');
check('东方财富 fltt=1 的百分比字段被放大 100 倍，须除回', () => {
  // 上游返回 f184=441 表示 4.41%；不除回就会显示成「主力净占比 1442%」
  assert.strictEqual(market.pctOf(441), 4.41);
  assert.strictEqual(market.pctOf(-936), -9.36);
  assert.strictEqual(market.pctOf('1157'), 11.57);
  assert.strictEqual(market.pctOf(0), 0);
  assert.strictEqual(market.pctOf(undefined), 0);
  assert.strictEqual(market.pctOf(null), 0);
  assert.strictEqual(market.pctOf('abc'), 0);
});

console.log('选股建议 / 走势分析');
/** 造一段可复现的日线序列：dir=1 上行，dir=-1 下行，带轻微震荡以避免 RSI 极端。 */
function fakeSeries(n, dir) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const c = 20 + dir * i * 0.12 + Math.sin(i / 3.5) * 0.6;
    out.push({ date: '2026-01-' + String((i % 28) + 1).padStart(2, '0'), open: c - 0.1, high: c + 0.3, low: c - 0.3, close: c, volume: 1000 + i * 8 });
  }
  return out;
}
check('scoreOf 按 pass*2 - warn - fail*3 计分', () => {
  const agg = advice.scoreOf([{ status: 'pass' }, { status: 'pass' }, { status: 'warn' }, { status: 'fail' }, { status: 'na' }, { status: 'info' }]);
  assert.strictEqual(agg.pass, 2);
  assert.strictEqual(agg.warn, 1);
  assert.strictEqual(agg.fail, 1);
  assert.strictEqual(agg.na, 1);
  assert.strictEqual(agg.score, 2 * 2 - 1 - 3 * 1);
});
check('keyLevels 给出支撑/压力/参考止损/仓位上限', () => {
  const lv = advice.keyLevels(fakeSeries(120, 1));
  assert.ok(lv.last > 0);
  assert.ok(lv.refStop < lv.last, "止损位应低于现价");
  assert.ok(lv.stopPct > 0);
  assert.ok(lv.maxPositionPct > 0 && lv.maxPositionPct <= 30, "仓位上限不得超过 30%");
  assert.ok(lv.supports.every((s) => s.value <= lv.last));
  assert.ok(lv.resistances.every((r) => r.value > lv.last));
  assert.ok(lv.supports.length <= 3 && lv.resistances.length <= 3);
});
check('走势分析：上行判中期偏多、下行判中期偏空', () => {
  const up = advice.horizonRead(fakeSeries(120, 1));
  const down = advice.horizonRead(fakeSeries(120, -1));
  assert.strictEqual(up.mid.verdict, '偏多');
  assert.strictEqual(down.mid.verdict, '偏空');
  assert.ok(up.short.score > down.short.score, "上行序列的短期得分应高于下行序列");
  assert.ok(up.short.notes.length > 0 && up.mid.notes.length > 0);
});
check('批量规则上下文：舆情/股吧/资金流三条如实判为不适用', () => {
  const ctx = advice.buildContext(fakeSeries(120, 1));
  const checks = advice.runRules(ctx);
  assert.strictEqual(checks.length, 8);
  assert.strictEqual(checks.filter((c) => c.status === 'na').length, 3);
  assert.ok(checks.every((c) => c.label && c.detail));
});

console.log('手机访问 / 局域网地址');
check('只枚举真实局域网 IPv4，排除回环与 169.254 假地址', () => {
  const list = net.lanAddresses();
  assert.ok(Array.isArray(list));
  for (const h of list) {
    assert.ok(/^\d{1,3}(\.\d{1,3}){3}$/.test(h.ip), '不是 IPv4: ' + h.ip);
    assert.ok(!/^127\./.test(h.ip), '混进了回环地址: ' + h.ip);
    // 169.254.x.x 是没拿到 DHCP 时的自称地址，看着像 IP 但根本连不通
    assert.ok(!/^169\.254\./.test(h.ip), '混进了 169.254 假地址: ' + h.ip);
    assert.ok(typeof h.iface === 'string' && h.iface.length > 0, '缺少网卡名');
    assert.strictEqual(typeof h.virtual, 'boolean');
    assert.ok(!/^169\.254\./.test(h.ip));
  }
  for (const u of net.lanUrls(8787)) {
    assert.strictEqual(u.url, 'http://' + u.ip + ':8787/?app=1');
  }
  assert.strictEqual(net.lanUrl('192.168.0.9', 8787), 'http://192.168.0.9:8787/?app=1');
  const urls = net.lanUrls(8787);
  assert.ok(urls.every((u) => /^http:\/\/\d/.test(u.url)));
  assert.ok(typeof net.primaryUrl(8787) === 'object' || net.primaryUrl(8787) === null);
  assert.ok(net.firewallNote() === null || net.firewallNote().length > 10, '防火墙提示不能是空话');
  assert.ok(net.virtualNicPattern instanceof RegExp, '虚拟网卡识别规则应导出，便于自检');
});
check('虚拟网卡（VMware / Docker / WSL 等）能被识别出来，不会排在推荐位第一', () => {
  assert.ok(net.virtualNicPattern.test('VMware Network Adapter VMnet1'));
  assert.ok(net.virtualNicPattern.test('vEthernet (WSL (Hyper-V firewall))'));
  assert.ok(net.virtualNicPattern.test('Docker Desktop'));
  assert.ok(!net.virtualNicPattern.test('WLAN'));
  assert.ok(!net.virtualNicPattern.test('以太网'));
  // Tailscale 从「虚拟网卡」里摘出来了：它不是连不通，而是「换网络也能连」
  assert.ok(!net.virtualNicPattern.test('Tailscale'), 'Tailscale 不该再被当成普通虚拟网卡埋到列表最后');
});
check('Tailscale 地址单独归类：名字或 100.64/10 地址都算「异地访问」', () => {
  assert.ok(net.tailscalePattern instanceof RegExp, 'Tailscale 识别规则应导出');
  assert.strictEqual(net.classify('Tailscale', '100.101.102.103').kind, 'tailscale');
  assert.strictEqual(net.classify('以太网', '100.64.0.1').kind, 'tailscale', 'CGNAT 段起点应算 Tailscale');
  assert.strictEqual(net.classify('以太网', '100.127.255.254').kind, 'tailscale', 'CGNAT 段终点应算 Tailscale');
  // 边界外不能误判：100.63.x 和 100.128.x 都是普通公网地址
  assert.strictEqual(net.classify('以太网', '100.63.255.255').kind, 'lan');
  assert.strictEqual(net.classify('以太网', '100.128.0.1').kind, 'lan');
  assert.strictEqual(net.classify('WLAN', '192.168.0.101').kind, 'lan');
  // 排序规则本身要可验证，不能靠「这台机器上刚好有哪几种网卡」碰运气
  const wlan = { kind: 'lan', iface: 'WLAN', ip: '192.168.0.101', virtual: false };
  const ts = { kind: 'tailscale', iface: 'Tailscale', ip: '100.101.102.103', virtual: false };
  const vm = { kind: 'lan', iface: 'VMware Network Adapter VMnet1', ip: '192.168.233.1', virtual: true };
  assert.ok(net.rankOf(wlan) < net.rankOf(ts), '真实局域网应排在 Tailscale 前面');
  assert.ok(net.rankOf(ts) < net.rankOf(vm), 'Tailscale 应排在普通虚拟网卡前面');
  assert.ok(typeof net.tailscaleInstalled() === 'boolean', 'tailscaleInstalled 应返回布尔值');
  assert.ok(typeof net.tailscaleAddresses === 'function');
});

console.log('二维码（纯手写编码器，无第三方依赖）');
check('已知标准格式信息：M/掩码0 = 0x5412、L/掩码1 = 0x72F3（ISO/IEC 18004 表 C.1）', () => {
  assert.strictEqual(qr._internals.formatBits('M', 0), 0x5412);
  assert.strictEqual(qr._internals.formatBits('L', 1), 0x72f3);
  assert.strictEqual(qr._internals.formatBits('M', 4), 0x45f9);
});
check('纠错码字能过独立的 Reed-Solomon 多项式整除校验（反交错后逐块校验）', () => {
  const I = qr._internals;
  for (const [v, lv] of [[1, 'M'], [2, 'L'], [3, 'M'], [5, 'L'], [7, 'M'], [10, 'M'], [10, 'L']]) {
    const def = I.RS_BLOCKS[lv][v];
    const ecLen = def[0];
    const lengths = [];
    for (let i = 0; i < def[1]; i++) lengths.push(def[2]);
    for (let i = 0; i < def[3]; i++) lengths.push(def[4]);
    const totalData = lengths.reduce((a, b) => a + b, 0);

    const text = 'x'.repeat(I.byteCapacity(v, lv));
    const words = I.interleave(I.buildDataCodewords(Buffer.from(text, 'utf8'), v, lv), v, lv);
    assert.strictEqual(words.length, totalData + ecLen * lengths.length,
      'v' + v + '/' + lv + ' 码字总数应为 数据 ' + totalData + ' + 纠错 ' + ecLen + '×' + lengths.length);

    // 交错后的码流不是单个 RS 码字，必须按规范反交错还原出每一块再校验
    const dataBlocks = lengths.map(() => []);
    let p = 0;
    const maxData = Math.max.apply(null, lengths);
    for (let i = 0; i < maxData; i++) {
      for (let b = 0; b < lengths.length; b++) if (i < lengths[b]) dataBlocks[b].push(words[p++]);
    }
    const ecBlocks = lengths.map(() => []);
    for (let i = 0; i < ecLen; i++) {
      for (let b = 0; b < lengths.length; b++) ecBlocks[b].push(words[p++]);
    }
    assert.strictEqual(p, words.length, '反交错没有正好走完所有码字');

    const gen = rsGeneratorPoly(ecLen);
    for (let b = 0; b < lengths.length; b++) {
      assert.strictEqual(dataBlocks[b].length, lengths[b], '第 ' + b + ' 块数据码字数不对');
      assert.strictEqual(ecBlocks[b].length, ecLen, '第 ' + b + ' 块纠错码字数不对');
      assert.ok(rsDivides(dataBlocks[b].concat(ecBlocks[b]), gen),
        'v' + v + '/' + lv + ' 第 ' + b + ' 块的纠错码字不满足生成多项式整除');
    }
  }
});
check('矩阵已知答案（与独立实现逐模块比对过的固定值）', () => {
  const crypto = require('crypto');
  const fixtures = [
    { text: 'http://192.168.0.101:8787/?app=1', level: 'M', version: 3, size: 29, mask: 4,
      digest: '6488021d18d3fe2b3377f43d9d089ceb67b38d0541029bafba2a8960e7404150' },
    { text: 'http://192.168.0.101:8787/', level: 'M', version: 2, size: 25, mask: 4,
      digest: 'c8fa99d9038b9bf9789262a879c47337b3749524375d256bf58952ca1326d86b' },
    { text: 'http://10.0.0.7:8787/?app=1', level: 'L', version: 2, size: 25, mask: 7,
      digest: 'fa7b09388b66dace799929bb13579d0060d61adc0f408184a62579930664ed67' }
  ];
  for (const f of fixtures) {
    const e = qr.encode(f.text, f.level);
    assert.strictEqual(e.version, f.version, f.text + ' 版本应为 v' + f.version);
    assert.strictEqual(e.size, f.size);
    assert.strictEqual(e.mask, f.mask, '自动选中的掩码变了（惩罚分口径被改动过？）');
    const rows = e.matrix.map((r) => r.join('')).join('\n');
    const digest = crypto.createHash('sha256').update(rows).digest('hex');
    assert.strictEqual(digest, f.digest, f.text + ' 矩阵内容变了');
  }
});
check('矩阵结构自洽：三个定位图形、定时图形、固定黑块、静默区', () => {
  const e = qr.encode('http://192.168.0.101:8787/?app=1', 'M');
  const n = e.size;
  const m = e.matrix;
  const finder = (r0, c0) => {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const edge = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      assert.strictEqual(m[r0 + r][c0 + c], edge || core ? 1 : 0, '定位图形 (' + r0 + ',' + c0 + ') 第 ' + r + ',' + c + ' 格不对');
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) {
    assert.strictEqual(m[6][i], i % 2 === 0 ? 1 : 0, '横向定时图形第 ' + i + ' 格不对');
    assert.strictEqual(m[i][6], i % 2 === 0 ? 1 : 0, '纵向定时图形第 ' + i + ' 格不对');
  }
  assert.strictEqual(m[n - 8][8], 1, '固定黑块缺失');
  const svg = qr.toSvg(m);
  // 静默区宽度按规范是 4 个模块，少了扫码器很难对上焦
  assert.ok(svg.includes('viewBox="0 0 ' + (n + 8) + ' ' + (n + 8) + '"'), 'SVG 少留了静默区');
  assert.ok(svg.includes('shape-rendering="crispEdges"'), 'SVG 应关闭抗锯齿，否则模块边缘发虚');
});
check('版本 >= 7 才写版本信息区，且容量表与字节容量自洽', () => {
  const I = qr._internals;
  const small = qr.encode('A', 'M');
  assert.ok(small.version < 7, '单个字符不该用到大版本');
  for (let v = 1; v <= 10; v++) {
    for (const lv of ['M', 'L']) {
      const cap = I.byteCapacity(v, lv);
      assert.ok(cap > 0 && cap < 300, 'v' + v + '/' + lv + ' 容量异常: ' + cap);
      // 刚好装满应仍然装得下，多一个字节必须升版本
      const ok = qr.encode('y'.repeat(cap), lv);
      assert.strictEqual(ok.version, v, 'v' + v + '/' + lv + ' 装 ' + cap + ' 字节应仍为本版本');
      const over = qr.encode('y'.repeat(cap + 1), lv);
      if (v < 10) assert.ok(over && over.version > v, 'v' + v + '/' + lv + ' 超一个字节应升版本');
      else assert.strictEqual(over, null, '超出最大版本应返回 null 而不是崩掉');
    }
  }
  assert.strictEqual(qr.encode('z'.repeat(400), 'M'), null, '超出最大版本应返回 null 而不是抛错');
});
check('forUrl 返回可直接嵌页面的 SVG', () => {
  const one = qr.forUrl('http://192.168.0.101:8787/?app=1');
  assert.strictEqual(one.url, 'http://192.168.0.101:8787/?app=1');
  assert.ok(one.svg.startsWith('<svg '), 'SVG 结构不对');
  assert.ok(one.svg.includes('<path d="M'), '没有画出模块');
  assert.strictEqual(one.version, 3);
  assert.strictEqual(qr.forUrl(''), null);
});

console.log('手机端外壳（PWA / 窄屏）');
check('manifest 是合法 JSON，字段齐全且图标尺寸覆盖安装要求', () => {
  const path = require('path');
  const raw = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8');
  const man = JSON.parse(raw);
  assert.ok(man.name && man.name.length > 2);
  assert.ok(man.short_name && man.short_name.length <= 12, 'short_name 长了会被桌面截断');
  assert.strictEqual(man.display, 'standalone', '要像 App 一样全屏，display 必须是 standalone');
  assert.strictEqual(man.start_url.indexOf('/'), 0);
  assert.strictEqual(man.scope, '/');
  assert.ok(/^#/.test(man.theme_color) && /^#/.test(man.background_color));
  const sizes = man.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), '缺 192x192 图标（安卓安装的最低要求）');
  assert.ok(sizes.includes('512x512'), '缺 512x512 图标');
  assert.ok(man.icons.some((i) => i.purpose === 'maskable'), '缺 maskable 图标，安卓上会被裁成怪形状');
  for (const icon of man.icons) {
    const file = path.join(__dirname, '..', 'public', icon.src.replace(/^\//, ''));
    assert.ok(require('fs').existsSync(file), '清单里写的图标不存在: ' + icon.src);
    assert.ok(require('fs').statSync(file).size > 500, '图标文件疑似损坏: ' + icon.src);
  }
  assert.ok(man.shortcuts.length >= 3, '桌面长按快捷方式太少');
  for (const s of man.shortcuts) assert.ok(/[?&]view=[a-z]+/.test(s.url), '快捷方式应带 ?view= 参数: ' + s.url);
});
check('离线外壳只缓存骨架，绝不缓存 /api/ 数据', () => {
  const path = require('path');
  const sw = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.ok(/addEventListener\('install'/.test(sw) && /addEventListener\('fetch'/.test(sw));
  assert.ok(sw.includes("url.pathname.startsWith('/api/')"), '必须显式跳过 /api/');
  assert.ok(sw.includes('return;'), 'API 请求应直接放行给网络');
  // Cache API 会拒绝存放带 no-store 的响应，必须重新包一遍响应体
  assert.ok(/new Response\(/.test(sw), '缺少重新封装响应的逻辑，no-store 的资源会存不进缓存');
  assert.ok(sw.includes('Cache-Control'), '应处理 cache-control 头');
  assert.ok(!/caches\.put\(.*\/api\//.test(sw), '不允许把接口响应写进缓存');
  for (const need of ['/index.html', '/styles.css', '/app.js', '/manifest.webmanifest']) {
    assert.ok(sw.includes(need), '骨架清单里缺 ' + need);
  }
});
check('index.html 具备手机端必要的元信息与手机访问入口', () => {
  const path = require('path');
  const html = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/viewport-fit=cover/.test(html), '刘海屏需要 viewport-fit=cover');
  assert.ok(/name="theme-color"/.test(html), '缺主题色，手机状态栏会和页面脱节');
  assert.ok(/rel="manifest"/.test(html), '没有挂载 manifest');
  assert.ok(/name="mobile-web-app-capable"/.test(html));
  assert.ok(/id="netModal"/.test(html), '缺手机访问弹窗');
  assert.ok(/data-act="netPanel"/.test(html), '帮助菜单里缺手机访问入口');
  assert.ok(/id="netPanelBody"/.test(html), '总览里缺手机访问卡片');
});
check('窄屏样式：网格降为单列、页签栏挪到底部、触控命中区够大', () => {
  const path = require('path');
  const css = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(/@media \(max-width: 760px\)/.test(css), '缺少窄屏媒体查询');
  // 必须只看窄屏那一段：不限定范围的话，正则从头扫会先命中桌面基础样式里的
  // .grid.cols-2（minmax(420px,1fr)）—— 那本来是给宽屏用的，不算错，
  // 于是这条断言就变成了「永远为假」或「永远为真」，挡不住真正的窄屏回归。
  // 顺手去掉注释再断言：注释里为了说明来龙去脉会写「原本是 minmax(480px,1fr)」，
  // 不剥掉的话，下面「窄屏不许出现 >=400px 固定列宽」的守卫会被自己的注释误伤。
  const mobile = css.slice(css.indexOf('@media (max-width: 760px)')).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const colsRule = mobile.match(/\.grid\.cols-2[^{]*\{[^}]*grid-template-columns:\s*([^;]+);/);
  assert.ok(colsRule, '窄屏没有给 .grid.cols-2 指定 grid-template-columns');
  // 必须是 minmax(0, 1fr)，不能写 1fr：1fr 等价于 minmax(auto, 1fr)，
  // 卡片里 min-width:520px 的表格会把轨道撑到 520+，整页横向溢出。
  assert.ok(/^minmax\(0(px)?,\s*1fr\)$/.test(colsRule[1].trim()),
    '窄屏网格轨道应为 minmax(0, 1fr)（当前 ' + colsRule[1].trim() + '），否则会被宽表格撑到横向溢出');
  // 窄屏里不许再出现固定像素下限的列宽：412px 的手机放不下 >=400px 的轨道。
  assert.ok(!/minmax\((?:[4-9]\d\d|\d{4,})px/.test(mobile), '窄屏里仍有 >=400px 的固定列宽下限，手机上必然横向溢出');
  assert.ok(/nav\.tabs \{[^}]*position: fixed/s.test(css), '窄屏页签栏应固定');
  assert.ok(/nav\.tabs \{[^}]*bottom: 0/s.test(css), '窄屏页签栏应贴在屏幕底部');
  assert.ok(/env\(safe-area-inset-bottom/.test(css), '没有处理安卓手势条的底部安全区');
  assert.ok(/min-height: 42px/.test(css), '主要按钮的触控命中区偏小');
  assert.ok(/font-size: 16px/.test(css), '输入框字号不足 16px 会被移动端自动放大');
  assert.ok(/\.table-scroll/.test(css), '缺表格横向滚动容器样式');
  assert.ok(/\.desktop-only/.test(css), '手机访问卡片在窄屏应隐藏');
});
check('前端脚本已接上：注册离线外壳、包装表格、支持 ?view= 起始页签', () => {
  const path = require('path');
  const js = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(js.includes("navigator.serviceWorker.register('/sw.js')"), '没有注册 service worker');
  assert.ok(js.includes("location.protocol === 'https:'"), '应判断安全上下文，否则局域网 http 下会反复报错');
  assert.ok(js.includes('MutationObserver'), '表格是自动刷新的，需要观察 DOM 才好自动套滚动容器');
  assert.ok(js.includes("wrap.className = 'table-scroll'"));
  assert.ok(js.includes("new URLSearchParams(location.search).get('view')"), '没有支持 ?view= 快捷方式');
  assert.ok(js.includes("'/api/net'"), '没有请求局域网信息接口');
});

(async () => {
  console.log('窗口桥接 / 工作站自检');
  const windowBridge = require('../server/lib/window');
  const selfcheck = require('../server/lib/selfcheck');

  try {
    await windowBridge.request('rm -rf /');
    console.error('  FAIL 未知窗口指令应被拒绝');
    process.exitCode = 1;
  } catch (err) {
    console.log('  OK  未知窗口指令被拒绝 -> ' + err.message);
    passed += 1;
  }

  try {
    const cap = windowBridge.capabilities();
    assert.strictEqual(typeof cap.supported, 'boolean');
    ['minimize', 'maximize', 'restore', 'close', 'topmost-on', 'topmost-off'].forEach((a) => {
      assert.ok(cap.actions.includes(a), '缺少白名单指令 ' + a);
    });
    console.log('  OK  窗口能力清单 -> 白名单 ' + cap.actions.length + ' 条，本机可用=' + cap.supported);
    passed += 1;
  } catch (err) {
    console.error('  FAIL 窗口能力清单 -> ' + err.message);
    process.exitCode = 1;
  }

  try {
    assert.strictEqual(typeof windowBridge.state, 'function');
    console.log('  OK  窗口状态查询接口已导出（不发真实指令）');
    passed += 1;
  } catch (err) {
    console.error('  FAIL 窗口状态查询接口 -> ' + err.message);
    process.exitCode = 1;
  }

  try {
    const report = await selfcheck.run({ scope: 'local' });
    const failed = report.groups
      .reduce((acc, g) => acc.concat(g.checks), [])
      .filter((c) => c.status === 'fail');
    assert.strictEqual(failed.length, 0, '本机自检出现失败项: ' + failed.map((c) => c.name + ' -> ' + c.detail).join('; '));
    assert.ok(report.summary.ok >= 14, '本机自检通过项过少: ' + report.summary.ok);
    assert.ok(report.summary.total > report.summary.ok, '应保留联网检查项待完整自检');
    console.log('  OK  本机自检 -> ' + report.summary.ok + ' 项通过，' + report.summary.skip + ' 项待完整自检');
    passed += 1;
  } catch (err) {
    console.error('  FAIL 本机自检 -> ' + err.message);
    process.exitCode = 1;
  }

  console.log('');
  console.log(process.exitCode ? '自检存在失败项' : '全部 ' + passed + ' 项自检通过');
})();
