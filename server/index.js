'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const quotes = require('./sources/quotes');
const news = require('./sources/news');
const futures = require('./sources/futures');
const coal = require('./sources/coal');
const coalImport = require('./sources/coalImport');
const cls = require('./sources/cls');
const ths = require('./sources/ths');
const globalFeed = require('./sources/global');
const market = require('./sources/market');
const guba = require('./sources/guba');
const screener = require('./sources/screener');
const stockSearch = require('./sources/stockSearch');
const analysis = require('./sources/analysis');
const advice = require('./sources/advice');
const embed = require('./sources/embed');
const indicators = require('./lib/indicators');
const selfcheck = require('./lib/selfcheck');
const translate = require('./lib/translate');
const net = require('./lib/net');
const qrCode = require('./lib/qr');
const windowBridge = require('./lib/window');
const watchlistStore = require('./lib/watchlist');
const agents = require('./lib/agents');
const integrations = require('./lib/integrations');
const { cached, cacheInfo } = require('./lib/cache');

const SERVER_STARTED_AT = new Date().toISOString();
const PORT = Number(process.env.PORT || 8787);
// 默认监听所有网卡，手机才能从局域网连进来；只想本机访问就设 HOST=127.0.0.1
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = path.join(__dirname, 'data');

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function loadWatchlist() { return watchlistStore.load(); }

/** 用行情源把 6 位代码解析成 { code, name, price, changePct }；查不到返回 null。 */
async function resolveStockByCode(code) {
  const list = await quotes.getQuotes([code], 15000);
  const hit = (list || []).find((x) => x.code === code);
  if (!hit) return null;
  return {
    code: hit.code, name: hit.name || '', price: hit.price, changePct: hit.changePct,
    amountYuan: hit.amountYuan, marketCap: hit.marketCap
  };
}
function loadKnowledge() { return readJsonFile(path.join(DATA_DIR, 'knowledge.json')); }
/** 前端资源指纹：app.js 大小 + 修改时间。变了就说明界面代码更新过，前端会自动重新加载。 */
function appVersion() {
  try {
    const st = fs.statSync(path.join(PUBLIC_DIR, 'app.js'));
    return st.size + '-' + Math.round(st.mtimeMs);
  } catch (err) { return 'unknown'; }
}

function loadSectors() {
  try { return readJsonFile(path.join(DATA_DIR, 'sectors.json')).sectors || []; }
  catch (err) { return []; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(payload, null, 2));
}
function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'forbidden');
  fs.readFile(target, (err, buf) => {
    if (err) return sendText(res, 404, 'not found');
    const ext = path.extname(target).toLowerCase();
    // 页面/脚本/样式一律不缓存：否则换了代码浏览器还在跑旧的那份
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html' || ext === '.js' || ext === '.css' || ext === '.webmanifest') headers['Cache-Control'] = 'no-store, must-revalidate';
    res.writeHead(200, headers);
    res.end(buf);
  });
}
function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 首页总览。 */
async function buildOverview() {
  const watchlist = loadWatchlist();
  const codes = watchlist.stocks.map((s) => s.code);
  const [indexes, quoteList, futuresList, breadth] = await Promise.all([
    quotes.getIndexes().catch(() => []),
    quotes.getQuotes(codes).catch(() => []),
    futures.getFuturesRealtime().catch(() => []),
    market.getBreadth().catch(() => null)
  ]);
  const coalSeries = coal.buildSeries();
  const importSeries = coalImport.buildSeries();
  return {
    updatedAt: new Date().toISOString(),
    indexes,
    breadth,
    watchlist: watchlist.stocks.map((meta) => ({ ...meta, quote: quoteList.find((x) => x.code === meta.code) || null })),
    commodities: (futuresList || []).filter((f) => f.highlight),
    coal: {
      ports: coalSeries.ports.map((p) => ({ port: p.port, latest: p.latest, delta: p.delta, deltaPct: p.deltaPct })),
      totals: coalSeries.totals.slice(-8),
      latestPrice: coalSeries.latestPrice,
      provenance: coalSeries.provenance
    },
    coalImport: {
      groups: importSeries.groups.map((g) => ({ variety: g.variety, latest: g.latest, momPct: g.momPct, yoyComputed: g.yoyComputed })),
      provenance: importSeries.provenance
    },
    settings: watchlist.settings
  };
}

/** 个股详情（含完整技术指标）。 */
async function buildStock(code) {
  const watchlist = loadWatchlist();
  const meta = watchlist.stocks.find((s) => s.code === code);
  const [thsQuote, quote, kline, stockNews, flow] = await Promise.all([
    ths.fetchQuote(code).catch(() => null),
    quotes.getQuotes([code]).then((r) => r[0] || null).catch(() => null),
    quotes.getKline(code, 260).catch(() => []),
    meta ? news.getStockNews(meta.name, code, 15).catch(() => ({ items: [], sentiment: null })) : Promise.resolve({ items: [], sentiment: null }),
    market.getFundFlow([code]).catch(() => [])
  ]);

  const closes = kline.map((k) => k.close);
  const ma = { ma5: quotes.sma(closes, 5), ma10: quotes.sma(closes, 10), ma20: quotes.sma(closes, 20), ma60: quotes.sma(closes, 60) };
  const tech = indicators.analyze(kline);

  return {
    meta: meta || { code, name: (thsQuote && thsQuote.name) || '', tags: [], watchPoints: [] },
    quote,
    thsQuote,
    kline,
    ma,
    tech,
    macd: { ...indicators.macd(closes) },
    kdj: { ...indicators.kdj(kline) },
    rsi: indicators.rsi(closes, 14),
    boll: indicators.boll(closes, 20, 2),
    volMa: { volMa5: indicators.volumeMA(kline, 5), volMa10: indicators.volumeMA(kline, 10) },
    news: stockNews.items,
    sentiment: stockNews.sentiment,
    fundFlow: flow[0] || null
  };
}

const routes = {
  'GET /api/health': async () => ({
    ok: true,
    time: new Date().toISOString(),
    // startedAt 变化 = 后台服务重启过，前端据此自动重新加载，避免看到上一次会话的旧页面
    startedAt: SERVER_STARTED_AT,
    appVersion: appVersion(),
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    cache: cacheInfo(),
    window: windowBridge.capabilities()
  }),
  'GET /api/overview': () => buildOverview(),
  'GET /api/knowledge': () => loadKnowledge(),
  'GET /api/watchlist': () => loadWatchlist(),
  'GET /api/futures': async () => ({ updatedAt: new Date().toISOString(), items: await futures.getFuturesRealtime() }),
  'GET /api/coal/inventory': async () => coal.buildSeries(),
  'GET /api/coal/import': async () => coalImport.buildSeries(),
  'GET /api/sources': async () => ({
    items: Object.entries(news.SOURCES).map(([id, s]) => ({ id, label: s.label, describe: s.describe })),
    substitutions: [
      { requested: '财联社', status: '已接入', note: '复现其网页端 sign 签名后可直接取电报' },
      { requested: '东方财经（东方财富）', status: '已接入', note: '行情、7x24 快讯、全站新闻检索' },
      { requested: '同花顺', status: '已接入', note: '实时行情、日K、分时、板块指数、当日要闻' },
      { requested: '彭博社', status: '不可用', note: 'bloomberg.com 及 RSS 在本机网络不可达，且为订阅制；已用华尔街见闻 + 金十数据替代' },
      { requested: '百度股市通', status: '部分接入', note: '行情/分时/盘口接口可用，热榜接口触发风控' }
    ]
  }),
  'GET /api/screener/presets': async () => ({
    nodes: screener.NODES,
    sortFields: screener.SORT_FIELDS,
    presets: Object.entries(screener.PRESETS).map(([id, p]) => ({ id, label: p.label, describe: p.describe }))
  }),
  'GET /api/global': async () => globalFeed.getGlobalFeed(60)
};

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const key = req.method + ' ' + pathname;
  const q = url.searchParams;

  if (routes[key]) {
    try { return sendJson(res, 200, await routes[key]()); }
    catch (err) { return sendJson(res, 502, { error: String(err.message || err), route: key }); }
  }

  // 自检：scope=local 只查本机，scope=full 追加 HTTP 接口与外部数据源
  if (pathname === '/api/selfcheck' && req.method === 'GET') {
    const scope = q.get('scope') === 'full' ? 'full' : 'local';
    try { return sendJson(res, 200, await selfcheck.run({ scope })); }
    catch (err) { return sendJson(res, 500, { error: String(err.message || err) }); }
  }

  // 原生窗口控制（最小化 / 最大化 / 关闭 / 置顶）
  if (pathname === '/api/window/state' && req.method === 'GET') {
    try {
      windowBridge.warmup();
      const st = await windowBridge.state();
      noteWindowState(st);
      return sendJson(res, 200, st);
    } catch (err) { return sendJson(res, 503, { error: String(err.message || err) }); }
  }

  const windowMatch = pathname.match(/^\/api\/window\/([a-z-]+)$/);
  if (windowMatch && (req.method === 'GET' || req.method === 'POST')) {
    const action = windowMatch[1];
    if (action === 'state') {
      try {
        const st = await windowBridge.state();
        noteWindowState(st);
        return sendJson(res, 200, st);
      } catch (err) { return sendJson(res, 503, { error: String(err.message || err) }); }
    }
    try {
      const result = await windowBridge.request(action);
      noteWindowState(result);
      // 用户从界面点了「关闭窗口」：马上确认一次，窗口真的没了就立刻退出服务
      if (action === 'close') confirmClosedAfterClose(0);
      return sendJson(res, 200, result);
    } catch (err) { return sendJson(res, 400, { error: String(err.message || err) }); }
  }

  // 第三方页面的原样嵌入：白名单 + 「现在能不能嵌」探测（对方政策随时可能变）
  if (pathname === '/api/embed' && req.method === 'GET') {
    return sendJson(res, 200, { items: embed.list() });
  }

  // 机器翻译引擎状态（英文快讯自动转中文）：缓存了多少条、队列还剩多少、各源冷却情况
  if (pathname === '/api/translate/status' && req.method === 'GET') {
    return sendJson(res, 200, translate.stats());
  }

  // 手机访问用：同 Wi-Fi 的局域网地址 + 异地访问（Tailscale）地址、各自的二维码与防火墙提示
  if (pathname === '/api/net' && req.method === 'GET') {
    const urls = net.lanUrls(PORT);
    // primary 只挑真实局域网：同 Wi-Fi 时它是对的默认值；
    // 而 Tailscale 的地址必须手机先加入同一个 tailnet 才能用，不该当默认。
    const primary = urls.filter((u) => u.kind !== 'tailscale')[0] || urls[0] || null;
    const tailscale = urls.filter((u) => u.kind === 'tailscale')[0] || null;
    const qr = primary ? qrCode.forUrl(primary.url) : null;
    return sendJson(res, 200, {
      port: PORT,
      host: HOST,
      lanExposed: HOST === '0.0.0.0',
      primary: primary,
      hosts: urls,
      qr: qr,
      tailscale: tailscale,
      tailscaleQr: tailscale ? qrCode.forUrl(tailscale.url) : null,
      // 装了但没登录时不会有 100.x 地址，单报一个标记，界面才能给出正确指引
      tailscaleInstalled: net.tailscaleInstalled(),
      firewallNote: net.firewallNote()
    });
  }

  const embedMatch = pathname.match(/^\/api\/embed\/([a-z0-9-]+)\/preflight$/);
  if (embedMatch && req.method === 'GET') {
    try { return sendJson(res, 200, await embed.preflight(embedMatch[1])); }
    catch (err) { return sendJson(res, 400, { error: String(err.message || err) }); }
  }

  if (pathname === '/api/news' && req.method === 'GET') {
    const topics = (q.get('topics') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const limit = Math.min(300, Number(q.get('limit') || 80));
    try { return sendJson(res, 200, await news.getNewsFeed({ topics, limit })); }
    catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  if (pathname === '/api/cls/telegraph' && req.method === 'GET') {
    try {
      const items = await cls.fetchTelegraph(Math.min(100, Number(q.get('limit') || 30)));
      return sendJson(res, 200, { updatedAt: new Date().toISOString(), count: items.length, items, hotSubjects: await cls.getHotSubjects(24) });
    } catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  const sourceMatch = pathname.match(/^\/api\/sources\/([a-z0-9_]+)$/);
  if (sourceMatch && req.method === 'GET') {
    try {
      const feed = await news.getSourceFeed(sourceMatch[1], Math.min(200, Number(q.get('limit') || 60)));
      if (!feed) return sendJson(res, 404, { error: '未知数据源: ' + sourceMatch[1] });
      return sendJson(res, 200, feed);
    } catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  if (pathname === '/api/market' && req.method === 'GET') {
    const watchlist = loadWatchlist();
    const boards = loadSectors().map((s) => s.code);
    try {
      return sendJson(res, 200, await market.getMarketOverview(watchlist.stocks.map((s) => s.code), boards.slice(0, 40)));
    } catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  if (pathname === '/api/market/limitup' && req.method === 'GET') {
    try { return sendJson(res, 200, { date: q.get('date') || '', items: await market.getLimitUpPool(q.get('date'), Number(q.get('limit') || 20)) }); }
    catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  // 自选股「选股」：6 位代码直接查实时行情，其余当关键字去股票池里搜
  if (pathname === '/api/stock/lookup' && req.method === 'GET') {
    const keyword = String(q.get('q') || '').trim();
    if (!keyword) return sendJson(res, 400, { error: '请输入股票代码或名称关键字' });
    const digits = keyword.replace(/\D/g, '');
    try {
      if (/^\d{6}$/.test(digits)) {
        const hit = await resolveStockByCode(digits);
        if (!hit) return sendJson(res, 404, { error: '没查到 ' + digits + ' 的行情，请确认代码是否正确' });
        return sendJson(res, 200, { query: keyword, mode: 'code', results: [hit] });
      }
      if (/^\d+$/.test(keyword)) return sendJson(res, 400, { error: '股票代码是 6 位数字，请补全后再查' });
      const hits = await stockSearch.search(keyword, 12);
      if (!hits.length) return sendJson(res, 200, { query: keyword, mode: 'keyword', results: [] });
      // 顺手补上最新价与涨跌幅，候选列表里就能看个大概（失败不影响搜索结果）
      const hitQuotes = await quotes.getQuotes(hits.map((h) => h.code), 15000).catch(() => []);
      const results = hits.map((h) => {
        const quote = (hitQuotes || []).find((x) => x.code === h.code) || {};
        return {
          code: h.code, name: h.name || quote.name || '', market: h.market,
          price: quote.price, changePct: quote.changePct, amountYuan: quote.amountYuan
        };
      });
      return sendJson(res, 200, { query: keyword, mode: 'keyword', results });
    } catch (err) {
      return sendJson(res, 502, { error: String(err.message || err) });
    }
  }

  if (pathname === '/api/screener' && req.method === 'GET') {
    const query = Object.fromEntries(q.entries());
    try { return sendJson(res, 200, await screener.screen(query)); }
    catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  if (pathname === '/api/coal/extract' && req.method === 'GET') {
    try {
      const feed = await news.getNewsFeed({ topics: ['coal'], limit: 80 });
      const inventory = coal.extractFromNews(feed.items);
      const imp = coalImport.extractFromNews(feed.items);
      // 中文报道里「进口煤炭 / 煤炭进口」两种语序都存在，且实测「煤炭进口量」的检索命中率最高
      // （海关总署月报多为「8月份，我国进口煤炭4209万吨」这种写法），故并行检索多种说法。
      const importNewsBatches = await Promise.all([
        news.fetchEmSearch('煤炭进口量', 20).catch(() => []),
        news.fetchEmSearch('煤炭进口', 20).catch(() => []),
        news.fetchEmSearch('进口煤炭', 20).catch(() => []),
        news.fetchEmSearch('煤及褐煤进口', 20).catch(() => [])
      ]);
      const importNews = importNewsBatches.flat();
      const imp2 = coalImport.extractFromNews(importNews);
      return sendJson(res, 200, {
        updatedAt: new Date().toISOString(),
        scanned: feed.items.length + importNews.length,
        inventoryPoints: inventory.inventoryPoints,
        pricePoints: inventory.pricePoints,
        importPoints: imp.importPoints.concat(imp2.importPoints).slice(0, 40),
        yoyNotes: imp.yoyNotes.concat(imp2.yoyNotes).slice(0, 20),
        mentions: inventory.mentions
      });
    } catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  const stockMatch = pathname.match(/^\/api\/stock\/(\d{6})$/);
  if (stockMatch && req.method === 'GET') {
    try { return sendJson(res, 200, await buildStock(stockMatch[1])); }
    catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  const analysisMatch = pathname.match(/^\/api\/analysis\/(\d{6})$/);
  if (analysisMatch && req.method === 'GET') {
    try { return sendJson(res, 200, await analysis.analyzeStock(analysisMatch[1])); }
    catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  if (pathname === '/api/advice' && req.method === 'GET') {
    try {
      return sendJson(res, 200, await advice.suggest({
        preset: q.get('preset') || 'momentum',
        limit: Number(q.get('limit') || 8),
        pages: Number(q.get('pages') || 2)
      }));
    } catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  const trendMatch = pathname.match(/^\/api\/trend\/(\d{6})$/);
  if (trendMatch && req.method === 'GET') {
    try { return sendJson(res, 200, await advice.analyzeTrend(trendMatch[1])); }
    catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  const gubaMatch = pathname.match(/^\/api\/guba\/(\d{6})$/);
  if (gubaMatch && req.method === 'GET') {
    try { return sendJson(res, 200, await guba.fetchBoard(gubaMatch[1], Number(q.get('limit') || 30))); }
    catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  // 智能体研判：本地多智能体引擎，不需要任何大模型 Key
  const agentsMatch = pathname.match(/^\/api\/agents\/(\d{6})$/);
  if (agentsMatch && req.method === 'GET') {
    try { return sendJson(res, 200, await agents.runAgents(agentsMatch[1], { industry: q.get('industry') || undefined })); }
    catch (err) { return sendJson(res, err.status || 502, { error: String(err.message || err) }); }
  }

  // 外部程序接入：列清单（纯静态说明，不探测）
  if (pathname === '/api/integrations' && req.method === 'GET') {
    return sendJson(res, 200, { integrations: integrations.list() });
  }

  // 外部程序接入：探测本机有没有在跑（只读取响应头，不调用对方接口）
  if (pathname === '/api/integrations/status' && req.method === 'GET') {
    const id = q.get('id') || 'tradingagents';
    try { return sendJson(res, 200, await integrations.probe(id)); }
    catch (err) { return sendJson(res, err.status || 502, { error: String(err.message || err) }); }
  }

  const thsMatch = pathname.match(/^\/api\/ths\/(\d{6})\/(quote|daily|minute)$/);
  if (thsMatch && req.method === 'GET') {
    try {
      const code = thsMatch[1];
      if (thsMatch[2] === 'quote') return sendJson(res, 200, await ths.fetchQuote(code));
      if (thsMatch[2] === 'daily') return sendJson(res, 200, await ths.fetchDaily(code, Number(q.get('limit') || 250)));
      return sendJson(res, 200, await ths.fetchMinute(code));
    } catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  const dailyMatch = pathname.match(/^\/api\/futures\/([A-Za-z0-9]+)\/daily$/);
  if (dailyMatch && req.method === 'GET') {
    try { return sendJson(res, 200, { symbol: dailyMatch[1], items: await futures.getFuturesDaily(dailyMatch[1], Math.min(2000, Number(q.get('limit') || 180))) }); }
    catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }

  return null;
}

/* ------------------ 关窗即关程序：工作站窗口看门狗 ------------------ */
// 需求：用户关掉工作站窗口 = 整个程序退出，不留后台服务。
// 规则：只有「确实见到过工作站窗口（Edge 应用模式窗口）」之后才武装看门狗；之后每 2.5 秒查一次，
//      连续 2 次查不到任何工作站窗口就退出进程（关窗后约 5 秒内生效）。
// 为什么武装条件必须带 app 标记：
//   · 自检 / 前端验收用的无头 Edge 不带 --app=，永远不会武装，不会被误杀；
//   · 只跑后台服务（-ServerOnly / npm start）时没有窗口，也不会武装；
//   · 退出条件用总窗口数 count===0：即使 app 标记偶发抖动（窗口还在 → count>0）也不会误退。
const WATCH_INTERVAL_MS = 2500;
const WATCH_STRIKES = 2;
let sawAppWindow = false;
let zeroStreak = 0;
let watchTimer = null;
let watchBusy = false;
let watchExiting = false;

function noteWindowState(st) {
  if (!st || !Array.isArray(st.windows)) return;
  if (!st.windows.some((w) => w && w.app)) return;
  sawAppWindow = true;
  zeroStreak = 0;
  if (watchTimer || !windowBridge.capabilities().supported) return;
  watchTimer = setInterval(windowWatchTick, WATCH_INTERVAL_MS);
  console.log('窗口看门狗已启动：关闭工作站窗口会同时退出后台服务。');
}

async function windowWatchTick() {
  if (watchBusy || watchExiting || !sawAppWindow) return;
  watchBusy = true;
  let st = null;
  try { st = await windowBridge.state(); } catch (err) { st = null; }
  watchBusy = false;
  // 查不到（代理没起来 / 超时）不能当成「窗口已关」，否则会误杀服务
  if (!st || typeof st.count !== 'number') return;
  if (st.count > 0) { zeroStreak = 0; return; }
  zeroStreak += 1;
  if (zeroStreak >= WATCH_STRIKES) exitWithWindowClosed();
}

/** 用户点了界面里的「关闭窗口」：确认窗口真的消失就立刻退出，不用等看门狗的两拍。 */
function confirmClosedAfterClose(attempt) {
  if (watchExiting) return;
  setTimeout(async () => {
    if (watchExiting) return;
    let st = null;
    try { st = await windowBridge.state(); } catch (err) { st = null; }
    if (st && typeof st.count === 'number') {
      if (st.count === 0) { exitWithWindowClosed(); return; }
      sawAppWindow = true; zeroStreak = 0;   // 窗口还在（例如关闭被拦下），交回看门狗
      return;
    }
    if (attempt < 3) confirmClosedAfterClose(attempt + 1);
  }, 1500);
}

function exitWithWindowClosed() {
  if (watchExiting) return;
  watchExiting = true;
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  console.log('工作站窗口已关闭，后台服务随之退出（关窗即关程序）。');
  windowBridge.shutdown();
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || HOST));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // 外部程序接入的配置（目前只有 baseUrl 与 enabled 两个字段）
  if (url.pathname === '/api/integrations/config' && req.method === 'POST') {
    try {
      const raw = await readBody(req, 64 * 1024);
      const body = raw ? JSON.parse(raw) : {};
      const id = body.id || 'tradingagents';
      return sendJson(res, 200, { ok: true, id: id, config: integrations.setConfig(id, body) });
    } catch (err) {
      return sendJson(res, err.status || 400, { error: String(err.message || err) });
    }
  }

  // 自选股增删改：写 server/data/watchlist.json。本机工具，别把 8787 暴露到公网。
  if (req.method === 'POST' && url.pathname.startsWith('/api/watchlist/')) {
    const action = url.pathname.slice('/api/watchlist/'.length);
    try {
      const raw = await readBody(req, 64 * 1024);
      const body = raw ? JSON.parse(raw) : {};
      if (action === 'add') {
        const code = watchlistStore.normalizeCode(body.code);
        let name = watchlistStore.sanitizeText(body.name, 16);
        if (!name) {
          const hit = await resolveStockByCode(code).catch(() => null);
          if (hit && hit.name) name = hit.name;
        }
        return sendJson(res, 200, { ok: true, action, watchlist: watchlistStore.add(body, name) });
      }
      if (action === 'remove') return sendJson(res, 200, { ok: true, action, watchlist: watchlistStore.remove(body) });
      if (action === 'update') return sendJson(res, 200, { ok: true, action, watchlist: watchlistStore.update(body) });
      if (action === 'move') return sendJson(res, 200, { ok: true, action, watchlist: watchlistStore.move(body) });
      return sendJson(res, 404, { error: '未知的自选股操作: ' + action });
    } catch (err) {
      return sendJson(res, err.status || 400, { error: String(err.message || err) });
    }
  }

  if (req.method === 'POST' && (url.pathname === '/api/coal/import/upload' || url.pathname === '/api/coal/inventory/upload')) {
    const target = url.pathname === '/api/coal/import/upload' ? coalImport : coal;
    try {
      const body = await readBody(req);
      const text = body.trim().startsWith('{') ? (JSON.parse(body).csv || '') : body;
      const result = target.importCsv(text, 'imported');
      const series = url.pathname === '/api/coal/import/upload' ? coalImport.buildSeries() : coal.buildSeries();
      return sendJson(res, 200, { ...result, series });
    } catch (err) { return sendJson(res, 400, { error: String(err.message || err) }); }
  }

  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, url);
    if (handled !== null) return undefined;
    return sendJson(res, 404, { error: '未知接口: ' + url.pathname });
  }

  return serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log('股民舆情与商品看板已启动: http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT);
  if (HOST === '0.0.0.0') {
    const urls = net.lanUrls(PORT);
    if (urls.length) {
      console.log('手机访问（需与电脑同一 Wi-Fi）:');
      urls.forEach((u) => console.log('  ' + u.url + '   [' + u.iface + ']'));
    } else {
      console.log('手机访问: 没找到可用的局域网地址（检查 Wi-Fi 是否已连接）');
    }
  } else {
    console.log('仅本机访问（HOST=' + HOST + '），手机连不上；改成 HOST=0.0.0.0 即可');
  }
  console.log('数据源: 财联社 · 东方财富 · 同花顺 · 新浪财经 · 华尔街见闻 · 金十数据 · 新浪股市汇');
  const cap = windowBridge.capabilities();
  console.log('窗口控制: ' + (cap.supported ? '可用（最小化 / 最大化 / 关闭 / 置顶）' : '不可用（仅 Windows 支持）'));
  if (cap.supported) console.log('关窗即关程序：关闭工作站窗口会同时退出后台服务（不再留后台进程）。');
});
