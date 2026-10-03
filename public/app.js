'use strict';

const state = {
  overview: null,
  watchlist: null,
  analysisCode: null,
  analysisData: null,
  newsTopic: '',
  commodity: null,
  coal: null,
  knowledge: null,
  bookQuery: '',
  agentsCode: null
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* 页签 id -> 显示名，状态栏与「上次看到哪」都用它 */
const VIEW_LABELS = {
  overview: '总览', stocks: '自选股', embed: '大盘云图', news: '舆情新闻', sources: '数据源浏览', screener: '选股器',
  advice: '选股建议', agents: '智能体研判', guba: '股吧', analysis: '个股体检', commodity: '棉花 / 大宗商品',
  coal: '煤炭库存 / 进口', knowledge: '交易知识库'
};
/* 桌面快捷方式会用 ?app=1 打开应用窗口，据此判断是不是「程序窗口」模式 */
const IS_APP_MODE = /[?&]app=1(&|$)/.test(location.search);
const LAST_VIEW_KEY = 'stockradar.lastView';
/* 最近一次体检的股票：个股体检已不在菜单里，刷新后要能回到同一只 */
const ANALYSIS_CODE_KEY = 'stockradar.analysisCode';

/* 这些接口天生慢（要跑几十次上游抓取），单独放宽超时 */
const SLOW_API = /^\/api\/(advice|screener|coal\/extract|analysis|guba|stock|news|overview|sources|market|ths|agents|integrations)/;

async function api(path, options) {
  const opt = Object.assign({}, options);
  const timeoutMs = Number(opt.timeoutMs) || (SLOW_API.test(path) ? 90000 : 30000);
  delete opt.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, Object.assign(opt, { signal: controller.signal }));
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new Error(path + ' 等了 ' + Math.round(timeoutMs / 1000) + ' 秒还没返回，已放弃本次等待（可点重试）');
    }
    throw new Error('连不上本地服务（' + ((err && err.message) || err) + '）');
  }
  clearTimeout(timer);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
  return json;
}

const fmt = {
  num(v, dp = 2) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
    return Number(v).toFixed(dp);
  },
  big(v) {
    if (v === null || v === undefined) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(2) + '万';
    return String(n);
  },
  pct(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  },
  cls(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return 'dim';
    if (Number(v) > 0) return 'up';
    if (Number(v) < 0) return 'down';
    return 'dim';
  },
  time(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    const pad = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
};

function esc(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 内联 SVG 图标。图标全部来自 index.html 里的 <symbol> 精灵。
 * 为什么不用 emoji：字形随系统变、跟不了主题色、没法用 token 控制粗细，
 * 而且屏幕阅读器会把 emoji 当文字念出来。这里的图标一律 aria-hidden，
 * 含义由旁边的可见文字承担。
 */
function icon(name, cls) {
  if (!name) return '';
  return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true" focusable="false"><use href="#i-' + name + '"></use></svg>';
}

/* ---------------------------------- 图表 ---------------------------------- */

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(320, rect.width || canvas.clientWidth || 640);
  // 坑：canvas 的 width/height 是「反射属性」，一旦赋值过，getAttribute('height') 拿到的
  // 就是位图高度（已经乘过 dpr）。每次重绘再乘一次 dpr，画布会指数级膨胀，
  // 最后 getImageData / 绘制直接 OOM，页面看起来就是「图表没了、页面卡住」。
  // 所以把「设计高度」记在 data-h 上，只认 HTML 里写的那一次。
  if (!canvas.dataset.h) canvas.dataset.h = canvas.getAttribute('height') || '260';
  const h = Math.min(800, Number(canvas.dataset.h) || 260);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
  return { ctx, w, h };
}

function niceTicks(min, max, count) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

function drawFrame(ctx, w, h, pad, min, max, labels, fmtY, opts) {
  ctx.strokeStyle = '#253048';
  ctx.fillStyle = '#93a1bd';
  ctx.lineWidth = 1;
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;
  const yOf = (v) => pad.top + plotH - ((v - min) / (max - min || 1)) * plotH;

  for (const v of niceTicks(min, max, 4)) {
    const y = Math.round(yOf(v)) + 0.5;
    if (y < pad.top - 1 || y > h - pad.bottom + 1) continue;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(fmtY ? fmtY(v) : String(v), pad.left - 6, y + 3);
  }

  ctx.textAlign = 'center';
  const n = labels.length;
  // 默认自动抽稀；调用方可以传 labelStep 自己控制，空字符串表示这个刻度不写标签
  const stepLabel = Math.max(1, Number(opts && opts.labelStep) || Math.ceil(n / 8));
  labels.forEach((lab, i) => {
    if (!lab) return;
    if (stepLabel > 1 && i % stepLabel !== 0 && i !== n - 1) return;
    const x = pad.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    ctx.fillText(lab, x, h - pad.bottom + 14);
  });

  return { xOf: (i) => pad.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW), yOf: yOf, plotW: plotW, plotH: plotH };
}

function drawCandles(canvas, kline, ma) {
  if (!kline || !kline.length) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { left: 52, right: 12, top: 14, bottom: 26 };
  const lows = kline.map((k) => k.low);
  const highs = kline.map((k) => k.high);
  const maVals = [ma.ma5, ma.ma10, ma.ma20].flat().filter((v) => v !== null && v !== undefined);
  const min = Math.min.apply(null, lows.concat(maVals.length ? maVals : lows)) * 0.995;
  const max = Math.max.apply(null, highs.concat(maVals.length ? maVals : highs)) * 1.005;
  const labels = kline.map((k) => k.date.slice(5));
  const scale = drawFrame(ctx, w, h, pad, min, max, labels, (v) => v.toFixed(2));

  const n = kline.length;
  const slot = scale.plotW / n;
  const bodyW = Math.max(1.5, Math.min(9, slot * 0.68));

  kline.forEach((k, i) => {
    const x = pad.left + slot * (i + 0.5);
    const up = k.close >= k.open;
    const color = up ? '#ff4d4f' : '#17c964';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, scale.yOf(k.high));
    ctx.lineTo(Math.round(x) + 0.5, scale.yOf(k.low));
    ctx.stroke();
    const yOpen = scale.yOf(k.open);
    const yClose = scale.yOf(k.close);
    const top = Math.min(yOpen, yClose);
    const height = Math.max(1, Math.abs(yClose - yOpen));
    if (up) ctx.fillRect(x - bodyW / 2, top, bodyW, height);
    else ctx.fillRect(x - bodyW / 2, top, bodyW, height);
  });

  const lines = [
    { values: ma.ma5, color: '#ffb020' },
    { values: ma.ma10, color: '#4a9eff' },
    { values: ma.ma20, color: '#c084fc' }
  ];
  for (const line of lines) {
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    line.values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const x = pad.left + slot * (i + 0.5);
      const y = scale.yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

function drawLineSeries(canvas, series, opts) {
  const options = opts || {};
  if (!series.length || !series[0].points.length) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { left: 56, right: 12, top: 14, bottom: 26 };
  const all = series.flatMap((s) => s.points.map((p) => p.value));
  const min = Math.min.apply(null, all) * 0.995;
  const max = Math.max.apply(null, all) * 1.005;
  const labels = series[0].points.map((p) => (options.labelOf ? options.labelOf(p) : (p.date || '').slice(5)));
  const scale = drawFrame(ctx, w, h, pad, min, max, labels,
    options.fmtY || ((v) => Number(v).toFixed(1)), { labelStep: options.labelStep });

  if (Number.isFinite(options.refLine)) {
    const y = Math.round(scale.yOf(options.refLine)) + 0.5;
    if (y > pad.top && y < h - pad.bottom) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#5c6b86';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
      ctx.restore();
    }
  }

  series.forEach((s) => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = pad.left + (scale.plotW / Math.max(1, s.points.length - 1)) * i;
      const y = scale.yOf(p.value);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

/** 分组柱状图：categories 为 X 轴标签，datasets 为 [{name,color,values}] */
function drawGroupedBars(canvas, categories, datasets) {
  if (!categories.length) return { colors: [] };
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { left: 56, right: 12, top: 14, bottom: 28 };
  const all = datasets.flatMap((d) => d.values.filter((v) => v !== null));
  const max = Math.max.apply(null, all.length ? all : [1]) * 1.12;
  const min = 0;
  const scale = drawFrame(ctx, w, h, pad, min, max, categories, (v) => Number(v).toFixed(0));

  const slot = scale.plotW / categories.length;
  const groupW = slot * 0.7;
  const barW = groupW / datasets.length;

  categories.forEach((cat, ci) => {
    const groupX = pad.left + slot * ci + (slot - groupW) / 2;
    datasets.forEach((ds, di) => {
      const v = ds.values[ci];
      if (v === null || v === undefined) return;
      const x = groupX + barW * di;
      const y = scale.yOf(v);
      const zero = scale.yOf(0);
      ctx.fillStyle = ds.color;
      ctx.fillRect(x + 1, y, Math.max(2, barW - 3), Math.max(1, zero - y));
      ctx.fillStyle = '#93a1bd';
      ctx.textAlign = 'center';
      ctx.fillText(Number(v).toFixed(0), x + barW / 2, y - 4);
    });
  });

  return { colors: datasets.map((d) => ({ name: d.name, color: d.color })) };
}

/* --------------------------------- 渲染工具 -------------------------------- */

function sentimentBlock(s, options) {
  const opts = options || {};
  if (!s) return '<span class="dim">暂无舆情数据</span>';
  const cls = s.score > 8 ? 'bullish' : s.score < -8 ? 'bearish' : 'neutral';
  const width = Math.min(50, Math.abs(s.score) / 2);
  const meter =
    '<div class="bar-meter"><i class="' + cls + '" style="width:' + width + '%;' +
    (s.score < 0 ? 'left:calc(50% - ' + width + '%);' : '') + '"></i></div>';
  const termLimit = typeof opts.termLimit === 'number' ? opts.termLimit : 8;
  const terms = (s.topTerms || []).slice(0, termLimit).map((t) =>
    '<span class="chip" style="color:' + (t.polarity === 'bullish' ? '#ff4d4f' : '#17c964') + '">' +
    esc(t.term) + (t.count > 1 ? ' ×' + t.count : '') + '</span>').join(' ');
  return (
    '<div><span class="senti-pill ' + cls + '">' + esc(s.label) + ' ' + (s.score > 0 ? '+' : '') + s.score + '</span>' +
    '<span class="hint" style="margin-left:8px">利好词 ' + (s.positive || 0) + ' · 利空词 ' + (s.negative || 0) +
    ' · 样本 ' + (s.sampleSize || 0) + ' 条</span></div>' + meter +
    (terms ? '<div style="margin-top:8px; display:flex; gap:5px; flex-wrap:wrap">' + terms + '</div>' : '')
  );
}

function newsItemHtml(item) {
  const topicNames = { cotton: '棉花', coal: '煤炭', commodity: '大宗', macro: '宏观', market: '资金' };
  const flags = (item.topics || []).map((t) => '<span class="chip">' + (topicNames[t] || t) + '</span>').join('');
  const s = item.sentiment;
  const senti = s && Math.abs(s.score) >= 10
    ? '<span class="senti-pill ' + (s.score > 0 ? 'bullish' : 'bearish') + '">' +
      (s.score > 0 ? '利好' : '利空') + ' ' + Math.abs(s.score) + '</span>'
    : '';
  const keyTerms = s ? (s.hits || []).slice(0, 4).map((h) =>
    '<span class="chip" style="color:' + (h.polarity === 'bullish' ? '#ff4d4f' : '#17c964') + '">' + esc(h.term) + '</span>').join('') : '';
  /* 英文原稿（目前只有金十数据会混进来）：中文译文当主标题，英文原文缩在下面一行，
     标注「机翻」——机器翻译一定会出错，用户得能一眼核对原文。 */
  const zhTitle = item.titleZh || '';
  const title = zhTitle || item.title || '';
  const original = zhTitle && item.title && item.title !== zhTitle
    ? '<div class="original" title="英文原稿">' + esc(item.title) + '</div>' : '';
  const zhSummary = item.summaryZh && item.summaryZh !== zhTitle ? item.summaryZh : '';
  const summary = zhTitle ? zhSummary : (item.summary || '');
  const xlate = zhTitle
    ? '<span class="chip xlate" title="英文原稿由免费机器翻译接口转成中文，仅供参考">机翻</span>' : '';
  return (
    '<li><div class="meta">' + fmt.time(item.timestamp) + '<br>' + esc(item.source) + '</div>' +
    '<div class="body"><div class="title"><a href="' + esc(item.url) + '" target="_blank" rel="noreferrer">' +
    esc(title) + '</a></div>' + original +
    (summary ? '<div class="summary">' + esc(summary) + '</div>' : '') +
    '<div class="flags">' + xlate + senti + flags + keyTerms + '</div></div></li>'
  );
}

/* ---------------------------------- 总览 ---------------------------------- */

function renderIndexStrip(list) {
  const el = $('#indexStrip');
  if (!list || !list.length) { el.innerHTML = '<span class="dim">指数数据不可用</span>'; return; }
  el.innerHTML = list.map((i) =>
    '<span class="idx"><b>' + esc(i.name) + '</b><span class="num ' + fmt.cls(i.changePct) + '">' +
    fmt.num(i.price, 2) + ' ' + fmt.pct(i.changePct) + '</span></span>').join('');
}

/** 某张卡片的数据没取到：只影响这张卡，并给出重试按钮（不再牵连整页）。 */
function cardError(sel, err, note) {
  const el = document.querySelector(sel);
  if (!el) return;
  el.innerHTML = '<span class="error">' + esc((err && err.message) || err) + '</span>' +
    '<div style="margin-top:8px"><button class="action ghost" data-card-retry="1">重试本页</button>' +
    (note ? '<span class="hint" style="margin-left:8px">' + esc(note) + '</span>' : '') + '</div>';
}

function dataStamp(iso, fallback) {
  const t = iso || fallback;
  return '<div class="hint" style="margin-top:8px">数据时间 ' + (t ? fmt.time(t) : '—') +
    '（每 30 秒自动刷新）</div>';
}

/** 全市场涨/平/跌分布条（CSS 宽度按家数占比）。 */
function distBars(b) {
  const rows = [
    { k: '上涨', v: Number(b.up) || 0, c: '#ff4d4f' },
    { k: '平盘', v: Number(b.flat) || 0, c: '#93a1bd' },
    { k: '下跌', v: Number(b.down) || 0, c: '#17c964' }
  ];
  const tot = rows.reduce((a, x) => a + x.v, 0) || 1;
  return '<div class="dist-bars">' + rows.map((x) => {
    const pct = (x.v / tot) * 100;
    return '<div class="db"><span class="dim">' + x.k + '</span>' +
      '<span class="b"><i style="width:' + pct.toFixed(2) + '%;background:' + x.c + '"></i></span>' +
      '<span class="n">' + x.v + ' 家 · ' + pct.toFixed(1) + '%</span></div>';
  }).join('') + '</div>';
}

/** 自选股主力资金净流入（红=净流入 / 绿=净流出）。数据源：东方财富当日累计。 */
function renderFundFlow(flows, stamp) {
  const el = $('#stockFundFlow');
  if (!el) return;
  el.classList.remove('loading');
  const list = (flows || [])
    .map((f) => ({ name: f.name, code: f.code, net: Number(f.mainNet) || 0, pct: Number(f.mainPct) }))
    .filter((f) => f.net !== 0)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  if (!list.length) {
    el.innerHTML = '<div class="hint">本次没有取到主力资金流向（上游可能限流，稍后会自动重试）。</div>' +
      (stamp ? '<div class="hint" style="margin-top:6px">数据时间 ' + fmt.time(stamp) + '</div>' : '');
    return;
  }
  const maxAbs = Math.max.apply(null, list.map((f) => Math.abs(f.net)).concat([1]));
  el.innerHTML = '<div class="term-bars flow-bars stock">' + list.map((f) => {
    const color = f.net > 0 ? '#ff4d4f' : '#17c964';
    const width = Math.max(6, Math.round((Math.abs(f.net) / maxAbs) * 100));
    const pctTxt = Number.isFinite(f.pct) && f.pct !== 0
      ? '<span class="dim">(' + (f.pct > 0 ? '+' : '') + f.pct.toFixed(2) + '%)</span>' : '';
    return '<div class="tb"><span class="t" title="' + esc(f.code) + '">' + esc(f.name) + '</span>' +
      '<span class="b"><i style="width:' + width + '%;background:' + color + '"></i></span>' +
      '<span class="n"><span class="' + (f.net > 0 ? 'up' : 'down') + '">' +
      (f.net > 0 ? '+' : '−') + fmt.big(Math.abs(f.net)) + '</span>' + pctTxt + '</span></div>';
  }).join('') + '</div>' +
    '<div class="hint" style="margin-top:8px">红条＝主力净流入 · 绿条＝主力净流出，单位为元；括号内是主力净占比（主力净额 ÷ 成交额）。' +
    '数据来源：东方财富「当日累计」，按你的自选股口径取回。' +
    (stamp ? '数据时间 ' + fmt.time(stamp) + '。' : '') + '本页每 30 秒自动刷新。</div>';
}

/** 舆情主题条形榜：主题出现次数画成两列迷你条形图，红=利好词，绿=利空词。 */
function termBars(terms) {
  const list = (terms || []).slice(0, 12);
  if (!list.length) return '';
  const max = Math.max.apply(null, list.map((t) => Number(t.count) || 0).concat([1]));
  const rows = list.map((t) => {
    const color = t.polarity === 'bullish' ? '#ff4d4f' : '#17c964';
    const width = Math.max(8, Math.round(((Number(t.count) || 0) / max) * 100));
    return '<div class="tb"><span class="t" title="' + esc(t.term) + '">' + esc(t.term) + '</span>' +
      '<span class="b"><i style="width:' + width + '%;background:' + color + '"></i></span>' +
      '<span class="n">' + (t.count || 0) + '</span></div>';
  }).join('');
  return '<h5 class="hint" style="margin:12px 0 0;font-weight:500">主题出现次数（红=利好词 · 绿=利空词）</h5>' +
    '<div class="term-bars">' + rows + '</div>';
}

/* 自选股分时：把每只自选股当日的分时换算成「相对昨收的涨跌幅(%)」，画在同一张图上对比。
   这样 5 只价位不同的股票也能同图比较；0% 处的虚线就是昨收基准。 */
const WATCH_MINUTE_COLORS = ['#4a9eff', '#ffb020', '#c084fc', '#22d3ee', '#f472b6', '#fb7185'];
const MINUTE_TTL_MS = 5 * 60 * 1000;   // 分时数据自己的缓存，避免每 30 秒刷新都去捶上游
const minuteCache = new Map();         // code -> { at, date, prevClose, points, isTrading }

/** 并行取自选股分时；单只失败不影响其它只，有旧缓存时先用旧数据顶上。 */
function fetchWatchMinutes(list) {
  return Promise.all(list.map((s) => {
    const code = String(s.code || '');
    const hit = minuteCache.get(code);
    if (hit && Date.now() - hit.at < MINUTE_TTL_MS) return Promise.resolve({ stock: s, ok: true, quote: hit });
    return api('/api/ths/' + code + '/minute').then((d) => {
      const quote = {
        date: d.date, prevClose: Number(d.prevClose) || 0,
        points: d.points || [], isTrading: !!d.isTrading
      };
      minuteCache.set(code, Object.assign({ at: Date.now() }, quote));
      return { stock: s, ok: true, quote: quote };
    }).catch((err) => {
      if (hit) return { stock: s, ok: true, stale: true, quote: hit };
      return { stock: s, ok: false, error: (err && err.message) || String(err) };
    });
  }));
}

let watchMinuteJob = null;
let watchMinuteRepaint = false;

/** 总览「自选股分时」入口：同一时刻只跑一次；跑的过程中又有人要画，就在结束后用缓存补画一次。 */
function drawWatchMinutes(watchlist) {
  if (watchMinuteJob) { watchMinuteRepaint = true; return watchMinuteJob; }
  watchMinuteJob = renderWatchMinutes(watchlist).catch(() => {}).then(() => {
    watchMinuteJob = null;
    if (watchMinuteRepaint) {
      watchMinuteRepaint = false;
      drawWatchMinutes((state.overview && state.overview.watchlist) || watchlist);
    }
  });
  return watchMinuteJob;
}

async function renderWatchMinutes(watchlist) {
  const canvas = $('#watchChart');
  const note = $('#overviewWatchNote');
  const legend = $('#watchLegend');
  if (!canvas) return;
  const list = (watchlist || []).filter((x) => x && x.code);
  if (!list.length) { if (note) note.textContent = '本次没有取到自选股行情'; return; }
  // 总览不在前台时元素宽度为 0，这时不画：等切回「总览」会用缓存重画，否则会画出一张被拉伸的糊图
  if (!canvas.getBoundingClientRect().width) return;
  if (note) note.textContent = '正在取 ' + list.length + ' 只自选股的分时数据…';

  let results;
  try { results = await fetchWatchMinutes(list); }
  catch (err) { if (note) note.textContent = '分时数据取回失败：' + ((err && err.message) || err); return; }
  // 等网络这段时间里用户可能已经切走、窗口也可能被改过大小，再确认一次宽度
  if (!canvas.getBoundingClientRect().width) return;

  // 第一遍：每只股票各自算出「相对昨收的涨跌幅」
  const raw = [];
  const missing = [];
  results.forEach((r, i) => {
    const ticks = r.ok ? (r.quote.points || []).filter((p) => Number.isFinite(Number(p.price))) : [];
    if (!ticks.length) { missing.push(r.stock); return; }
    raw.push({
      name: r.stock.name || r.stock.code,
      code: String(r.stock.code),
      color: WATCH_MINUTE_COLORS[i % WATCH_MINUTE_COLORS.length],
      isTrading: !!r.quote.isTrading,
      date: r.quote.date,
      prev: Number(r.quote.prevClose) || 0,
      ticks: ticks.map((p) => ({ time: String(p.time), price: Number(p.price) }))
    });
  });

  if (!raw.length) {
    if (legend) legend.innerHTML = '';
    if (note) note.textContent = list.length + ' 只自选股的分时数据都没取到（上游可能限流，稍后会自动重试）';
    return;
  }

  // 第二遍：各家分时长度其实不一样（沪市会带 15:00–15:30 的盘后价，深市到 15:00），
  // 所以先取所有时刻的并集当统一横轴，再让每条线按时刻对齐，避免长短不一被拉成不同刻度。
  const minuteOf = (t) => { const c = String(t || '').split(':'); return (Number(c[0]) || 0) * 60 + (Number(c[1]) || 0); };
  const seenTick = new Set();
  const axis = [];
  raw.forEach((r) => r.ticks.forEach((t) => { if (!seenTick.has(t.time)) { seenTick.add(t.time); axis.push(t.time); } }));
  axis.sort((a, b) => minuteOf(a) - minuteOf(b));

  const usable = raw.map((r) => {
    const byTime = new Map(r.ticks.map((t) => [t.time, t.price]));
    const toPct = (price) => (r.prev ? ((Number(price) - r.prev) / r.prev) * 100 : 0);
    let cursor = r.ticks[0].price;
    const points = axis.map((t) => {
      if (byTime.has(t)) cursor = byTime.get(t);
      // 某个时刻这只股票没成交，就用最近一次成交价顶格：保证 5 条线的横轴长度完全一致
      return { date: t, value: toPct(cursor) };
    });
    return {
      name: r.name, code: r.code, color: r.color, isTrading: r.isTrading, date: r.date,
      lastPct: points[points.length - 1].value, points: points
    };
  });

  // 横轴只在整点/半点写标签：242 个点自动抽稀出来会得到 10:04 这种不好读的时刻。
  // 注意 11:30 与 13:00 在数据里是紧挨着的两个点（午休不占横轴），两个都写会叠在一起，只保留 13:00。
  // 卡片窄的时候还要再少写几个，否则 13:00 会和 14:00 挤到一起。
  const width = canvas.getBoundingClientRect().width;
  const mark = { '09:30': 1, '10:30': 1, '13:00': 1, '14:00': 1, '15:00': 1 };
  if (width >= 600) mark['15:30'] = 1;      // 沪市盘后那一段，窄卡片放不下就不标
  if (width >= 700) mark['11:30'] = 1;

  try {
    drawLineSeries(canvas, usable, {
      refLine: 0, labelStep: 1,
      labelOf: (pt) => (mark[pt.date] ? pt.date : ''),
      fmtY: (v) => Number(v).toFixed(2) + '%'
    });
  } catch (err) {
    if (note) note.textContent = '分时图绘制失败：' + ((err && err.message) || err);
    return;
  }

  if (legend) {
    legend.innerHTML = usable.map((s) => {
      const cls = s.lastPct > 0 ? 'up' : s.lastPct < 0 ? 'down' : 'dim';
      return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) +
        ' <span class="dim">' + esc(s.code) + '</span>' +
        ' <span class="num ' + cls + '">' + (s.lastPct > 0 ? '+' : '') + s.lastPct.toFixed(2) + '%</span></span>';
    }).join('');
  }

  if (note) {
    const up = usable.filter((s) => s.lastPct > 0).length;
    const down = usable.filter((s) => s.lastPct < 0).length;
    const flat = usable.length - up - down;
    const dayRaw = String(usable[0].date || '');
    const day = /^\d{8}$/.test(dayRaw) ? dayRaw.slice(0, 4) + '-' + dayRaw.slice(4, 6) + '-' + dayRaw.slice(6, 8) : dayRaw;
    const bits = [
      '自选股 ' + usable.length + ' 只分时（纵轴＝相对昨收的涨跌幅）',
      '上涨 ' + up + ' 只 · 下跌 ' + down + ' 只' + (flat ? ' · 平盘 ' + flat + ' 只' : '')
    ];
    if (day) bits.push('交易日 ' + day);
    if (usable.every((s) => !s.isTrading)) bits.push('当前非交易时段，显示的是最近一个交易日');
    if (missing.length) bits.push('没取到分时：' + missing.map((m) => m.name || m.code).join('、'));
    note.textContent = bits.join(' · ');
  }
}

/** 总览的「关注品种」：棉花 / 焦煤 / 焦炭，动力煤没有连续行情时如实说明。 */
function renderOverviewCommodity(list) {
  const el = $('#overviewCommodity');
  if (!el) return;
  const wanted = ['CF0', 'JM0', 'J0', 'ZC0'];
  const rows = wanted.map((sym) => (list || []).find((x) => x.symbol === sym)).filter(Boolean);
  if (!rows.length) { el.innerHTML = '<span class="dim">本次没有取到关注品种行情</span>'; return; }
  el.innerHTML = '<table class="mini-table"><thead><tr><th>品种</th><th>最新</th><th>涨跌幅</th><th>最高</th><th>最低</th><th>持仓量</th></tr></thead><tbody>' +
    rows.map((f) => {
      const name = esc(f.name || f.symbol);
      if (!f.available || f.last === null || f.last === undefined) {
        return '<tr><td>' + name + '</td><td colspan="5" class="dim">该合约当前无行情</td></tr>';
      }
      return '<tr><td>' + name + '</td>' +
        '<td class="num ' + fmt.cls(f.changePct) + '">' + fmt.num(f.last) + '</td>' +
        '<td class="num ' + fmt.cls(f.changePct) + '">' + fmt.pct(f.changePct) + '</td>' +
        '<td class="num">' + fmt.num(f.high) + '</td>' +
        '<td class="num">' + fmt.num(f.low) + '</td>' +
        '<td class="num">' + fmt.num(f.openInterest, 0) + '</td></tr>';
    }).join('') + '</tbody></table>' +
    '<div class="hint" style="margin-top:8px">动力煤 ZC 没有连续合约行情，煤价请看「煤炭库存 / 进口」页的现货价台账</div>' +
    dataStamp(state.overview && state.overview.updatedAt);
}

function renderOverview(data) {
  state.overview = data;
  try { renderIndexStrip(data.indexes); }
  catch (err) { const el = $('#indexStrip'); if (el) el.innerHTML = '<span class="dim">指数数据不可用</span>'; }

  $('#watchCards').innerHTML = (data.watchlist || []).map((s) => {
    const q = s.quote || {};
    return (
      '<div class="card stock-card" data-code="' + s.code + '">' +
      '<div style="display:flex; justify-content:space-between; align-items:baseline">' +
      '<div><span class="name">' + esc(s.name) + '</span> <span class="code">' + s.code + '</span></div>' +
      '<div class="num ' + fmt.cls(q.changePct) + '" style="font-size:13px">' + fmt.pct(q.changePct) + '</div></div>' +
      '<div class="price num ' + fmt.cls(q.changePct) + '">' + fmt.num(q.price, 2) + '</div>' +
      '<div class="hint">高 ' + fmt.num(q.high) + ' · 低 ' + fmt.num(q.low) + ' · 额 ' + fmt.big(q.amountYuan) + '</div>' +
      '<div class="tags">' + (s.tags || []).map((t) => '<span class="chip">' + esc(t) + '</span>').join('') + '</div>' +
      '</div>'
    );
  }).join('');

  $$('#watchCards .stock-card').forEach((card) => {
    card.addEventListener('click', () => openAnalysis(card.dataset.code));
  });

  try { renderOverviewCommodity(data.commodities || []); }
  catch (err) { cardError('#overviewCommodity', err); }

  // 分时数据要并行拉 5 只股票，属于慢操作：函数内部自行兜底错误，这里不 await
  drawWatchMinutes(data.watchlist);

  api('/api/news?limit=120').then((feed) => {
    $('#overallSentiment').innerHTML = sentimentBlock(feed.overall, { termLimit: 0 }) +
      termBars(feed.overall && feed.overall.topTerms) +
      '<div class="hint" style="margin-top:10px">已扫描 ' + feed.totalScanned + ' 条，主题命中 ' + feed.matched + ' 条</div>' +
      dataStamp(feed.updatedAt, data.updatedAt);
  }).catch((err) => cardError('#overallSentiment', err, '新闻源可能被限流，稍后会自动重试'));

  const coal = data.coal || {};
  try {
  $('#overviewCoal').innerHTML =
    '<div class="kv">' + (coal.ports || []).map((p) =>
      '<dt>' + esc(p.port) + '</dt><dd>' + (p.latest ? fmt.num(p.latest.value, 1) + ' 万吨 ' +
        '<span class="' + fmt.cls(p.delta) + '">' + (p.delta > 0 ? '↑' : p.delta < 0 ? '↓' : '→') + fmt.num(Math.abs(p.delta || 0), 1) + '</span>'
        : '—') + '</dd>').join('') +
    '<dt>动力煤5500K</dt><dd>' + (coal.latestPrice ? fmt.num(coal.latestPrice.value, 0) + ' 元/吨' : '—') + '</dd>' +
    '</div>' +
    (coal.provenance && coal.provenance.containsSampleData
      ? '<div class="notice" style="margin-top:10px">' + esc(coal.provenance.disclaimer) + '</div>' : '') +
    dataStamp(data.updatedAt);
  } catch (err) { cardError('#overviewCoal', err); }

  loadOverviewExtras(data.updatedAt);
}

/* --------------------------------- 自选股 --------------------------------- */

/* 最近一次渲染出来的自选股，供「查询结果里是否已在自选」判断用 */
let lastWatchlist = [];

function watchItem(code) {
  return lastWatchlist.find((s) => s.code === code) || null;
}

function renderStockTable(list) {
  const items = list.watchlist || [];
  lastWatchlist = items;

  const count = $('#watchCount');
  if (count) count.textContent = items.length ? items.length + ' 只 · 可增删改' : '还没添加';

  const rows = items.map((s, i) => {
    const q = s.quote || {};
    const tags = (s.tags || []).map((t) => '<span class="tag-mini">' + esc(t) + '</span>').join('');
    return (
      '<tr data-code="' + s.code + '"><td><b>' + esc(s.name) + '</b> <span class="dim">' + s.code + '</span></td>' +
      '<td class="num">' + fmt.num(q.price, 2) + '</td>' +
      '<td class="num ' + fmt.cls(q.changePct) + '">' + fmt.pct(q.changePct) + '</td>' +
      '<td class="num">' + fmt.big(q.amountYuan) + '</td>' +
      '<td class="num">' + fmt.num(q.turnoverRate, 2) + '%</td>' +
      '<td class="num">' + fmt.num(q.volumeRatio, 2) + '</td>' +
      '<td class="wl-tags">' + (tags || '<span class="dim">—</span>') + '</td>' +
      '<td class="wl-ops">' +
        '<button data-op="up" title="上移"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button data-op="down" title="下移"' + (i === items.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button data-op="edit" title="编辑标签与关注要点">编辑</button>' +
        '<button data-op="del" class="danger" title="从自选股删除">删除</button>' +
      '</td></tr>'
    );
  }).join('');

  $('#stockTable').innerHTML = items.length
    ? '<table><thead><tr><th>名称</th><th>最新</th><th>涨跌幅</th><th>成交额</th><th>换手</th><th>量比</th><th>标签</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>'
    : '<div class="hint">自选股现在是空的。在上面输入 6 位代码或名称，点「查询」就能加回来。</div>';

  $$('#stockTable tbody tr').forEach((tr) => {
    const code = tr.dataset.code;
    tr.addEventListener('click', () => openAnalysis(code));
    tr.querySelectorAll('.wl-ops button').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();   // 别把「点行开体检」也触发了
        const op = btn.dataset.op;
        if (op === 'del') armDeleteButton(btn, code);
        else if (op === 'edit') openWatchEditor(code);
        else moveWatchStock(code, op === 'up' ? -1 : 1);
      });
    });
  });
}

/* ---------------------------------------------------------------
 * 自选股增删改：写的是 server/data/watchlist.json
 * 删除做「点两次」而不是 confirm()——应用窗口里不弹阻塞式对话框
 * --------------------------------------------------------------- */

function watchError(err) {
  const msg = String((err && err.message) || err);
  if (/Failed to fetch|连不上本地服务/.test(msg)) return '连不上本地服务，改不动自选股';
  return msg;
}

async function watchPost(action, payload) {
  return api('/api/watchlist/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

/** 改完自选股要把各页缓存标记清掉，否则总览/股吧还拿着旧名单。 */
async function afterWatchlistChange(message, wl) {
  if (wl && Array.isArray(wl.stocks)) {
    lastWatchlist = wl.stocks;
    state.watchlist = { stocks: wl.stocks, settings: wl.settings };
  } else {
    state.watchlist = null;
  }
  loaded.overview = { at: 0, busy: false, error: null };
  loaded.stocks = { at: 0, busy: false, error: null };
  viewState('stocks').busy = false;
  loaded.guba = { at: 0, busy: false, error: null };
  if (message) toast(message, 'ok');
  await loadView('stocks', { force: true });
  renderQuickPicks('#gubaQuick', (c) => loadGuba(c));
  renderQuickPicks('#analysisQuick', (c) => openAnalysis(c));
  if (activeViewName() === 'overview') loadView('overview', { force: true });
}

/** 删除按钮：第一次点变成「确认删除」，3 秒内再点才真删。 */
function armDeleteButton(btn, code) {
  if (btn.dataset.armed === '1') {
    btn.dataset.armed = '';
    removeWatchStock(code);
    return;
  }
  btn.dataset.armed = '1';
  btn.classList.add('armed');
  btn.textContent = '确认删除';
  setTimeout(() => {
    if (btn.isConnected && btn.dataset.armed === '1') {
      btn.dataset.armed = '';
      btn.classList.remove('armed');
      btn.textContent = '删除';
    }
  }, 3000);
}

async function removeWatchStock(code) {
  const item = watchItem(code);
  try {
    const res = await watchPost('remove', { code: code });
    closeWatchResults();
    await afterWatchlistChange('已从自选股删除 ' + (item ? item.name + ' ' : '') + code, res.watchlist);
  } catch (err) {
    toast('删除失败：' + watchError(err), 'err');
  }
}

async function addWatchStock(code, name) {
  try {
    const res = await watchPost('add', { code: code, name: name || '' });
    closeWatchResults();
    const input = $('#wlInput');
    if (input) input.value = '';
    await afterWatchlistChange('已加入自选：' + (name ? name + ' ' : '') + code, res.watchlist);
  } catch (err) {
    toast('加入失败：' + watchError(err), 'err');
  }
}

async function moveWatchStock(code, delta) {
  try {
    const res = await watchPost('move', { code: code, delta: delta });
    await afterWatchlistChange('', res.watchlist);
  } catch (err) {
    toast('调整顺序失败：' + watchError(err), 'err');
  }
}

let watchEditCode = null;

function openWatchEditor(code) {
  const item = watchItem(code);
  if (!item) { toast('自选股里没有 ' + code, 'err'); return; }
  watchEditCode = code;
  $('#wlModalMeta').textContent = item.name + ' ' + item.code;
  $('#wlNameInput').value = item.name || '';
  $('#wlTagsInput').value = (item.tags || []).join(', ');
  $('#wlPointsInput').value = (item.watchPoints || []).join('\n');
  $('#wlModalHint').innerHTML = '标签最多 8 个（每个 ≤16 字），关注要点最多 10 条（每条 ≤60 字）。标签会显示在上表的「标签」列和总览卡片上。';
  const m = $('#wlModal');
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
  $('#wlNameInput').focus();
}

function closeWatchEditor() {
  const m = $('#wlModal');
  if (!m) return;
  m.classList.remove('open');
  m.setAttribute('aria-hidden', 'true');
  watchEditCode = null;
}

async function saveWatchEditor() {
  if (!watchEditCode) return;
  const code = watchEditCode;
  try {
    const res = await watchPost('update', {
      code: code,
      name: $('#wlNameInput').value,
      tags: $('#wlTagsInput').value,
      watchPoints: $('#wlPointsInput').value
    });
    closeWatchEditor();
    await afterWatchlistChange('已保存 ' + code + ' 的设置', res.watchlist);
  } catch (err) {
    $('#wlModalHint').innerHTML = '<span class="error">保存失败：' + esc(watchError(err)) + '</span>';
  }
}

/* ----------------------------- 选股（查询 + 加入） ----------------------------- */

let watchSearchBusy = false;

function closeWatchResults() {
  const box = $('#wlResults');
  if (!box) return;
  box.hidden = true;
  box.innerHTML = '';
}

async function searchWatchStock() {
  const box = $('#wlResults');
  const input = $('#wlInput');
  const keyword = String((input && input.value) || '').trim();
  if (!keyword) { toast('先填 6 位代码或名称关键字', 'warn'); return; }
  if (watchSearchBusy) return;

  watchSearchBusy = true;
  const btn = $('#wlSearchBtn');
  if (btn) { btn.disabled = true; btn.textContent = '查询中…'; }
  box.hidden = false;
  box.innerHTML = '<div class="loading">正在查询「' + esc(keyword) + '」…</div>';
  try {
    const data = await api('/api/stock/lookup?q=' + encodeURIComponent(keyword), { timeoutMs: 60000 });
    renderWatchResults(data);
  } catch (err) {
    box.innerHTML = '<div class="error">查询失败：' + esc(watchError(err)) + '</div>';
  } finally {
    watchSearchBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '查询'; }
  }
}

function renderWatchResults(data) {
  const box = $('#wlResults');
  const items = data.results || [];
  if (!items.length) {
    box.innerHTML = '<div class="hint">没搜到「' + esc(data.query) + '」。换个关键字，或者直接填 6 位代码。</div>';
    return;
  }
  const mine = new Set(lastWatchlist.map((s) => s.code));
  box.innerHTML =
    '<div class="wl-results-head">' + (data.mode === 'code' ? '代码精确查询' : '名称搜索') +
    ' · ' + items.length + ' 条' + (data.mode === 'code' ? '' : '（按代码或名称逐个加入）') + '</div>' +
    '<div class="wl-results-list">' +
    items.map((r) => (
      '<div class="wl-result" data-code="' + r.code + '" data-name="' + esc(r.name) + '">' +
      '<b>' + esc(r.name) + '</b> <span class="dim">' + r.code + '</span>' +
      '<span class="num ' + fmt.cls(r.changePct) + '">' + fmt.pct(r.changePct) + '</span>' +
      '<span class="num dim">' + fmt.num(r.price, 2) + '</span>' +
      (mine.has(r.code)
        ? '<span class="tag-mini">已在自选</span>'
        : '<button class="action wl-add">加入自选</button>') +
      '</div>'
    )).join('') +
    '</div>';
  box.querySelectorAll('.wl-add').forEach((b) => b.addEventListener('click', () => {
    const row = b.closest('.wl-result');
    addWatchStock(row.dataset.code, row.dataset.name);
  }));
}

/** 自选股页的「主力资金」：数据来自 /api/market 的 fundFlow（东方财富当日累计，已按自选股口径取回）。 */
async function loadStockFundFlow() {
  const el = $('#stockFundFlow');
  if (!el) return;
  try {
    const m = await api('/api/market');
    renderFundFlow(m.fundFlow, m.updatedAt);
  } catch (err) {
    el.classList.remove('loading');
    cardError('#stockFundFlow', err, '东方财富资金流接口可能被限流，稍后会自动重试');
  }
}

/** 日 K 线卡片：切股票时先清空上一只的图，避免串图。 */
function clearKline() {
  const meta = $('#klineMeta');
  if (meta) meta.textContent = '加载中…';
  const canvas = $('#klineChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
}

/** 画日 K 线（数据来自 /api/analysis 返回的 kline + ma）。 */
function renderKline(d) {
  const canvas = $('#klineChart');
  if (!canvas) return;
  const bars = (d && d.kline) || [];
  const meta = $('#klineMeta');
  if (!bars.length) {
    if (meta) meta.textContent = '未取得日 K 线数据（上游可能限流，随下一次体检重试）';
    return;
  }
  requestAnimationFrame(() => drawCandles(canvas, bars, d.ma || {}));
  if (meta) {
    meta.textContent = '数据区间 ' + bars[0].date + ' ~ ' + bars[bars.length - 1].date +
      ' · 共 ' + bars.length + ' 根 · 前复权（同花顺 / 东方财富）';
  }
}
/* --------------------------------- 舆情 ---------------------------------- */

async function renderNews() {
  const list = $('#newsList');
  list.innerHTML = '<li class="loading">加载中…</li>';
  const query = state.newsTopic ? '?topics=' + state.newsTopic + '&limit=100' : '?limit=120';
  try {
    const feed = await api('/api/news' + query);
    $('#newsMeta').textContent = '扫描 ' + feed.totalScanned + ' 条 · 命中 ' + feed.matched + ' 条 · 更新 ' + fmt.time(feed.updatedAt);
    list.innerHTML = feed.items.length ? feed.items.map(newsItemHtml).join('') : '<li class="dim">没有命中的新闻</li>';
  } catch (err) {
    list.innerHTML = '<li class="error">' + esc(err.message) + '</li>';
  }
}

/* ------------------------------ 棉花/大宗商品 ------------------------------ */

function renderCommodityCards(items) {
  $('#commodityCards').innerHTML = items.map((f) => {
    if (!f.available) {
      return '<div class="card"><div style="font-weight:600">' + esc(f.name) + '</div>' +
        '<div class="hint">' + esc(f.note || '暂无行情') + '</div>' +
        '<div class="hint" style="margin-top:6px">' + esc(f.group) + '</div></div>';
    }
    return (
      '<div class="card"><div style="display:flex; justify-content:space-between; align-items:baseline">' +
      '<div style="font-weight:600">' + esc(f.name) + '</div>' +
      '<div class="num ' + fmt.cls(f.changePct) + '">' + fmt.pct(f.changePct) + '</div></div>' +
      '<div class="num ' + fmt.cls(f.changePct) + '" style="font-size:22px; font-weight:600">' + fmt.num(f.last, 0) + '</div>' +
      '<div class="hint">' + esc(f.unit) + ' · 高 ' + fmt.num(f.high, 0) + ' 低 ' + fmt.num(f.low, 0) + '</div>' +
      '<div class="hint">持仓 ' + fmt.big(f.openInterest) + ' · 成交 ' + fmt.big(f.volume) + ' · ' + esc(f.date || '') + '</div>' +
      '<div class="tags" style="display:flex; gap:6px; margin-top:8px"><span class="chip">' + esc(f.group) + '</span></div></div>'
    );
  }).join('');
}

async function renderCommodity() {
  try {
    const futures = await api('/api/futures');
    state.commodity = futures;
    renderCommodityCards(futures.items);
  } catch (err) {
    $('#commodityCards').innerHTML = '<div class="card error">' + esc(err.message) + '</div>';
  }

  try {
    const cotton = await api('/api/futures/CF0/daily?limit=180');
    const closes = cotton.items.map((k) => k.close);
    const ma20 = closes.map((_, i) => (i >= 19 ? closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20 : null));
    drawLineSeries($('#cottonChart'), [
      { name: '收盘', color: '#4a9eff', points: cotton.items.map((k) => ({ date: k.date, value: k.close })) },
      { name: 'MA20', color: '#ffb020', points: cotton.items.map((k, i) => ({ date: k.date, value: ma20[i] })).filter((p) => p.value !== null) }
    ], { fmtY: (v) => Number(v).toFixed(0) });
  } catch (err) { /* 图表失败不阻塞页面 */ }

  try {
    const jm = await api('/api/futures/JM0/daily?limit=180');
    const closes = jm.items.map((k) => k.close);
    const ma20 = closes.map((_, i) => (i >= 19 ? closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20 : null));
    drawLineSeries($('#coalChart'), [
      { name: '收盘', color: '#4a9eff', points: jm.items.map((k) => ({ date: k.date, value: k.close })) },
      { name: 'MA20', color: '#ffb020', points: jm.items.map((k, i) => ({ date: k.date, value: ma20[i] })).filter((p) => p.value !== null) }
    ], { fmtY: (v) => Number(v).toFixed(0) });
  } catch (err) { /* ignore */ }

  try {
    const feed = await api('/api/news?topics=cotton,coal,commodity&limit=60');
    $('#commodityNews').innerHTML = feed.items.length ? feed.items.map(newsItemHtml).join('') : '<li class="dim">暂无相关新闻</li>';
  } catch (err) {
    $('#commodityNews').innerHTML = '<li class="error">' + esc(err.message) + '</li>';
  }
}

/* -------------------------------- 煤炭库存 -------------------------------- */

const PORT_COLORS = ['#4a9eff', '#ffb020', '#c084fc', '#17c964', '#ff4d4f', '#22d3ee'];

function renderCoal(series) {
  state.coal = series;
  const ports = series.ports || [];
  const categories = ports.map((p) => p.port);
  const latest = ports.map((p) => (p.latest ? p.latest.value : null));
  const prev = ports.map((p) => (p.prev ? p.prev.value : null));
  const result = drawGroupedBars($('#coalBarChart'), categories, [
    { name: '上期', color: '#334155', values: prev },
    { name: '最新', color: '#4a9eff', values: latest }
  ]);
  $('#coalBarLegend').innerHTML = (result.colors || [])
    .map((c) => '<span><i style="background:' + c.color + '"></i>' + esc(c.name) + '</span>').join('') +
    '<span class="dim">单位：万吨（最新一期 vs 上一期）</span>';

  drawLineSeries($('#coalTotalChart'), [
    { name: '合计', color: '#4a9eff', points: series.totals || [] }
  ], { fmtY: (v) => Number(v).toFixed(0) });

  if ((series.priceSeries || []).length) {
    drawLineSeries($('#coalPriceChart'), [
      { name: '动力煤5500K', color: '#ffb020', points: series.priceSeries }
    ], { fmtY: (v) => Number(v).toFixed(0) });
  }

  $('#coalTable').innerHTML =
    '<table><thead><tr><th>港口</th><th>最新</th><th>上期</th><th>变化</th><th>数据来源</th></tr></thead><tbody>' +
    ports.map((p) => '<tr><td>' + esc(p.port) + '</td>' +
      '<td class="num">' + (p.latest ? fmt.num(p.latest.value, 1) : '—') + '</td>' +
      '<td class="num">' + (p.prev ? fmt.num(p.prev.value, 1) : '—') + '</td>' +
      '<td class="num ' + fmt.cls(p.delta) + '">' + (p.delta === null ? '—' : (p.delta > 0 ? '+' : '') + fmt.num(p.delta, 1) +
        ' (' + fmt.pct(p.deltaPct) + ')') + '</td>' +
      '<td class="dim">' + esc((p.latest && p.latest.source) || '—') + '</td></tr>').join('') +
    '</tbody></table>' +
    (series.provenance ? '<div class="notice" style="margin-top:10px">' + esc(series.provenance.disclaimer) +
      '<br>来源：' + esc((series.provenance.sources || []).join(' / ')) + '</div>' : '');
}

async function loadCoal() {
  try {
    renderCoal(await api('/api/coal/inventory'));
  } catch (err) {
    $('#coalTable').innerHTML = '<span class="error">' + esc(err.message) + '</span>';
  }
  try { renderCoalImport(await api('/api/coal/import')); }
  catch (err) { $('#importTable').innerHTML = '<span class="error">' + esc(err.message) + '</span>'; }
  try {
    const ex = await api('/api/coal/extract');
    renderImportExtract(ex);
    const rows = (ex.inventoryPoints || []).map((p) =>
      '<tr><td>' + p.date + '</td><td>' + esc(p.port) + '</td><td class="num">' + fmt.num(p.value, 1) + ' 万吨</td>' +
      '<td class="dim">' + esc((p.evidence || '').slice(0, 30)) + '</td></tr>').join('') +
      (ex.pricePoints || []).map((p) =>
      '<tr><td>' + p.date + '</td><td>动力煤5500K</td><td class="num">' + fmt.num(p.value, 0) + ' 元/吨</td>' +
      '<td class="dim">' + esc((p.evidence || '').slice(0, 30)) + '</td></tr>').join('');
    $('#coalExtract').innerHTML = rows
      ? '<div class="hint" style="margin-bottom:8px">在 ' + ex.scanned + ' 条煤炭新闻中抽取到 ' +
        ((ex.inventoryPoints || []).length + (ex.pricePoints || []).length) + ' 条读数，请人工复核后手工录入台账。</div>' +
        '<table><thead><tr><th>日期</th><th>对象</th><th>读数</th><th>原文片段</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div class="hint">在 ' + ex.scanned + ' 条煤炭新闻中未发现可抽取的明确读数（权威库存数字多为付费内容）。</div>';
  } catch (err) {
    $('#coalExtract').innerHTML = '<span class="error">' + esc(err.message) + '</span>';
  }
}

/* -------------------------------- 交易知识库 ------------------------------- */

/* 「阅读原文」只跳正版渠道：豆瓣书目页（已解析到具体版本）/ 微信读书 / 孔夫子旧书网。
   不提供、也不链接任何原书的电子版或 PDF。 */
function readOriginalLinks(b) {
  const kw = encodeURIComponent(String(b.title || '').replace(/[《》]/g, '').trim());
  const d = b.douban || null;
  const doubanUrl = d && d.url ? d.url : 'https://search.douban.com/book/subject_search?search_text=' + kw;
  const doubanLabel = '豆瓣' + (d && d.rating ? ' ' + d.rating : '') +
    (d && d.trial ? ' · 可试读' : (d && d.ebook ? ' · 有电子版' : ''));
  const doubanTip = d && d.matchedTitle
    ? '豆瓣书目页：' + d.matchedTitle + (d.cast ? '（' + d.cast + '）' : '')
    : '豆瓣书目检索页';
  return [
    [doubanLabel, doubanUrl, doubanTip],
    ['微信读书', 'https://weread.qq.com/web/search/global?keyword=' + kw, '微信读书：正版电子书与试读'],
    ['孔夫子', 'https://search.kongfz.com/product_result/?key=' + kw, '孔夫子旧书网：二手纸质书']
  ].map(([name, url, tip]) =>
    '<a class="read-btn" href="' + esc(url) + '" target="_blank" rel="noreferrer" title="' + esc(tip) + '">' + esc(name) + '</a>'
  ).join('');
}

function renderKnowledge(k) {
  state.knowledge = k;
  // 定时刷新会重画这两块，先记下用户已经展开的分组，重画后还原，避免正在读的内容被收起来
  const openPb = new Set(Array.from($('#playbook').querySelectorAll('details[open]')).map((d) => d.dataset.key));
  const openBooks = new Set(Array.from($('#books').querySelectorAll('details[open]')).map((d) => d.dataset.id));
  const titles = {
    trend: '趋势与买卖点', kline: 'K线信号', tape: '看盘与量价',
    value: '价值投资与估值', fundamental: '基本面与财报', strategy: '行业与竞争优势',
    psych: '交易心理', risk: '风控与仓位'
  };
  $('#playbook').innerHTML = Object.keys(titles).map((key) => {
    const items = k.playbook[key] || [];
    if (!items.length) return '';
    return '<details class="pb-sec" data-key="' + key + '"' + (openPb.has(key) ? ' open' : '') + '>' +
      '<summary>' + titles[key] + '</summary>' +
      '<ul>' + items.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>' +
      '</details>';
  }).join('');

  $('#checklist').innerHTML =
    '<ol style="margin:0; padding-left:20px">' + (k.playbook.checklist || []).map((t) => '<li style="margin-bottom:6px">' + esc(t) + '</li>').join('') + '</ol>' +
    '<div class="notice" style="margin-top:14px">' + esc(k.meta.sourceNote) + '</div>';

  const books = k.books || [];
  const playbookTag = $('#playbookTag');
  if (playbookTag) playbookTag.textContent = books.length + ' 本提炼';
  const declaredTiers = Array.isArray(k.tiers) ? k.tiers : [];
  const tierOrder = declaredTiers.concat(
    books.map((b) => b.tier).filter((t) => t && declaredTiers.indexOf(t) === -1)
  ).filter((t, i, arr) => arr.indexOf(t) === i);
  const bookCard = (b) =>
    '<details class="book" data-id="' + esc(b.id) + '"' +
    ' data-search="' + esc([b.title, b.author, b.theme, b.year, b.tier].filter(Boolean).join(' ').toLowerCase()) + '"' +
    (openBooks.has(b.id) ? ' open' : '') + '>' +
    '<summary>' +
    '<h4>' + esc(b.title) + '</h4>' +
    (b.verified ? '<span class="chip">书目已核对</span>' : '<span class="chip">版本待核对</span>') +
    '<span class="by">' + esc(b.author) + (b.year && b.year !== '-' ? ' · ' + esc(b.year) : '') + '</span>' +
    '</summary>' +
    '<div class="book-body">' +
    '<div class="hint">主题：' + esc(b.theme) + '</div>' +
    (b.note ? '<div class="hint">' + esc(b.note) + '</div>' : '') +
    '<h5>核心观点</h5><ul>' + (b.core || []).map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>' +
    '<h5>可执行方法</h5><ul>' + (b.methods || []).map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>' +
    '<h5>常见陷阱</h5><ul>' + (b.pitfalls || []).map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>' +
    '<div class="read-src"><span class="read-label">阅读原文</span>' + readOriginalLinks(b) +
    '<span class="read-tip">正版渠道，本站不提供原书内容</span></div>' +
    '</div></details>';
  $('#books').innerHTML = tierOrder.map((tier) => {
    const list = books.filter((b) => (b.tier || '') === tier);
    if (!list.length) return '';
    const note = (k.tierNotes || {})[tier];
    return '<h3 class="tier-head">' + esc(tier) + ' <span class="tag">' + list.length + ' 本</span>' +
      (note ? '<span class="tier-note">' + esc(note) + '</span>' : '') + '</h3>' +
      list.map(bookCard).join('');
  }).join('');
  applyBookFilter();
}

/* 知识库搜索：按书名 / 作者 / 主题过滤。只切显隐、不重建 DOM，免得把正在读的条目收起来 */
function applyBookFilter() {
  const box = $('#books');
  if (!box) return;
  const q = String(state.bookQuery || '').trim().toLowerCase();
  const books = $$('#books details.book');
  let shown = 0;
  books.forEach((d) => {
    const hit = !q || (d.dataset.search || '').indexOf(q) !== -1;
    d.hidden = !hit;
    if (hit) shown++;
  });
  // 该层一本都没命中，就把分层标题一起藏掉
  $$('#books .tier-head').forEach((head) => {
    let visible = 0;
    for (let el = head.nextElementSibling; el && !el.classList.contains('tier-head'); el = el.nextElementSibling) {
      if (el.classList.contains('book') && !el.hidden) visible++;
    }
    head.hidden = visible === 0;
  });
  const counter = $('#bookSearchCount');
  if (counter) counter.textContent = q ? shown + ' / ' + books.length + ' 本匹配' : books.length + ' 本';
}

function bindBookSearch() {
  const input = $('#bookSearch');
  if (!input) return;
  input.addEventListener('input', () => {
    state.bookQuery = input.value;
    applyBookFilter();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    input.value = '';
    state.bookQuery = '';
    applyBookFilter();
  });
}

/* ============================ 总览：涨跌家数 / 板块 / 快讯 ============================ */

function loadOverviewExtras(dataTime) {
  api('/api/market').then((m) => {
    const b = m.breadth || {};
    const el = $('#overviewBreadth');
    if (el) {
      el.innerHTML = b.total
        ? '<div class="kv"><dt>上涨</dt><dd class="up">' + b.up + ' 家</dd>' +
          '<dt>下跌</dt><dd class="down">' + b.down + ' 家</dd>' +
          '<dt>平盘</dt><dd>' + b.flat + ' 家</dd>' +
          '<dt>上涨占比</dt><dd>' + fmt.num(b.upRatio, 1) + '%</dd>' +
          '<dt>两市成交额</dt><dd>' + fmt.big(b.amountYuan) + '</dd></div>' +
          '<div class="bar-meter" style="margin-top:10px"><i class="bullish" style="left:0;width:' +
          Math.max(0, Math.min(100, Number(b.upRatio) || 0)) + '%"></i></div>' +
          '<div class="hint" style="margin-top:6px">红条为上涨家数占比（样本 ' + b.total + ' 只）</div>' +
          distBars(b) +
          dataStamp(m.updatedAt, dataTime)
        : '<span class="dim">暂无数据</span>';
    }
    // 自选股主力资金已移到「自选股」页渲染（见 loadStockFundFlow），总览不再重复画


    const allSectors = m.sectors || [];
    const secs = allSectors.slice(0, 10);
    const sectorUp = allSectors.filter((x) => Number(x.changePct) > 0).length;
    const sectorDown = allSectors.filter((x) => Number(x.changePct) < 0).length;
    const sel = $('#overviewSectors');
    if (sel) {
      sel.innerHTML = secs.length
        ? '<table class="mini-table"><thead><tr><th>板块</th><th>涨跌幅</th><th>成交额</th></tr></thead><tbody>' +
          secs.map((s) => '<tr><td>' + esc(s.name) + '</td>' +
            '<td class="num ' + fmt.cls(s.changePct) + '">' + fmt.pct(s.changePct) + '</td>' +
            '<td class="num">' + fmt.big(s.amountYuan) + '</td></tr>').join('') + '</tbody></table>' +
          '<div class="hint" style="margin-top:6px">来源：' + esc(m.sectorSource || '同花顺板块') +
          ' · 全市场 ' + allSectors.length + ' 个板块：上涨 ' + sectorUp + ' / 下跌 ' + sectorDown + '</div>' +
          dataStamp(m.updatedAt, dataTime)
        : '<span class="dim">暂无板块数据</span>';
    }
  }).catch((err) => {
    // 涨跌家数与板块来自同一个接口，失败时两张卡都给出重试入口
    cardError('#overviewBreadth', err, '同花顺/新浪板块接口可能被限流');
    cardError('#overviewSectors', err, '');
  });

  api('/api/news?limit=14').then((feed) => {
    const el = $('#overviewNews');
    if (!el) return;
    el.innerHTML = (feed.items || []).length
      ? feed.items.slice(0, 10).map(newsItemHtml).join('')
      : '<li class="dim">暂无快讯</li>';
  }).catch((err) => {
    const el = $('#overviewNews');
    if (el) el.innerHTML = '<li class="error">' + esc(err.message) +
      '　<button class="action ghost" data-card-retry="1">重试本页</button></li>';
  });
}

/* ================================ 数据源浏览 ================================ */

const SOURCE_IDS = ['cls', 'em724', 'ths', 'sina', 'wscn', 'jin10'];

function statusCls(status) {
  if (/已接入|完全/.test(status)) return 'ok';
  if (/部分/.test(status)) return 'mid';
  return 'no';
}

async function renderSources() {
  try {
    const data = await api('/api/sources');
    state.sources = data;
    const ids = (data.items || []).map((s) => s.id);
    const ordered = SOURCE_IDS.filter((id) => ids.indexOf(id) >= 0)
      .map((id) => data.items.find((s) => s.id === id))
      .concat(data.items.filter((s) => SOURCE_IDS.indexOf(s.id) < 0));
    $('#sourceList').innerHTML = ordered.map((s) =>
      '<button class="src-item" data-src="' + s.id + '" data-label="' + esc(s.label) + '">' +
      '<span>' + esc(s.label) + '<br><span class="desc">' + esc(s.describe) + '</span></span>' +
      '<span class="desc">查看 ›</span></button>').join('');
    $$('#sourceList .src-item').forEach((b) => b.addEventListener('click', () => loadSource(b.dataset.src)));

    $('#sourceSubst').innerHTML =
      '<table class="mini-table"><thead><tr><th>点名源</th><th>状态</th><th>说明</th></tr></thead><tbody>' +
      (data.substitutions || []).map((s) =>
        '<tr><td>' + esc(s.requested) + '</td>' +
        '<td><span class="badge ' + statusCls(s.status) + '">' + esc(s.status) + '</span></td>' +
        '<td class="dim" style="white-space:normal">' + esc(s.note) + '</td></tr>').join('') +
      '</tbody></table>';
  } catch (err) {
    $('#sourceList').innerHTML = '<span class="error">' + esc(err.message) + '</span>';
    return;
  }
  loadSource('cls');
}

async function loadSource(id) {
  $$('#sourceList .src-item').forEach((b) => b.classList.toggle('active', b.dataset.src === id));
  $('#sourceFeed').innerHTML = '<li class="loading">加载中…</li>';
  $('#sourceSentiment').innerHTML = '—';
  try {
    const feed = await api('/api/sources/' + id);
    $('#sourceFeedTitle').textContent = feed.label + ' · ' + feed.describe;
    $('#sourceSentiment').innerHTML =
      '<div class="hint" style="margin-bottom:8px">共 ' + feed.count + ' 条 · 更新 ' + fmt.time(feed.updatedAt) + '</div>' +
      sentimentBlock(feed.overall, { termLimit: 10 });
    $('#sourceFeed').innerHTML = (feed.items || []).length
      ? feed.items.map(newsItemHtml).join('')
      : '<li class="dim">该源本次没有返回条目（可能被限流或暂无更新）</li>';
  } catch (err) {
    $('#sourceFeed').innerHTML = '<li class="error">' + esc(err.message) + '</li>';
  }
}

/* ================================= 选股器 ================================= */

const SORT_LABELS = {
  changepercent: '涨跌幅', amount: '成交额', volume: '成交量', turnoverratio: '换手率',
  per: '市盈率 PE', pb: '市净率 PB', mktcap: '总市值', nmc: '流通市值', trade: '最新价', pricechange: '涨跌额'
};

const SC_FIELD_MAP = {
  scNode: 'node', scSort: 'sort', scMinChange: 'minChangePct', scMaxChange: 'maxChangePct',
  scMinTurn: 'minTurnover', scMaxTurn: 'maxTurnover', scMinPe: 'minPe', scMaxPe: 'maxPe',
  scMaxPb: 'maxPb', scMinCap: 'minMarketCapYi', scMaxCap: 'maxMarketCapYi',
  scKeyword: 'nameKeyword', scLimit: 'limit', scPages: 'pages'
};

async function renderScreener() {
  if (!state.screenerMeta) {
    try {
      const meta = await api('/api/screener/presets');
      state.screenerMeta = meta;
      $('#screenerPresets').innerHTML = '<span class="dim">预设规则：</span>' +
        meta.presets.map((p) => '<button data-preset="' + p.id + '" title="' + esc(p.describe) + '">' +
          esc(p.label) + '</button>').join('') +
        '<button data-preset="">自定义</button>';
      $('#scNode').innerHTML = Object.entries(meta.nodes).map(([k, v]) =>
        '<option value="' + k + '">' + esc(v) + '</option>').join('');
      $('#scSort').innerHTML = meta.sortFields.map((f) =>
        '<option value="' + f + '">' + esc(SORT_LABELS[f] || f) + '</option>').join('');
      $$('#screenerPresets button').forEach((b) => b.addEventListener('click', () => {
        state.screenerPreset = b.dataset.preset;
        $$('#screenerPresets button').forEach((x) => x.classList.toggle('active', x === b));
        runScreener();
      }));
      $('#scRun').addEventListener('click', () => runScreener());
      $('#scReset').addEventListener('click', () => {
        Object.keys(SC_FIELD_MAP).forEach((id) => {
          const el = document.getElementById(id);
          if (!el || id === 'scNode' || id === 'scSort') return;
          el.value = id === 'scLimit' ? '50' : id === 'scPages' ? '3' : '';
        });
        state.screenerPreset = '';
        $$('#screenerPresets button').forEach((x) => x.classList.toggle('active', x.dataset.preset === ''));
        runScreener();
      });
      state.screenerPreset = 'momentum';
      $$('#screenerPresets button').forEach((x) => x.classList.toggle('active', x.dataset.preset === 'momentum'));
    } catch (err) {
      $('#screenerPresets').innerHTML = '<span class="error">' + esc(err.message) + '</span>';
      return;
    }
  }
  runScreener();
}

function screenerQuery() {
  const q = new URLSearchParams();
  if (state.screenerPreset) q.set('preset', state.screenerPreset);
  Object.entries(SC_FIELD_MAP).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el && el.value !== '') q.set(key, el.value);
  });
  return q;
}

async function runScreener() {
  const box = $('#scResults');
  box.innerHTML = '<div class="loading">正在扫描行情节点…</div>';
  $('#scMeta').textContent = '正在抓取行情节点，请稍候…';
  $('#scCount').textContent = '—';
  try {
    const data = await api('/api/screener?' + screenerQuery().toString());
    $('#scMeta').textContent =
      (data.preset ? '预设「' + data.preset.label + '」：' + data.preset.describe + ' · ' : '') +
      '节点 ' + data.nodeLabel + ' · 扫描 ' + data.scanned + ' 只 · 命中 ' + data.matched +
      ' 只 · 更新 ' + fmt.time(data.updatedAt) + ' · 来源 ' + data.source;
    $('#scCount').textContent = data.matched + ' 只';
    box.innerHTML = (data.results || []).length
      ? '<table class="mini-table"><thead><tr><th>名称</th><th>最新</th><th>涨跌幅</th><th>换手</th>' +
        '<th>PE</th><th>PB</th><th>总市值(亿)</th><th>成交额</th></tr></thead><tbody>' +
        data.results.map((r) =>
          '<tr data-code="' + r.code + '"><td><b>' + esc(r.name) + '</b> <span class="dim">' + r.code + '</span></td>' +
          '<td class="num">' + fmt.num(r.price, 2) + '</td>' +
          '<td class="num ' + fmt.cls(r.changePct) + '">' + fmt.pct(r.changePct) + '</td>' +
          '<td class="num">' + fmt.num(r.turnoverRate, 2) + '%</td>' +
          '<td class="num">' + fmt.num(r.pe, 1) + '</td>' +
          '<td class="num">' + fmt.num(r.pb, 2) + '</td>' +
          '<td class="num">' + fmt.num(r.marketCapYi, 1) + '</td>' +
          '<td class="num">' + fmt.big(r.amountYuan) + '</td></tr>').join('') + '</tbody></table>' +
        '<div class="hint" style="margin-top:8px">点击任意一行可跳到「个股体检」逐条核对知识库规则。</div>'
      : '<div class="hint">没有符合条件的股票。可放宽条件、增大扫描页数，或改用「成交额榜」这类宽口径预设。</div>';
    $$('#scResults tbody tr').forEach((tr) =>
      tr.addEventListener('click', () => openAnalysis(tr.dataset.code)));
  } catch (err) {
    $('#scMeta').textContent = '';
    box.innerHTML = '<span class="error">' + esc(err.message) + '</span>';
  }
}

/* ================================== 股吧 ================================== */

async function renderQuickPicks(sel, onPick) {
  const el = $(sel);
  if (!el) return;
  try {
    const wl = state.watchlist || (await api('/api/watchlist'));
    state.watchlist = wl;
    el.innerHTML = (wl.stocks || []).map((s) =>
      '<button data-code="' + s.code + '">' + esc(s.name) + '</button>').join('');
    $$(sel + ' button').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.code)));
  } catch (err) {
    el.innerHTML = '<span class="error">自选股加载失败</span>';
  }
}

async function initGuba() {
  await renderQuickPicks('#gubaQuick', (code) => loadGuba(code));
  if (state.gubaCode) return;
  const first = (state.watchlist && state.watchlist.stocks[0] && state.watchlist.stocks[0].code) || '600519';
  loadGuba(first);
}

async function loadGuba(code) {
  const c = String(code || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(c)) {
    $('#gubaPosts').innerHTML = '<li class="error">请输入 6 位股票代码</li>';
    return;
  }
  state.gubaCode = c;
  $('#gubaCode').value = c;
  $('#gubaTitle').textContent = '股吧情绪 · ' + c;
  $('#gubaSentiment').innerHTML = '<div class="loading">加载中…</div>';
  $('#gubaPosts').innerHTML = '<li class="loading">加载中…</li>';
  $('#gubaHotWords').innerHTML = '—';
  try {
    const data = await api('/api/guba/' + c + '?limit=40');
    $('#gubaTitle').innerHTML = esc(data.board || c) +
      ' <a href="' + esc(data.url) + '" target="_blank" rel="noreferrer" class="dim" style="font-size:12px">原站 ›</a>';
    $('#gubaSentiment').innerHTML = sentimentBlock(data.sentiment, { termLimit: 14 }) +
      '<div class="hint" style="margin-top:10px">共抓取 ' + data.count + ' 帖。股吧情绪只反映散户语气，不代表基本面。</div>';
    $('#gubaHotWords').innerHTML = (data.hotWords || []).length
      ? '<div class="wl-btns">' + data.hotWords.map((w) =>
        '<button class="static">' + esc(w.word) + ' ×' + w.count + '</button>').join('') + '</div>'
      : '<span class="dim">样本量不足，暂无法统计热词</span>';
    const posts = (data.posts || []).slice().sort((a, b) =>
      ((b.sentiment && b.sentiment.score) || 0) - ((a.sentiment && a.sentiment.score) || 0));
    $('#gubaPosts').innerHTML = posts.length
      ? posts.map((p) => {
        const s = p.sentiment || {};
        const cls = s.score > 0 ? 'bullish' : s.score < 0 ? 'bearish' : 'neutral';
        return '<li><div class="meta">' + esc(p.author || '匿名') + '</div>' +
          '<div class="body"><div class="title"><a href="' + esc(p.url) + '" target="_blank" rel="noreferrer">' +
          esc(p.title) + '</a></div>' +
          '<div class="flags"><span class="senti-pill ' + cls + '">' + esc(s.label || '中性') +
          (s.score ? ' ' + (s.score > 0 ? '+' : '') + s.score : '') + '</span>' +
          (s.hits || []).map((h) => '<span class="chip">' + esc(h.term) + '</span>').join('') +
          '</div></div></li>';
      }).join('')
      : '<li class="dim">该股吧暂无帖子</li>';
    if (data.disclaimer) $('#gubaNotice').textContent = data.disclaimer;
  } catch (err) {
    $('#gubaPosts').innerHTML = '<li class="error">' + esc(err.message) + '</li>';
    $('#gubaSentiment').innerHTML = '<span class="error">加载失败</span>';
  }
}

/* ================================ 个股体检 ================================ */

const CHECK_LABELS = { pass: '通过', warn: '警示', fail: '不通过', na: '不适用', info: '提示' };

/** 记住最近一次体检的股票。 */
function setAnalysisCode(code) {
  state.analysisCode = code;
  try { localStorage.setItem(ANALYSIS_CODE_KEY, code); } catch (err) { /* 隐私模式下忽略 */ }
}

async function initAnalysis() {
  await renderQuickPicks('#analysisQuick', (code) => openAnalysis(code));
  if (state.analysisCode) return;
  let first = null;
  try { first = localStorage.getItem(ANALYSIS_CODE_KEY); } catch (err) { /* 隐私模式下忽略 */ }
  if (!/^\d{6}$/.test(String(first || ''))) {
    first = (state.watchlist && state.watchlist.stocks[0] && state.watchlist.stocks[0].code) || '600519';
  }
  openAnalysis(first);
}

async function openAnalysis(code) {
  const c = String(code || '').replace(/\D/g, '');
  if (/^\d{6}$/.test(c)) setAnalysisCode(c);
  switchView('analysis');
  if (!/^\d{6}$/.test(c)) {
    $('#analysisChecks').innerHTML = '<span class="error">请输入 6 位股票代码</span>';
    return;
  }
  $('#analysisCode').value = c;
  $('#analysisTitle').textContent = '加载中…';
  $('#analysisVerdict').innerHTML = '<div class="loading">加载中…</div>';
  $('#analysisIndicators').innerHTML = '—';
  $('#analysisChecks').innerHTML = '<div class="loading">正在按知识库规则逐条校验…</div>';
  $('#analysisNews').innerHTML = '—';
  $('#analysisGuba').innerHTML = '—';
  $('#analysisNewsList').innerHTML = '<li class="loading">加载中…</li>';
  clearKline();
  drawMinute(c);
  loadTrend(c);
  try {
    const d = await api('/api/analysis/' + c);
    if (!d.ready) throw new Error(d.error || '数据不足，无法体检');
    renderAnalysis(d);
  } catch (err) {
    $('#analysisTitle').textContent = c + ' 体检失败';
    $('#analysisVerdict').innerHTML = '<span class="error">' + esc(err.message) + '</span>';
    $('#analysisChecks').innerHTML = '';
  }
}

function renderAnalysis(d) {
  const q = d.quote || {};
  const t = d.tech || {};
  const c = d.counts || {};
  $('#analysisTitle').innerHTML = esc(d.name || '') + ' <span class="dim">' + d.code + '</span>';
  const vCls = d.verdictScore >= 4 ? 'bullish' : d.verdictScore <= -2 ? 'bearish' : 'neutral';
  $('#analysisVerdict').innerHTML =
    '<div><span class="senti-pill ' + vCls + '" style="font-size:13px">' + esc(d.verdict) + '</span>' +
    '<span class="dim" style="margin-left:8px">规则评分 ' + d.verdictScore + '</span></div>' +
    '<div class="kv" style="margin-top:12px">' +
    '<dt>最新价</dt><dd class="' + fmt.cls(q.changePct) + '">' + fmt.num(q.price, 2) + ' (' + fmt.pct(q.changePct) + ')</dd>' +
    '<dt>今开 / 昨收</dt><dd>' + fmt.num(q.open) + ' / ' + fmt.num(q.prevClose) + '</dd>' +
    '<dt>最高 / 最低</dt><dd>' + fmt.num(q.high) + ' / ' + fmt.num(q.low) + '</dd>' +
    '<dt>成交额</dt><dd>' + fmt.big(q.amountYuan) + '</dd>' +
    '<dt>换手 / 量比</dt><dd>' + fmt.num(q.turnoverRate, 2) + '% / ' + fmt.num(q.volumeRatio, 2) + '</dd>' +
    '<dt>总市值</dt><dd>' + fmt.big(q.marketCap) + '</dd>' +
    '<dt>行情来源</dt><dd>' + esc(d.quoteSource || '—') + ' <span class="dim">' + esc(q.updateTime || '') + '</span></dd>' +
    '</div>' +
    '<div class="hint" style="margin-top:10px">规则通过 ' + c.pass + ' · 警示 ' + c.warn +
    ' · 不通过 ' + c.fail + ' · 不适用 ' + c.na + '</div>';

  const ind = t.indicators || {};
  $('#analysisIndicators').innerHTML = '<div class="kv">' +
    '<dt>MA5 / MA10 / MA20</dt><dd>' + fmt.num(ind.ma5) + ' / ' + fmt.num(ind.ma10) + ' / ' + fmt.num(ind.ma20) + '</dd>' +
    '<dt>MA60（中期）</dt><dd>' + fmt.num(ind.ma60) + '</dd>' +
    '<dt>MACD（DIF/DEA/柱）</dt><dd>' + fmt.num(ind.dif, 3) + ' / ' + fmt.num(ind.dea, 3) + ' / ' + fmt.num(ind.macdHist, 3) + '</dd>' +
    '<dt>KDJ（K/D/J）</dt><dd>' + fmt.num(ind.k) + ' / ' + fmt.num(ind.d) + ' / ' + fmt.num(ind.j) + '</dd>' +
    '<dt>RSI(14)</dt><dd>' + fmt.num(ind.rsi14) + '</dd>' +
    '<dt>BOLL（上/中/下）</dt><dd>' + fmt.num(ind.bollUpper) + ' / ' + fmt.num(ind.bollMid) + ' / ' + fmt.num(ind.bollLower) + '</dd>' +
    '<dt>量能（对10日均量）</dt><dd>' + fmt.num(ind.volRatio, 2) + ' 倍</dd>' +
    '<dt>20日区间位置</dt><dd>' + fmt.num(ind.rangePosition20, 0) + '%</dd>' +
    '</div>' +
    '<div class="hint" style="margin-top:10px">技术面规则判定：<b>' + esc(t.trend || '—') + '</b>' +
    '（多头信号 ' + (t.bull || 0) + ' / 空头信号 ' + (t.bear || 0) + '）</div>' +
    '<div style="margin-top:10px">' + (t.signals || []).map((s) =>
      '<div class="signal ' + s.type + '"><span class="dot"></span><span>' + esc(s.text) + '</span></div>').join('') + '</div>';

  $('#analysisChecks').innerHTML = (d.checks || []).map((x) =>
    '<div class="check ' + x.status + '"><span class="mark">' + (CHECK_LABELS[x.status] || x.status) + '</span>' +
    '<span><b>' + esc(x.rule) + '</b><br><span class="hint">' + esc(x.detail) + '</span><br>' +
    '<span class="chip" style="display:inline-block; margin-top:4px">依据：' + esc(x.from) + '</span></span></div>').join('');

  const s = d.news && d.news.sentiment;
  $('#analysisNews').innerHTML = sentimentBlock(s, { termLimit: 12 });
  const flow = d.fundFlow;
  if (flow) {
    $('#analysisNews').insertAdjacentHTML('beforeend',
      '<h3 style="margin-top:16px">当日资金</h3><div class="kv">' +
      '<dt>主力净额</dt><dd class="' + fmt.cls(flow.mainNet) + '">' + fmt.big(flow.mainNet) + '</dd>' +
      '<dt>超大单净额</dt><dd class="' + fmt.cls(flow.superNet) + '">' + fmt.big(flow.superNet) + '</dd></div>');
  }
  $('#analysisNewsList').innerHTML = (d.news && d.news.items || []).length
    ? d.news.items.slice(0, 12).map(newsItemHtml).join('')
    : '<li class="dim">未检索到相关新闻</li>';

  const g = d.guba;
  $('#analysisGuba').innerHTML = g
    ? sentimentBlock(g.sentiment, { termLimit: 12 }) +
      '<div class="hint" style="margin-top:10px">共 ' + g.count + ' 帖 · ' +
      '<a href="' + esc(g.url) + '" target="_blank" rel="noreferrer">打开原股吧 ›</a></div>' +
      ((g.hotWords || []).length
        ? '<div class="wl-btns" style="margin-top:8px">' + g.hotWords.slice(0, 10).map((w) =>
          '<button class="static">' + esc(w.word) + ' ×' + w.count + '</button>').join('') + '</div>'
        : '') +
      '<div style="margin-top:10px"><button class="action ghost" id="analysisGubaOpen">在「股吧」页查看帖子</button></div>'
    : '<span class="dim">未取到股吧数据</span>';
  const btn = document.getElementById('analysisGubaOpen');
  if (btn) btn.addEventListener('click', () => { switchView('guba'); loadGuba(d.code); });

  state.analysisData = d;
  renderKline(d);

  $('#analysisNotice').innerHTML = '<div class="notice">' +
    esc(d.disclaimer || '本页只判断「是否满足自定交易规则」，不预测涨跌，也不构成投资建议。') + '</div>';
}

/** 分时摘要：昨收 / 最新 / 日内高低 / 均价，用于填充分时卡片。 */
function setMinuteMeta(m) {
  const el = $('#minuteMeta');
  if (!el) return;
  if (!m) { el.innerHTML = '<dt>状态</dt><dd>暂无分时数据（可能未开盘或接口限流）</dd>'; return; }
  const chg = Number.isFinite(m.prevClose) && m.prevClose ? ((m.last - m.prevClose) / m.prevClose) * 100 : null;
  // 数据源的 isTrading 标记会滞后（收盘后仍返回 1），只对「当天」的数据信任它
  const raw = String(m.date || '');
  const pad2 = (x) => String(x).padStart(2, '0');
  const t = new Date();
  const today = '' + t.getFullYear() + pad2(t.getMonth() + 1) + pad2(t.getDate());
  m.stateText = raw === today ? (m.isTrading ? '交易中' : '已收盘') : '历史交易日';
  m.dateText = /^\d{8}$/.test(raw) ? raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8) : (raw || '—');
  el.innerHTML =
    '<dt>昨收</dt><dd>' + fmt.num(m.prevClose) + '</dd>' +
    '<dt>最新</dt><dd class="' + fmt.cls(chg) + '">' + fmt.num(m.last) + ' (' + fmt.pct(chg) + ')</dd>' +
    '<dt>日内最高 / 最低</dt><dd>' + fmt.num(m.high) + ' / ' + fmt.num(m.low) + '</dd>' +
    '<dt>分时均价</dt><dd>' + fmt.num(m.avg) + '</dd>' +
    '<dt>数据时间</dt><dd>' + esc(m.dateText) + ' <span class="dim">' + m.stateText + '</span></dd>' +
    '<dt>采样点</dt><dd>' + m.samples + ' 个</dd>';
}

async function drawMinute(code) {
  const canvas = $('#minuteChart');
  if (!canvas) return;
  try {
    const data = await api('/api/ths/' + code + '/minute');
    const points = data.points || [];
    if (!points.length) { setupCanvas(canvas); return; }
    const price = points.map((p) => ({ date: p.time, value: p.price })).filter((p) => Number.isFinite(p.value));
    const avg = points.map((p) => ({ date: p.time, value: p.avgPrice })).filter((p) => Number.isFinite(p.value));
    if (!price.length) { setupCanvas(canvas); setMinuteMeta(null); return; }
    drawLineSeries(canvas, [
      { name: '价格', color: '#4a9eff', points: price },
      { name: '均价', color: '#ffb020', points: avg.length ? avg : price }
    ], {
      fmtY: (v) => Number(v).toFixed(2),
      refLine: data.prevClose
    });
    if (data.date) canvas.setAttribute('data-note', data.date + (data.isTrading ? ' 交易中' : ' 已收盘'));
    setMinuteMeta({
      prevClose: Number(data.prevClose),
      last: price[price.length - 1].value,
      high: Math.max.apply(null, price.map((p) => p.value)),
      low: Math.min.apply(null, price.map((p) => p.value)),
      avg: avg.length ? avg[avg.length - 1].value : null,
      date: data.date,
      isTrading: data.isTrading,
      samples: price.length
    });
  } catch (err) { setMinuteMeta(null); }
}

/* ============================== 煤炭进口台账 ============================== */

const IMPORT_COLORS = ['#4a9eff', '#ffb020', '#c084fc', '#22d3ee'];

function renderCoalImport(series) {
  state.coalImport = series;
  const groups = (series.groups || []).filter((g) => (g.points || []).length);
  if (!groups.length) {
    $('#importTable').innerHTML = '<span class="dim">台账为空，可在下方导入 CSV。</span>';
    return;
  }
  const periods = [];
  for (const g of groups) for (const p of g.points) if (periods.indexOf(p.period) < 0) periods.push(p.period);
  periods.sort();
  const recent = periods.slice(-12);
  const datasets = groups.slice(0, 4).map((g, i) => ({
    name: g.variety,
    color: IMPORT_COLORS[i % IMPORT_COLORS.length],
    values: recent.map((per) => {
      const hit = g.points.find((p) => p.period === per);
      return hit ? hit.value : null;
    })
  }));
  const res = drawGroupedBars($('#importChart'), recent.map((p) => p.slice(2).replace('-', '/')), datasets);
  $('#importLegend').innerHTML = (res.colors || []).map((c) =>
    '<span><i style="background:' + c.color + '"></i>' + esc(c.name) + '</span>').join('') +
    '<span class="dim">单位：万吨（月度进口量，最近 12 个月）</span>';

  $('#importTable').innerHTML =
    '<table class="mini-table"><thead><tr><th>品种</th><th>最新月份</th><th>进口量</th>' +
    '<th>环比</th><th>同比(算)</th><th>来源</th></tr></thead><tbody>' +
    groups.map((g) => '<tr><td>' + esc(g.variety) + '</td><td>' + esc(g.latest.period) + '</td>' +
      '<td class="num">' + fmt.num(g.latest.value, 1) + ' 万吨</td>' +
      '<td class="num ' + fmt.cls(g.momPct) + '">' + fmt.pct(g.momPct) + '</td>' +
      '<td class="num ' + fmt.cls(g.yoyComputed) + '">' + fmt.pct(g.yoyComputed) + '</td>' +
      '<td class="dim">' + esc(g.latest.source) + '</td></tr>').join('') +
    '</tbody></table>' +
    (series.provenance ? '<div class="notice" style="margin-top:10px">' + esc(series.provenance.disclaimer) +
      '<br>来源：' + esc((series.provenance.sources || []).join(' / ')) + '</div>' : '');
}

function renderImportExtract(ex) {
  const el = $('#importExtract');
  if (!el) return;
  const pts = ex.importPoints || [];
  const notes = ex.yoyNotes || [];
  const rows = pts.map((p) =>
    '<tr><td>' + esc(p.period) + '</td><td>' + esc(p.variety) + '</td>' +
    '<td class="num">' + fmt.num(p.value10kt, 1) + ' 万吨</td>' +
    '<td class="num ' + fmt.cls(p.yoyPct) + '">' +
    (p.yoyPct === null || p.yoyPct === undefined ? '—' : fmt.pct(p.yoyPct)) + '</td>' +
    '<td class="dim" style="white-space:normal">' + esc((p.evidence || '').slice(0, 40)) + '</td></tr>').join('');
  const noteRows = notes.map((n) =>
    '<tr><td>' + esc(n.date) + '</td><td colspan="4" class="dim" style="white-space:normal">' +
    esc(n.text) + ' —— ' + esc((n.title || '').slice(0, 36)) + '</td></tr>').join('');
  el.innerHTML = pts.length
    ? '<div class="hint" style="margin-bottom:8px">在 ' + ex.scanned + ' 条煤炭相关新闻中抽取到 ' + pts.length +
      ' 条进口读数、' + notes.length + ' 条同比表述，请人工复核后录入台账。</div>' +
      '<table class="mini-table"><thead><tr><th>月份</th><th>品种</th><th>进口量</th><th>同比</th><th>原文片段</th></tr></thead><tbody>' +
      rows + noteRows + '</tbody></table>'
    : '<div class="hint">在 ' + ex.scanned + ' 条煤炭相关新闻中未发现明确的进口量数字。' +
      '「8月份，我国进口煤炭4209万吨」这类写法的命中率最高，无月份的句子不会臆造月份。</div>';
}

/* ====================== 手机访问 / PWA / 窄屏适配 ====================== */

/** 服务端给的局域网信息（地址、二维码、防火墙提示），手机访问面板用。 */
const netInfo = { data: null, error: null, sw: 'idle', install: null };

/** 把每个 <table> 包进可横向滚动的容器：窄屏上表格才不会把整页撑宽。 */
function wrapTables(scope) {
  const rootEl = scope || document;
  const tables = Array.from(rootEl.querySelectorAll ? rootEl.querySelectorAll('table') : []);
  if (rootEl.tagName === 'TABLE') tables.push(rootEl);
  for (const t of tables) {
    const parent = t.parentElement;
    if (!parent || parent.classList.contains('table-scroll')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    parent.insertBefore(wrap, t);
    wrap.appendChild(t);
  }
}

/**
 * 页面上的表格是各页渲染函数随时塞进去的（还会自动刷新），
 * 与其改十几处渲染代码，不如盯住 DOM：谁插进来就包一层。
 */
function watchTables() {
  wrapTables(document);
  if (typeof MutationObserver !== 'function') return;
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!n || n.nodeType !== 1) continue;
        if (n.tagName === 'TABLE' || (n.querySelector && n.querySelector('table'))) wrapTables(n);
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

function netNote(text, kind) {
  return '<div class="net-note' + (kind ? ' ' + kind : '') + '">' + text + '</div>';
}

/** 手机访问面板内容。地址与二维码来自 /api/net（服务端按真实网卡枚举）。 */
function renderNetPanel() {
  const body = $('#netBody');
  const panel = $('#netPanelBody');
  const d = netInfo.data;

  if (netInfo.error) {
    const html = '<div class="notice">取不到局域网地址：' + esc(netInfo.error) + '　' +
      '<button class="action ghost" data-net-retry="1">重试</button></div>';
    if (body) body.innerHTML = html;
    if (panel) panel.innerHTML = html;
    return;
  }
  if (!d) return;

  const primary = d.primary;
  const urls = d.hosts || [];
  const hosts = urls.length
    ? '<div class="net-hosts">这台电脑的其它可用地址：' + urls.map((h) => '<code>' + esc(h.url) + '</code>（' + esc(h.iface) + (h.virtual ? ' · 虚拟网卡' : '') + '）').join('　') + '</div>'
    : '';

  // 服务没监听 0.0.0.0 时，手机一定连不上——先说清楚怎么改，别让人干试
  const expose = d.lanExposed
    ? ''
    : netNote('<b>服务当前只监听 ' + esc(d.host) + '，手机连不上。</b>用桌面的「启动工作站」快捷方式重启即可（默认监听全部网卡）。', 'bad');

  if (!primary) {
    const html = '<div class="notice">没有检测到可用的局域网地址：这台电脑可能没连 Wi-Fi 或网线。</div>' + expose;
    if (body) body.innerHTML = html;
    if (panel) panel.innerHTML = html;
    return;
  }

  const qr = d.qr
    ? '<div class="qr-box">' + d.qr.svg + '</div>'
    : '<div class="qr-box" style="width:172px;height:172px"></div>';

  const swNote = netInfo.sw === 'ok'
    ? ''
    : netNote('离线外壳没启用（' + esc(netInfo.sw === 'insecure' ? '当前是局域网 http 地址，浏览器只在 HTTPS 或 localhost 下允许启用' : '浏览器不支持或注册失败') + '）。在线使用完全不受影响。', 'warn');

  // 异地访问（Tailscale）：手机装上 Tailscale 登同一账号后，4G / 别家 Wi-Fi 也能连
  const ts = d.tailscale;
  const tsQr = d.tailscaleQr ? '<div class="qr-box">' + d.tailscaleQr.svg + '</div>' : '';
  const tsBlock = ts
    ? [
        '<div class="net-sec">异地访问<span class="tag">4G / 别家 Wi-Fi 也能连</span></div>',
        '<div class="net-url">',
        '  <span class="lbl">手机浏览器打开</span>',
        '  <code>' + esc(ts.url) + '</code>',
        '</div>',
        '<div class="net-qr">',
        '  ' + tsQr,
        '  <div class="qr-side">',
        '    <ol>',
        '      <li>手机装 <b>Tailscale</b>，用<b>和这台电脑同一个账号</b>登录</li>',
        '      <li>然后打开上面的地址（或扫左边的码），不用和电脑在同一个 Wi-Fi</li>',
        '      <li>走的是加密点对点隧道，8787 并没有暴露到公网</li>',
        '    </ol>',
        '  </div>',
        '</div>'
      ].join('\n')
    : (d.tailscaleInstalled
      ? netNote('<b>Tailscale 已安装，但还没登录。</b>登录后这里会多出一条「异地访问」地址，手机用 4G 也能连。点任务栏托盘的 Tailscale 图标登录，或打开 <code>https://login.tailscale.com/start</code>。', 'warn')
      : '');

  const html = [
    '<div class="net-sec">同一个 Wi-Fi<span class="tag">手机和电脑连同一个路由器</span></div>',
    '<div class="net-url">',
    '  <span class="lbl">手机浏览器打开</span>',
    '  <code>' + esc(primary.url) + '</code>',
    '</div>',
    '<div class="net-qr">',
    '  ' + qr,
    '  <div class="qr-side">',
    '    <ol>',
    '      <li>手机连上和电脑<b>同一个 Wi-Fi</b>（别用手机流量）</li>',
    '      <li>用手机相机 / 微信扫左边的码，或在浏览器里输入上面的地址</li>',
    '      <li>打开后点浏览器菜单 →「<b>添加到主屏幕</b>」，桌面上就多一个图标</li>',
    '    </ol>',
    '    <button class="action" id="netInstall" ' + (netInfo.install ? '' : 'hidden') + '>安装到手机桌面</button>',
    '  </div>',
    '</div>',
    tsBlock,
    expose,
    netNote('<b>连不上时先看防火墙：</b>' + esc(d.firewallNote || '') + '<br>放行端口：在 desktop 文件夹里右键「允许手机访问.ps1」→「使用 PowerShell 运行」，同意管理员请求即可。'),
    swNote,
    netNote('<b>为什么不是 .apk 安装包：</b>打包安卓安装包要装 Android SDK / Gradle 并做签名证书，这台电脑上都没有，本工作站也不下载外部工具，所以不生成来路不明的安装包。用「添加到主屏幕」得到的入口在手机上同样是独立图标、全屏打开；真要 .apk 文件，需要用 Android Studio 自行打包。'),
    netNote('<b>关于全屏：</b>浏览器只在 HTTPS 或 localhost 下允许「完整安装 + 离线缓存」。局域网 http 地址下安卓可能只给一个快捷方式（带浏览器地址栏）。看新闻、选股、看图这些功能都一样用。'),
    hosts
  ].join('\n');

  if (body) body.innerHTML = html;
  // 总览里那张卡片只放最关键的两行，不要把整页说明塞进去
  if (panel) {
    panel.innerHTML = [
      '<div class="net-url"><span class="lbl">手机浏览器打开</span><code>' + esc(primary.url) + '</code></div>',
      '<div style="display:flex;gap:10px;flex-wrap:wrap">',
      '  <button class="action" data-net-open="1">显示二维码</button>',
      '  <button class="action ghost" data-net-copy="1">复制地址</button>',
      '  <button class="action ghost" data-net-open-doc="1">放行防火墙说明</button>',
      '</div>',
      ts ? '<div class="net-url"><span class="lbl">异地访问</span><code>' + esc(ts.url) + '</code></div>' : '',
      expose
    ].join('\n');
  }
}

function loadNetInfo(force) {
  if (netInfo.data && !force) { renderNetPanel(); return Promise.resolve(netInfo.data); }
  netInfo.error = null;
  return api('/api/net').then((d) => {
    netInfo.data = d;
    renderNetPanel();
    return d;
  }).catch((err) => {
    netInfo.error = String((err && err.message) || err);
    renderNetPanel();
    return null;
  });
}

function openNetModal() {
  const m = $('#netModal');
  if (!m) return;
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
  renderNetPanel();
  loadNetInfo(true);   // 强制刷新：换了 Wi-Fi 或刚登录 Tailscale 都要立刻反映出来
}

function closeNetModal() {
  const m = $('#netModal');
  if (!m) return;
  m.classList.remove('open');
  m.setAttribute('aria-hidden', 'true');
}

/** 复制手机地址。http 页面下 navigator.clipboard 可能不可用，退回手动选中。 */
async function copyNetUrl() {
  const url = netInfo.data && netInfo.data.primary ? netInfo.data.primary.url : '';
  if (!url) { toast('还没取到局域网地址', 'warn'); return; }
  try {
    await navigator.clipboard.writeText(url);
    toast('手机地址已复制：' + esc(url), 'ok');
  } catch (err) {
    window.prompt('自动复制失败，请手动复制这个地址：', url);
  }
}

/**
 * 注册离线外壳。浏览器规定只有 HTTPS 或 localhost 才算安全上下文，
 * 局域网 http 地址下注册会直接被拒——如实记下原因，界面上写清楚，不假装成功。
 */
function registerShellWorker() {
  if (!('serviceWorker' in navigator)) { netInfo.sw = 'unsupported'; return; }
  const host = location.hostname;
  const secure = window.isSecureContext || location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1';
  if (!secure) { netInfo.sw = 'insecure'; return; }
  navigator.serviceWorker.register('/sw.js').then(() => { netInfo.sw = 'ok'; renderNetPanel(); })
    .catch((err) => { netInfo.sw = 'fail:' + ((err && err.message) || err); renderNetPanel(); });
}

function bindNetPanel() {
  const modal = $('#netModal');
  if (modal) {
    modal.addEventListener('click', (e) => { if (e.target === modal) closeNetModal(); });
    // 面板内容是每次重渲染的，用委托绑定，省得每次渲染都重新挂钩子
    modal.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#netCopy')) { copyNetUrl(); return; }
      if (t.closest('#netInstall')) {
        const ev = netInfo.install;
        if (!ev) { toast('这个浏览器没有给出安装入口，可用浏览器菜单里的「添加到主屏幕」', 'warn'); return; }
        ev.prompt();
        ev.userChoice.then((r) => {
          toast(r && r.outcome === 'accepted' ? '已开始安装' : '已取消安装', r && r.outcome === 'accepted' ? 'ok' : 'warn');
          netInfo.install = null;
          renderNetPanel();
        }).catch(() => {});
        return;
      }
      if (t.closest('[data-net-retry]')) loadNetInfo(true);
    });
  }
  if ($('#netClose')) $('#netClose').addEventListener('click', closeNetModal);

  const panel = $('#netPanelBody');
  if (panel) {
    panel.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-net-open]')) openNetModal();
      else if (t.closest('[data-net-copy]')) copyNetUrl();
      else if (t.closest('[data-net-open-doc]')) openNetModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    const m = $('#netModal');
    if (e.key === 'Escape' && m && m.classList.contains('open')) closeNetModal();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    netInfo.install = e;
    const btn = $('#netInstall');
    if (btn) btn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    netInfo.install = null;
    toast('已添加到手机桌面，下次从桌面图标直接打开', 'ok');
  });
}

/* ====================== 程序外壳：窗口 / 状态栏 / 自检 ====================== */

const shell = { bridge: null, topmost: false, selfcheck: null, running: false, serverStartedAt: null, appVersion: null, serviceDown: false };

function closeMenus() { $$('#menubar .menu').forEach((m) => m.classList.remove('open')); }

/** 右下角气泡提示。text 允许含少量 HTML（调用方自行转义外部内容）。 */
function toast(text, kind) {
  const wrap = $('#toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.innerHTML = text;
  wrap.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .35s'; el.style.opacity = '0'; }, 3600);
  setTimeout(() => el.remove(), 4100);
}

/** 调用本机的窗口桥接，真正去操作程序窗口。 */
async function winAction(action) {
  const labels = { minimize: '最小化', maximize: '最大化 / 还原', restore: '还原并置前', close: '关闭窗口', 'topmost-on': '窗口置顶', 'topmost-off': '取消置顶', state: '窗口状态' };
  try {
    const res = await api('/api/window/' + action, { method: 'POST' });
    if (action === 'state') {
      const list = (res.windows || []).map((w) => w.title + '（' + (w.app ? '应用窗口' : '普通窗口') + (w.iconic ? '，已最小化' : '') + (w.zoomed ? '，已最大化' : '') + '）');
      toast('窗口状态：找到 ' + res.count + ' 个工作站窗口' + (list.length ? '<br>' + list.map(esc).join('<br>') : ''), res.count ? 'ok' : 'warn');
      return res;
    }
    if (action === 'topmost-on' || action === 'topmost-off') {
      shell.topmost = action === 'topmost-on';
      const pin = $('#winTopmost');
      if (pin) pin.classList.toggle('active', shell.topmost);
    }
    toast(esc(res.message || (labels[action] || action) + ' 已执行'), res.ok ? 'ok' : 'warn');
    return res;
  } catch (err) {
    toast('<b>窗口按钮没有生效</b><br>' + esc(err.message) +
      (IS_APP_MODE ? '' : '<br>浏览器标签页模式下请用桌面「股民舆情工作站」快捷方式启动。'), 'err');
    return null;
  }
}

/**
 * 应用窗口模式（?app=1）：开局告诉后台「工作站窗口就是这个」，后台据此武装看门狗——
 * 之后用户关掉窗口（标题栏关闭按钮或页面里的「关闭窗口」），后台服务会一起退出，不留后台进程。
 * 只在应用窗口里做；浏览器标签页里不做，免得误停别人的服务。
 */
async function armWindowWatch() {
  if (!IS_APP_MODE) return;
  for (let i = 0; i < 6; i++) {
    try {
      const res = await api('/api/window/state');
      if (res && Number(res.count) > 0) return;   // 后台已确认窗口存在，看门狗已武装
    } catch (err) { /* 服务还没起来，稍后重试 */ }
    await new Promise((r) => setTimeout(r, 2500));
  }
}

function bindWinControls() {
  // 只绑顶栏这一组；菜单栏里的同名按钮由 bindMenubar 绑，避免一次点击弹两个气泡
  $$('#winControls [data-win]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenus();
    winAction(b.dataset.win);
  }));
}

/* ------------------------------- 状态栏 ------------------------------- */

function startClock() {
  const el = $('#sbClock');
  if (!el) return;
  const pad = (x) => String(x).padStart(2, '0');
  const tick = () => {
    const d = new Date();
    el.textContent = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' 周' + '日一二三四五六'[d.getDay()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  };
  tick();
  setInterval(tick, 1000);
}

function setServiceStatus(html) { const el = $('#sbService'); if (el) el.innerHTML = html; }

function pollHealth() {
  return api('/api/health').then((h) => {
    // 后台服务重启过 -> 页面上的数据已经全部过期，直接重新加载整页
    if (h.startedAt) {
      if (!shell.serverStartedAt) shell.serverStartedAt = h.startedAt;
      else if (h.startedAt !== shell.serverStartedAt) {
        shell.serverStartedAt = h.startedAt;
        toast('后台服务已重启，正在重新加载工作站…', 'warn');
        setTimeout(() => location.reload(), 1200);
        return h;
      }
    }
    // 界面代码（app.js）被更新过 -> 这个页面跑的是旧代码，直接重新加载
    if (h.appVersion) {
      if (!shell.appVersion) shell.appVersion = h.appVersion;
      else if (h.appVersion !== shell.appVersion) {
        toast('工作站界面代码已更新，正在重新加载…', 'warn');
        setTimeout(() => location.reload(), 1200);
        return h;
      }
    }
    // 服务恢复（之前断过）：把这一页的数据补上
    if (shell.serviceDown) { shell.serviceDown = false; loadView(activeViewName(), { force: true }); }
    setServiceStatus('<span class="dot-ok"></span>服务正常 · 已运行 ' + (h.uptimeSec || 0) + ' 秒 · ' + fmt.time(h.time));
    shell.bridge = h.window || null;
    const canWin = !!(h.window && h.window.supported);
    const mode = $('#sbMode');
    if (mode) {
      mode.innerHTML = IS_APP_MODE
        ? (canWin ? '应用窗口模式 · 窗口按钮已就绪' : '应用窗口模式 · 窗口桥接不可用')
        : (canWin ? '标签页模式 · 窗口按钮仍可操作工作站窗口' : '标签页模式');
    }
    return h;
  }).catch(() => {
    shell.serviceDown = true;
    setServiceStatus('<span class="dot-bad"></span>服务未响应（后台服务可能已停止，恢复后本页会自动重试）');
    return null;
  });
}

/* ------------------------------- 自检 ------------------------------- */

function openSelfcheck() {
  const m = $('#selfcheckModal');
  if (!m) return;
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
}

function closeSelfcheck() {
  const m = $('#selfcheckModal');
  if (!m) return;
  m.classList.remove('open');
  m.setAttribute('aria-hidden', 'true');
}

function setSelfBadge(result) {
  const btn = $('#sbSelf');
  if (!btn) return;
  if (!result) { btn.textContent = '自检：未运行'; btn.className = 'sb-item sb-btn'; return; }
  const s = result.summary || {};
  const checked = s.ok + s.fail;
  btn.textContent = '自检：' + s.ok + '/' + checked + ' 通过' + (s.fail ? '（' + s.fail + ' 项异常）' : '') + ' · ' + (result.scope === 'full' ? '完整' : '快速') + (s.skip ? '，' + s.skip + ' 项待完整自检' : '');
  btn.className = 'sb-item sb-btn ' + (s.fail ? 'bad' : 'ok');
  btn.title = '点击查看工作站自检详情（' + fmt.time(result.startedAt) + '）';
}

function renderSelfcheck(result) {
  const body = $('#selfcheckBody');
  if (!body) return;
  const s = result.summary || {};
  const mark = { ok: 'check', fail: 'x', skip: 'dash' };
  const checked = s.ok + s.fail;
  const head = '<div class="sc-summary">' +
    '<span>' + (s.fail ? '<b class="up">' + s.ok + ' / ' + checked + ' 项通过</b>' : '<b class="down">已检查的 ' + checked + ' 项全部通过</b>') + '</span>' +
    '<span>异常 <b class="' + (s.fail ? 'up' : 'dim') + '">' + s.fail + '</b></span>' +
    '<span>未执行 <b class="dim">' + s.skip + '</b></span>' +
    '<span>耗时 <b>' + (result.durationMs / 1000).toFixed(1) + ' 秒</b></span>' +
    '<span class="dim">' + fmt.time(result.startedAt) + ' · ' + (result.scope === 'full' ? '完整自检' : '快速自检') + '</span>' +
    '</div><div class="sc-note">' + esc(result.note || '') + '</div>';
  const groups = (result.groups || []).map((g) => {
    const bad = g.checks.filter((c) => c.status === 'fail').length;
    const rows = g.checks.map((c) =>
      '<div class="sc-row ' + c.status + '">' +
      '<span class="sc-icon">' + (mark[c.status] ? icon(mark[c.status]) : '·') + '</span>' +
      '<span class="sc-name">' + esc(c.name) + '</span>' +
      '<span class="sc-detail">' + esc(c.detail) + '</span>' +
      '<span class="sc-ms">' + (c.ms ? c.ms + ' ms' : '') + '</span>' +
      '</div>').join('');
    return '<div class="sc-group"><h4>' + esc(g.group) + '<span class="tag">' + g.checks.length + ' 项' + (bad ? ' · ' + bad + ' 项异常' : '') + '</span></h4>' + rows + '</div>';
  }).join('');
  body.innerHTML = head + groups;
  const meta = $('#selfcheckMeta');
  if (meta) meta.textContent = (result.scope === 'full' ? '完整自检（含联网）' : '快速自检（仅本机）');
}

function selfcheckText(result) {
  const lines = [
    '工作站自检报告 · ' + fmt.time(result.startedAt) + ' · ' + (result.scope === 'full' ? '完整自检（含联网）' : '快速自检（仅本机）'),
    '通过 ' + result.summary.ok + ' / 共 ' + result.summary.total + ' 项，异常 ' + result.summary.fail + ' 项，耗时 ' + (result.durationMs / 1000).toFixed(1) + ' 秒',
    ''
  ];
  (result.groups || []).forEach((g) => {
    lines.push('【' + g.group + '】');
    g.checks.forEach((c) => lines.push('  ' + (c.status === 'ok' ? 'OK  ' : c.status === 'fail' ? 'FAIL' : 'SKIP') + '  ' + c.name + ' —— ' + c.detail));
    lines.push('');
  });
  lines.push('说明：自检只判断工作站各模块与数据源是否可用，不构成任何投资建议。');
  return lines.join('\r\n');
}

async function runSelfcheck(scope) {
  if (shell.running) { toast('自检正在进行，请稍等…', 'warn'); return; }
  shell.running = true;
  openSelfcheck();
  const body = $('#selfcheckBody');
  const meta = $('#selfcheckMeta');
  if (body) body.innerHTML = '<div class="loading">正在运行' + (scope === 'full' ? '完整自检（含联网数据源，约 30–90 秒）' : '快速自检（仅本机，秒级）') + '…</div>';
  if (meta) meta.textContent = '';
  try {
    const result = await api('/api/selfcheck?scope=' + scope);
    shell.selfcheck = result;
    renderSelfcheck(result);
    setSelfBadge(result);
    toast('自检完成：' + result.summary.ok + '/' + result.summary.total + ' 项通过' + (result.summary.fail ? '，' + result.summary.fail + ' 项异常' : ''), result.summary.fail ? 'warn' : 'ok');
  } catch (err) {
    if (body) body.innerHTML = '<div class="error">自检失败：' + esc(err.message) + '</div>';
  } finally {
    shell.running = false;
  }
}

async function autoSelfcheck() {
  try {
    const result = await api('/api/selfcheck');
    shell.selfcheck = result;
    setSelfBadge(result);
  } catch (err) { /* 服务没起来时由状态栏单独提示 */ }
}

function initShell() {
  bindWinControls();
  startClock();
  pollHealth();
  armWindowWatch();   // 应用窗口模式：让后台在窗口被关闭时一起退出（关窗即关程序）
  setInterval(pollHealth, 15000);
  watchTables();                 // 窄屏：给每张表格套上横向滚动容器
  bindNetPanel();
  loadNetInfo();                 // 总览里的「手机访问」卡片
  registerShellWorker();
  bindBookSearch();
  // 自动刷新：每 5 秒检查当前页数据是否过期
  setInterval(autoRefreshTick, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    updateDataBar();
    if (isViewStale(activeViewName())) loadView(activeViewName());
  });

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-card-retry]') : null;
    if (!btn) return;
    e.preventDefault();
    loadView(activeViewName(), { force: true });
  });

  const refreshBtn = $('#sbRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadView(activeViewName(), { force: true }));

  const badge = $('#sbSelf');
  if (badge) badge.addEventListener('click', () => {
    if (shell.selfcheck) renderSelfcheck(shell.selfcheck);
    openSelfcheck();
  });

  const modal = $('#selfcheckModal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeSelfcheck(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) closeSelfcheck();
  });
  if ($('#selfcheckClose')) $('#selfcheckClose').addEventListener('click', closeSelfcheck);
  if ($('#selfcheckRunLocal')) $('#selfcheckRunLocal').addEventListener('click', () => runSelfcheck('local'));
  if ($('#selfcheckRunFull')) $('#selfcheckRunFull').addEventListener('click', () => runSelfcheck('full'));
  if ($('#selfcheckCopy')) $('#selfcheckCopy').addEventListener('click', async () => {
    if (!shell.selfcheck) { toast('还没有自检结果', 'warn'); return; }
    const text = selfcheckText(shell.selfcheck);
    try { await navigator.clipboard.writeText(text); toast('自检报告已复制到剪贴板', 'ok'); }
    catch (err) { window.prompt('自动复制失败，可手动复制下面内容：', text); }
  });

  autoSelfcheck();
}

/* ========================== 桌面菜单栏（菜单 / 状态） ========================== */

function runMenuAction(act) {
  if (act === 'reload') { location.reload(); return; }
  if (act === 'refresh') { loadView(activeViewName(), { force: true }); return; }
  if (act === 'refreshAll') { refreshAllViews(); return; }
  if (act === 'fullscreen') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
    return;
  }
  if (act === 'netPanel') { openNetModal(); return; }
  if (act === 'selfcheck') { runSelfcheck('local'); return; }
  if (act === 'disclaimer') { switchView('knowledge'); return; }
  if (act === 'health') { window.open('/api/health', '_blank'); return; }
}

/** 刷新当前页签的数据（不重载页面）。保留旧名字，菜单栏与状态栏都走这里。 */
function refreshActiveView() { return loadView(activeViewName(), { force: true }); }

function bindMenubar() {
  const bar = $('#menubar');
  if (!bar) return;
  const closeAll = () => $$('#menubar .menu').forEach((m) => m.classList.remove('open'));

  $$('#menubar .menu-title').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = btn.parentElement;
    const wasOpen = menu.classList.contains('open');
    closeAll();
    if (!wasOpen) menu.classList.add('open');
  }));
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });

  $$('#menubar [data-jump]').forEach((b) => b.addEventListener('click', () => { closeAll(); switchView(b.dataset.jump); }));
  $$('#menubar [data-win]').forEach((b) => b.addEventListener('click', () => { closeAll(); winAction(b.dataset.win); }));
  $$('#menubar [data-act]').forEach((b) => b.addEventListener('click', () => { closeAll(); runMenuAction(b.dataset.act); }));
  $$('#menubar [data-source]').forEach((b) => b.addEventListener('click', () => {
    closeAll();
    switchView('sources');
    const go = () => { if (loaded.sources && loaded.sources.at) loadSource(b.dataset.source); else setTimeout(go, 150); };
    go();
  }));

  const status = $('#menubarStatus');
  api('/api/health').then((h) => {
    if (status) status.innerHTML = '<span class="dot-ok"></span>服务正常 · ' + fmt.time(h.time) + ' · 缓存 ' + (h.cache || []).length + ' 项';
  }).catch(() => {
    if (status) status.innerHTML = '<span class="dot-bad"></span>服务未响应（请确认 node server/index.js 在运行）';
  });
  // 页面被隐藏/恢复时也刷新一次状态，便于判断服务是否还活着
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    api('/api/health').then((h) => {
      if (status) status.innerHTML = '<span class="dot-ok"></span>服务正常 · ' + fmt.time(h.time) + ' · 缓存 ' + (h.cache || []).length + ' 项';
    }).catch(() => { if (status) status.innerHTML = '<span class="dot-bad"></span>服务未响应'; });
  });
}

/* ================================ 选股建议 ================================ */

/* 状态 -> 图标名。na 用「—」不给图标：数据不足时给图标反而像下了结论 */
const ADVICE_ICON = { pass: 'check', warn: 'alert', fail: 'block', info: 'info', na: null };

function levelText(list) {
  if (!list || !list.length) return '—';
  return list.map((x) => esc(x.name) + ' ' + fmt.num(x.value) +
    ' <span class="dim">(' + fmt.num(x.distancePct) + '%)</span>').join('　');
}

async function renderAdvice() {
  if (!state.advicePresets) {
    try {
      const meta = await api('/api/screener/presets');
      state.advicePresets = meta.presets || [];
      state.advicePreset = state.advicePreset || 'momentum';
    } catch (err) {
      $('#adviceResults').innerHTML = '<div class="card"><span class="error">' + esc(err.message) + '</span></div>';
      return;
    }
  }
  renderAdvicePresets();
  runAdvice();
}

function renderAdvicePresets() {
  $('#advicePresets').innerHTML = '<span class="dim">从哪个池子里挑：</span>' +
    (state.advicePresets || []).map((p) => '<button data-preset="' + p.id + '"' +
      (p.id === state.advicePreset ? ' class="active"' : '') +
      ' title="' + esc(p.describe) + '">' + esc(p.label) + '</button>').join('');
  $$('#advicePresets button').forEach((b) => b.addEventListener('click', () => {
    state.advicePreset = b.dataset.preset;
    $$('#advicePresets button').forEach((x) => x.classList.toggle('active', x === b));
    runAdvice();
  }));
}

async function runAdvice() {
  const box = $('#adviceResults');
  box.innerHTML = '<div class="card"><div class="loading">正在圈池子并逐只核对规则，首次约需 10～40 秒…</div></div>';
  $('#adviceMeta').textContent = '';
  try {
    const q = new URLSearchParams({
      preset: state.advicePreset || 'momentum',
      limit: ($('#adviceLimit') || {}).value || '8',
      pages: ($('#advicePages') || {}).value || '2'
    });
    const data = await api('/api/advice?' + q.toString());
    $('#adviceMeta').innerHTML = '预设「' + esc(data.preset.label) + '」· 扫描 ' + data.scanned + ' 只 · 入池 ' +
      data.pool + ' 只 · 深度核对 ' + data.analyzed + ' 只 · 更新 ' + fmt.time(data.updatedAt) +
      (data.relaxed ? ' · <b style="color:var(--warn)">该预设今日无命中，已放宽为「相对强势」口径</b>' : '');
    box.innerHTML = (data.results || []).length
      ? '<div class="card" style="grid-column:1/-1"><div class="notice">' + esc(data.disclaimer) + '</div>' +
        '<div class="hint" style="margin-top:10px">' + esc(data.note) + '</div></div>' +
        data.results.map((c, i) => adviceCard(c, i)).join('')
      : '<div class="card" style="grid-column:1/-1"><span class="dim">这个池子里没有能完成规则核对的标的，换个预设或放宽条件再试。</span></div>';
    $$('#adviceResults .advice-card').forEach((el) => el.addEventListener('click', () => openAnalysis(el.dataset.code)));
  } catch (err) {
    box.innerHTML = '<div class="card"><span class="error">' + esc(err.message) + '</span></div>';
  }
}

function adviceCard(c, i) {
  const cls = c.counts.score >= 6 ? 'good' : c.counts.score >= 2 ? 'mid' : 'low';
  const rules = (c.checks || []).filter((x) => x.status !== 'na');
  const na = (c.checks || []).filter((x) => x.status === 'na');
  const lv = c.keyLevels || {};
  const h = c.horizons || { short: {}, mid: {} };
  return '<div class="card advice-card" data-code="' + c.code + '" title="点击查看完整体检">' +
    '<div class="advice-head">' +
      '<span class="rank">#' + (i + 1) + '</span>' +
      '<span class="nm"><b>' + esc(c.name) + '</b> <span class="dim">' + c.code + '</span></span>' +
      '<span class="num ' + fmt.cls(c.changePct) + '">' + fmt.num(c.price, 2) + ' (' + fmt.pct(c.changePct) + ')</span>' +
      '<span class="score ' + cls + '">规则得分 ' + c.counts.score + '</span>' +
    '</div>' +
    '<div class="hint" style="margin-top:6px">通过 ' + c.counts.pass + ' · 警示 ' + c.counts.warn + ' · 不通过 ' +
      c.counts.fail + ' · 不适用 ' + c.counts.na + '　｜　换手 ' + fmt.num(c.turnoverRate, 2) + '% · PE ' +
      fmt.num(c.pe, 1) + ' · PB ' + fmt.num(c.pb, 2) + ' · 市值 ' + fmt.num(c.marketCapYi, 1) + ' 亿 · 用 ' +
      c.bars + ' 根日线</div>' +
    '<div class="rules">' + rules.map((x) => '<span class="rule ' + x.status + '" title="' + esc(x.detail) + '">' +
      (ADVICE_ICON[x.status] ? icon(ADVICE_ICON[x.status]) + ' ' : '') + esc(x.label) + '</span>').join('') + '</div>' +
    '<div class="kv" style="margin-top:10px">' +
      '<dt>短期 / 中期</dt><dd>' + esc(h.short.verdict || '—') + ' / ' + esc(h.mid.verdict || '—') +
        ' <span class="dim">（' + esc((c.tech && c.tech.trend) || '') + '）</span></dd>' +
      '<dt>最近支撑</dt><dd>' + levelText(lv.supports) + '</dd>' +
      '<dt>上方压力</dt><dd>' + levelText(lv.resistances) + '</dd>' +
      '<dt>参考止损 / 仓位上限</dt><dd>' + (lv.refStop
        ? fmt.num(lv.refStop) + '（' + fmt.num(lv.stopPct) + '%） / ' + fmt.num(lv.maxPositionPct, 1) + '%'
        : '—') + '</dd>' +
    '</div>' +
    (na.length ? '<div class="hint" style="margin-top:8px">批量扫描未评估：' +
      na.map((x) => esc(x.label)).join('、') + '（需点开个股体检单独取数）</div>' : '') +
  '</div>';
}

/* ================================ 走势分析 ================================ */

async function loadTrend(code) {
  const box = $('#trendBox');
  if (!box) return;
  box.innerHTML = '<div class="loading">正在计算多周期走势…</div>';
  try {
    const d = await api('/api/trend/' + code);
    if (!d.ready) throw new Error(d.error || 'K 线数据不足');
    renderTrend(d);
  } catch (err) {
    box.innerHTML = '<span class="error">' + esc(err.message) + '</span>';
  }
}

function renderTrend(d) {
  const h = d.horizons || {};
  const lv = d.keyLevels || {};
  const pos = h.position || {};
  const pill = (v) => '<span class="senti-pill ' +
    (v === '偏多' ? 'bullish' : v === '偏空' ? 'bearish' : 'neutral') + '">' + esc(v || '—') + '</span>';
  const notes = (o) => '<ul class="trend-notes">' +
    ((o.notes || []).length ? o.notes.map((n) => '<li>' + esc(n) + '</li>').join('') : '<li>样本不足</li>') + '</ul>';
  const signals = (list, cls) => (list || []).map((s) =>
    '<div class="signal ' + cls + '"><span class="dot"></span><span>' + esc(s.text) + '</span></div>').join('');

  $('#trendBox').innerHTML =
    '<div class="trend-grid">' +
      '<div class="trend-col"><div class="trend-title">' + esc((h.short || {}).label || '短期') + ' ' + pill((h.short || {}).verdict) + '</div>' +
        notes(h.short || {}) + '</div>' +
      '<div class="trend-col"><div class="trend-title">' + esc((h.mid || {}).label || '中期') + ' ' + pill((h.mid || {}).verdict) + '</div>' +
        notes(h.mid || {}) + '</div>' +
      '<div class="trend-col"><div class="trend-title">位置与关键价位</div><div class="kv">' +
        '<dt>20 日区间位置</dt><dd>' + fmt.num(pos.pos20, 0) + '%</dd>' +
        '<dt>60 日区间位置</dt><dd>' + fmt.num(pos.pos60, 0) + '%</dd>' +
        '<dt>最近支撑</dt><dd>' + levelText(lv.supports) + '</dd>' +
        '<dt>上方压力</dt><dd>' + levelText(lv.resistances) + '</dd>' +
        '<dt>参考止损</dt><dd>' + (lv.refStop ? fmt.num(lv.refStop) + '（距现价 ' + fmt.num(lv.stopPct) + '%）' : '—') + '</dd>' +
        '<dt>仓位上限</dt><dd>' + (lv.maxPositionPct
          ? fmt.num(lv.maxPositionPct, 1) + '% <span class="dim">（单笔风险 ≤ 2% 与单只 ≤ 30% 取更严者）</span>'
          : '—') + '</dd>' +
        '</div>' +
        (pos.read ? '<div class="hint" style="margin-top:8px">' + esc(pos.read) + '</div>' : '') +
      '</div>' +
      '<div class="trend-col"><div class="trend-title">支持因素 / 风险点</div>' +
        ((d.bullish || []).length ? '<div class="hint">支持因素（多头信号）</div>' + signals(d.bullish, 'bullish') : '') +
        ((d.bearish || []).length ? '<div class="hint" style="margin-top:10px">风险因素（空头信号）</div>' + signals(d.bearish, 'bearish') : '') +
        (!(d.bullish || []).length && !(d.bearish || []).length ? '<div class="hint">当前没有明显的多空信号</div>' : '') +
      '</div>' +
    '</div>' +
    '<div class="notice" style="margin-top:14px"><b>规则结论：</b>' + esc(d.summary || '') +
      '<br><span class="dim">' + esc(d.disclaimer || '') + '</span></div>';
}

/* ------------------- 第三方页面嵌入：金融界「大盘云图」 ------------------- */
/*
 * 为什么不是简单地写一个 <iframe src="..."> 就完事：
 * 能不能被嵌完全由对方决定（X-Frame-Options / CSP frame-ancestors），同一个站点的不同页面
 * 结论还不一样——实测金融界「大盘云图」没有任何限制，而「涨跌停温度计」「龙虎榜」都是
 * SAMEORIGIN，浏览器会直接拒绝渲染，用户看到的只是一个空白框，还以为是我们坏了。
 * 所以每次进这一页都先问一次后端探测结果，能嵌就嵌，不能嵌就如实说明 + 给新窗口入口。
 */
const EMBED_LABELS = { dpyt: '大盘云图', zdtwdj: '涨跌停温度计', lhb: '龙虎榜' };

const embedState = {
  key: 'dpyt',      // 当前选中的金融界页签
  catalog: null,    // /api/embed 返回的白名单（含真实 URL）
  loadedKey: null,  // 已经塞进 iframe 的页签：自动复检时不要重复重载，免得把用户在页面里的操作重置掉
  lastReady: null
};

async function embedInfo(key) {
  if (!embedState.catalog) embedState.catalog = (await api('/api/embed')).items || [];
  return embedState.catalog.find((x) => x.id === key) || null;
}

function setEmbedNotice(html, kind) {
  const el = $('#embedNotice');
  if (!el) return;
  el.className = kind === 'warn' ? 'notice' : 'hint';
  el.style.margin = kind === 'warn' ? '12px 0' : '12px 0 0';
  el.innerHTML = html;
}

/** 让 iframe 正好填满窗口剩余高度，看起来像个独立程序；由「切到本页 / 窗口缩放」触发，不跟随滚动，避免抖。 */
function sizeEmbedFrame() {
  const wrap = $('#embedWrap');
  const frame = $('#embedFrame');
  const view = $('#view-embed');
  if (!wrap || !frame || !view || !view.classList.contains('active')) return;
  const sb = document.querySelector('.statusbar');
  const sbH = sb ? sb.getBoundingClientRect().height : 30;
  const top = wrap.getBoundingClientRect().top;
  const h = Math.round(window.innerHeight - top - sbH - 14);
  frame.style.height = Math.max(520, Math.min(1600, h)) + 'px';
}

/** 嵌不了（对方禁止 / 连不上）时的兜底展示：绝不留一个空白框。 */
function showEmbedBlocked(res, info, key) {
  const wrap = $('#embedWrap');
  const frame = $('#embedFrame');
  const name = (info && info.name) || EMBED_LABELS[key] || key;
  const url = (info && info.url) || (res && res.url) || '';
  const link = url ? '<div style="margin-top:8px"><a href="' + esc(url) + '" target="_blank" rel="noreferrer">' +
    esc(url) + '</a><span class="dim">（可直接点开或右键复制）</span></div>' : '';
  if (frame) frame.removeAttribute('src');
  if (wrap) wrap.classList.add('embed-blocked');
  embedState.loadedKey = null;
  embedState.lastReady = false;
  if (res && res.reachable === false) {
    setEmbedNotice('<b>' + esc(name) + '：这次连不上金融界。</b>' + esc(res.error || '') +
      '<br>可能是本机断网或对方在维护。点上面「重新加载」再试一次；也可以点「在浏览器打开」看看浏览器里行不行。' + link, 'warn');
    return;
  }
  setEmbedNotice('<b>' + esc(name) + '：金融界不允许把这个页面嵌进别的网站。</b>' +
    '对方返回的是 <code>' + esc((res && res.blockedBy) || '未知限制') + '</code>，浏览器一定会拒绝加载，' +
    '所以这里不放空白框糊弄你——这一页本身是好的，只是不能被嵌。' +
    '<br>点上面「在浏览器打开」就能正常浏览金融界原页面。' + link, 'warn');
}

/** 这一页的加载入口（页签打开、点「重新加载」、自动复检都会走到这里）。 */
async function initEmbed(opts) {
  const frame = $('#embedFrame');
  const wrap = $('#embedWrap');
  if (!frame || !wrap) return;
  const force = !!(opts && opts.force);
  const key = embedState.key;
  const info = await embedInfo(key).catch(() => null);
  // 已经嵌好且不是强制刷新：静默复检一次可用性，别把 iframe 重新加载一遍
  const keep = embedState.loadedKey === key && !force && !!frame.getAttribute('src');
  if (!keep) setEmbedNotice('正在检查「' + esc((info && info.name) || EMBED_LABELS[key] || key) + '」能不能被嵌进来…', 'warn');

  let res;
  try { res = await api('/api/embed/' + key + '/preflight'); }
  catch (err) {
    if (keep) return;   // 自动复检失败时，不动已经嵌好的页面
    showEmbedBlocked({ reachable: false, error: (err && err.message) || String(err) }, info, key);
    return;
  }

  if (res.reachable && res.frameable) {
    if (!keep) {
      mountEmbedFrame(frame, key, (info && info.url) || res.url);
      sizeEmbedFrame();
    }
    if (!keep || embedState.lastReady !== true) {
      setEmbedNotice('已嵌入金融界原页面：<b>' + esc((info && info.name) || key) + '</b>' +
        (info && info.describe ? '（' + esc(info.describe) + '）' : '') +
        ' · 页面里的数据由金融界自己刷新（约 12 秒一轮），本站只做嵌入，不缓存、不改写。', 'ok');
    }
    embedState.lastReady = true;
    wrap.classList.remove('embed-blocked');
    return;
  }
  showEmbedBlocked(res, info, key);
}

/** 真正把金融界页面挂进 iframe；同时记住挂的是哪个页签，避免自动复检重复加载。 */
function mountEmbedFrame(frame, key, url) {
  if (!url) return;
  frame.setAttribute('src', url);
  embedState.loadedKey = key;
}

function bindEmbedEvents() {
  $$('#embedSeg button[data-embed]').forEach((b) => b.addEventListener('click', () => {
    if (embedState.key === b.dataset.embed) return;
    embedState.key = b.dataset.embed;
    embedState.loadedKey = null;
    embedState.lastReady = null;
    $$('#embedSeg button[data-embed]').forEach((x) => x.classList.toggle('active', x === b));
    loadView('embed', { force: true });
  }));

  const reload = $('#embedReloadBtn');
  if (reload) reload.addEventListener('click', () => loadView('embed', { force: true }));

  const open = $('#embedOpenBtn');
  if (open) open.addEventListener('click', async () => {
    const info = await embedInfo(embedState.key).catch(() => null);
    const url = (info && info.url) || (embedState.catalog || []).map((x) => x.url)[0];
    if (!url) { toast('还没拿到金融界的地址，稍后再试', 'warn'); return; }
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('已在新窗口打开金融界原页面', 'ok');
  });
}

/* ================================ 智能体研判 ================================ */

/*
 * 本地多智能体引擎（后端 /api/agents/:code）在服务端跑，这里只负责把它的
 * 结构画出来。整体结构和「个股体检」刻意不同：体检是逐条对照规则，
 * 研判是把四个视角 + 一场多空辩论 + 交易员与风控的结论并排放，让人看到分歧在哪。
 */

const AGENTS_CODE_KEY = 'stockradar.agentsCode';
const AGENT_STANCE_ICON = { bull: 'bull', bear: 'bear', neutral: 'dash' };

function stanceBadge(node) {
  return '<span class="stance ' + node.stance + '">' +
    icon(AGENT_STANCE_ICON[node.stance]) + esc(node.stanceText) + '</span>';
}

/* 置信度用「数字 + 进度条」两个通道表达，不让颜色单独承担信息 */
function confMeter(node) {
  const pct = Math.max(0, Math.min(100, Number(node.confidence) || 0));
  return '<span class="conf" title="置信度：由倾向强度与论据条数共同决定，论据不足时不给高置信">' +
    '置信 <span class="bar"><i style="width:' + pct + '%"></i></span>' +
    '<b class="num">' + pct + '</b></span>';
}

function findingsHtml(list) {
  const rows = list || [];
  if (!rows.length) return '<div class="dim" style="font-size:13px">这一环节没有可展示的论据。</div>';
  return '<div class="findings">' + rows.map((f) =>
    '<div class="finding ' + esc(f.stance) + '">' +
      '<span class="fl"><i class="dot"></i>' + esc(f.label) + '</span>' +
      '<span class="fv">' + esc(f.value) + '</span>' +
      '<span class="fn">' + esc(f.note) + '</span>' +
    '</div>').join('') + '</div>';
}

function agentCard(a) {
  return '<div class="card agent-card">' +
    '<div class="agent-head">' +
      '<span class="avatar">' + icon(a.avatar) + '</span>' +
      '<span class="who">' + esc(a.name) + '</span>' +
      '<span class="role">' + esc(a.role) + '</span>' +
      '<span class="grow"></span>' +
      stanceBadge(a) + confMeter(a) +
    '</div>' +
    '<div class="agent-summary">' + esc(a.summary) + '</div>' +
    findingsHtml(a.findings) +
  '</div>';
}

function debateCol(side) {
  // 后端把「我方论据」和「对方最强论据 + 失效条件」写在同一段 summary 里，
  // 这里按分隔句拆开：前半段放正文，后半段单独做成醒目的回应块，便于扫读。
  const parts = String(side.summary || '').split(' 对方最有力');
  const own = parts[0];
  const rest = parts[1] ? '对方最有力' + parts[1] : '';
  const oppo = side.opponent
    ? '<div class="oppo">' +
      '<b>对方最强论据：</b>' + esc(side.opponent.label) + '（' + esc(side.opponent.value) + '，来自' + esc(side.opponent.from) + '）<br>' +
      '<b>我方要成立，需要先看到：</b>' + esc(side.opponent.rebuttalCondition) +
      '</div>'
    : '';
  return '<div class="debate-col ' + side.stance + '">' +
    '<div class="agent-head">' + icon(AGENT_STANCE_ICON[side.stance]) +
      '<span class="who">' + esc(side.name) + '</span>' +
      '<span class="role">' + esc(side.role) + '</span>' +
      '<span class="grow"></span>' +
      '<span class="dim">' + side.evidenceCount + ' 条</span>' +
    '</div>' +
    (own ? '<div class="agent-summary" style="margin-top:8px">' + esc(own) + '</div>' : '') +
    findingsHtml(side.findings) +
    oppo +
    (rest && !side.opponent ? '<div class="oppo">' + esc(rest) + '</div>' : '') +
  '</div>';
}

function planRowsHtml(t) {
  const p = t.plan || {};
  const rows = [];
  if (p.mode === 'trend-follow') {
    rows.push(['参考回踩区间', fmt.num(p.zoneLow) + ' ~ ' + fmt.num(p.zoneHigh)]);
  } else {
    rows.push(['当前不构成回踩买点', p.reclaimLevel === null || p.reclaimLevel === undefined
      ? '现价在 MA20 下方' : '需先收复 ' + fmt.num(p.reclaimLevel)]);
  }
  if (p.stopRef !== null && p.stopRef !== undefined) {
    rows.push(['参考止损位', fmt.num(p.stopRef) + '（距现价 ' + fmt.num(p.stopPct) + '%，' + esc(p.stopBasis || '') + '）']);
  }
  if (p.targetRef !== null && p.targetRef !== undefined) rows.push(['上方参考位（20 日高点）', fmt.num(p.targetRef)]);
  rows.push(['盈亏比', (p.riskReward === null || p.riskReward === undefined)
    ? '暂不计算（逆势位置算出来会虚高）' : p.riskReward + ' : 1']);
  if (p.maxPositionPct !== null && p.maxPositionPct !== undefined) rows.push(['参考仓位上限', fmt.num(p.maxPositionPct, 1) + '%']);
  return '<div class="kv">' + rows.map((r) =>
    '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>').join('') + '</div>';
}

function traderCard(t, risk) {
  const vetoWarn = risk && risk.vetoed
    ? '<div class="veto-badge" style="margin-top:10px">' + icon('alert') +
      '风控已触发 ' + risk.vetoes.length + ' 条否决项，下面的框架仅供参考，按规则不应执行</div>'
    : '';
  return '<div class="card agent-card">' +
    '<div class="agent-head">' + icon('target') +
      '<span class="who">' + esc(t.name) + '</span><span class="role">' + esc(t.role) + '</span>' +
      '<span class="grow"></span>' + stanceBadge(t) + confMeter(t) +
    '</div>' +
    '<div class="agent-summary">' + esc(t.summary) + '</div>' +
    planRowsHtml(t) + vetoWarn +
    findingsHtml(t.findings) +
  '</div>';
}

function riskCard(r) {
  // 卡片里已经有：顶部「存在否决项」徽标 + summary（写明触发了哪几条、处置原则）+ findings 逐条清单，
  // 所以不再单独铺一遍否决项数组——否则同一条否决会在卡片里出现两三次。
  return '<div class="card agent-card">' +
    '<div class="agent-head">' + icon('shield') +
      '<span class="who">' + esc(r.name) + '</span><span class="role">' + esc(r.role) + '</span>' +
      '<span class="grow"></span>' +
      (r.vetoed ? '<span class="veto-badge">' + icon('alert') + '存在否决项</span>' : stanceBadge(r)) +
    '</div>' +
    '<div class="agent-summary">' + esc(r.summary) + '</div>' +
    findingsHtml(r.findings) +
  '</div>';
}

function renderAgents(d) {
  const q = d.quote || {};
  const ks = d.klineSummary || {};
  const v = d.verdict || {};

  $('#agentsVerdict').innerHTML =
    '<div class="verdict-row">' +
      '<span class="big">' + esc(d.name || d.code) + ' <span class="dim" style="font-size:14px">' + esc(d.code) + '</span></span>' +
      (q.price !== undefined && q.price !== null
        ? '<span class="num ' + fmt.cls(q.changePct) + '" style="font-size:16px">' + fmt.num(q.price) + ' (' + fmt.pct(q.changePct) + ')</span>'
        : '<span class="dim">实时行情未取到</span>') +
      '<span class="stance ' + (v.stance || 'neutral') + '">' + icon(AGENT_STANCE_ICON[v.stance] || 'dash') + esc(v.text || '—') + '</span>' +
      (v.composite !== undefined ? '<span class="dim">四维合成 ' + (v.composite > 0 ? '+' : '') + v.composite + '</span>' : '') +
      '<span class="dim">综合置信 ' + fmt.num(v.confidence, 0) + '</span>' +
    '</div>' +
    '<div class="hint" style="margin-top:10px">' +
      (d.chain ? '产业链：<b>' + esc(d.chain.name) + '</b>（' + esc(d.chain.note) + '）' : '产业链：未匹配') +
      (d.profile && d.profile.industry ? ' · 东财行业：' + esc(d.profile.industry) : '') +
      ' · 技术面：' + esc(ks.trend || '—') +
      ' · 用 ' + (ks.bars || 0) + ' 根日线' +
      ' · MA20 五日斜率 ' + (ks.ma20SlopePct === null || ks.ma20SlopePct === undefined ? '—' : (ks.ma20SlopePct > 0 ? '+' : '') + ks.ma20SlopePct + '%') +
      ' · 近 5 日 ' + fmt.pct(ks.change5Pct) +
      ' · 更新 ' + fmt.time(d.updatedAt) +
    '</div>' +
    '<div class="notice" style="margin-top:10px">' + esc(d.disclaimer || '') + '</div>';

  $('#agentsAnalysts').innerHTML = (d.analysts || []).map(agentCard).join('');
  $('#agentsDebate').innerHTML = d.debate
    ? debateCol(d.debate.bull) + debateCol(d.debate.bear) : '';
  $('#agentsTraderRisk').innerHTML = traderCard(d.trader, d.risk) + riskCard(d.risk);

  const gaps = d.dataGaps || [];
  $('#agentsGapsCard').hidden = !gaps.length;
  $('#agentsGaps').innerHTML = gaps.length
    ? '<div class="gap-note">下面这些数据这次没取到，对应的那个维度<b>没有参与</b>结论，' +
      '请当成「不知道」而不是「中性」：</div><div class="gap-list">' +
      gaps.map((g) => '<span>' + esc(g) + '</span>').join('') + '</div>'
    : '';
}

async function runAgents(code) {
  const c = String(code || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(c)) {
    $('#agentsVerdict').innerHTML = '<span class="error">请输入 6 位股票代码</span>';
    return;
  }
  try { localStorage.setItem(AGENTS_CODE_KEY, c); } catch (err) { /* 隐私模式下忽略 */ }
  $('#agentsCode').value = c;
  $('#agentsVerdict').innerHTML = '<div class="loading">正在让四个分析师各看一遍，然后开一场多空辩论…（首次约 5～20 秒）</div>';
  $('#agentsAnalysts').innerHTML = '<div class="loading">加载中…</div>';
  $('#agentsDebate').innerHTML = '<div class="loading">加载中…</div>';
  $('#agentsTraderRisk').innerHTML = '<div class="loading">加载中…</div>';
  $('#agentsGapsCard').hidden = true;
  const link = $('#agentsLink');
  if (link) link.innerHTML = '· <a href="#" id="agentsToAnalysis">看这只股票的个股体检 →</a>';
  const toAnalysis = $('#agentsToAnalysis');
  if (toAnalysis) toAnalysis.addEventListener('click', (e) => { e.preventDefault(); openAnalysis(c); });
  try {
    renderAgents(await api('/api/agents/' + c));
  } catch (err) {
    $('#agentsVerdict').innerHTML = '<span class="error">研判失败：' + esc(err.message) + '</span>';
    $('#agentsAnalysts').innerHTML = '';
    $('#agentsDebate').innerHTML = '';
    $('#agentsTraderRisk').innerHTML = '';
  }
}

async function initAgents() {
  await renderQuickPicks('#agentsQuick', (code) => runAgents(code));
  await loadIntegrationPanel();
  if (state.agentsCode) return;
  let first = null;
  try { first = localStorage.getItem(AGENTS_CODE_KEY); } catch (err) { /* 隐私模式下忽略 */ }
  if (!/^\d{6}$/.test(String(first || ''))) {
    first = (state.watchlist && state.watchlist.stocks[0] && state.watchlist.stocks[0].code) || '600519';
  }
  state.agentsCode = first;
  runAgents(first);
}

/* ---------- 外部程序接入：TradingAgents-CN ---------- */

function probeLine(r) {
  const ok = r.reachable && r.ok;
  return '<div>' + (ok ? icon('check') : icon('x')) + ' ' + esc(r.url) +
    ' <span class="dim">（' + esc(r.role) + '）</span> — ' +
    (ok ? '<span class="dim">可访问，HTTP ' + r.status + '，' + r.ms + ' ms' +
        (r.frameable ? '，允许被嵌入' : '，但对方设置了 ' + esc(r.blockedBy || '禁止嵌入') + '，只能在浏览器新窗口打开') + '</span>'
      : '<span class="bad">连不上</span> <span class="dim">' + esc(r.error || '') + '</span>') +
    '</div>';
}

function integrationHtml(info, status) {
  const running = status && status.running;
  const steps = (info.steps || []).map((s) => '<li><code>' + esc(s) + '</code></li>').join('');
  const reqs = (info.requirements || []).map((s) => '<li>' + esc(s) + '</li>').join('');
  const probes = (status && status.results || []).map(probeLine).join('');

  return '<div class="int-status">' +
      '<span class="int-pill' + (running ? ' on' : '') + '">' +
        icon(running ? 'check' : 'plug') + (running ? '检测到本机正在运行' : '本机未检测到实例') + '</span>' +
      '<span class="dim" style="font-size:12px">' + esc(info.tagline || '') + '</span>' +
      '<a href="' + esc(info.repo) + '" target="_blank" rel="noreferrer noopener" style="font-size:12px">项目主页 ' + icon('external') + '</a>' +
    '</div>' +
    '<div class="int-probe">' + probes +
      (status && status.checkedAt ? '<div class="dim">探测时间 ' + fmt.time(status.checkedAt) + '</div>' : '') + '</div>' +

    '<div class="int-block">' +
      '<h4>接入地址</h4>' +
      '<div class="int-actions">' +
        '<input id="intUrl" type="text" value="' + esc((info.config && info.config.baseUrl) || '') + '" aria-label="TradingAgents-CN 地址" placeholder="http://127.0.0.1:3000">' +
        '<button class="action" id="intSave">保存并重新探测</button>' +
        '<button id="intReprobe">' + icon('refresh') + ' 重新探测</button>' +
      '</div>' +
      '<div class="hint" style="margin-top:6px">默认前端 <code>http://127.0.0.1:3000</code>、后端 <code>http://127.0.0.1:8000</code>；只接受 http/https 地址。</div>' +
    '</div>' +

    (running && status.embeddable
      ? '<div class="int-block"><h4>在下方嵌入</h4>' +
        '<div class="int-actions"><button class="action" id="intEmbed">' + icon('plug') + ' 把 ' + esc(status.activeUrl) + ' 嵌到下面</button></div>' +
        '<div id="intFrameBox"></div></div>'
      : '') +

    '<div class="int-block">' +
      '<h4>怎么把它跑起来</h4>' +
      '<div class="dim" style="font-size:12px;margin-bottom:6px">它需要 Python 3.11、MongoDB、Redis 和一份你自己的大模型 API Key，都装好之后：</div>' +
      '<ol class="int-list">' + steps + '</ol>' +
      '<div class="dim" style="font-size:12px;margin:10px 0 6px">环境要求：</div>' +
      '<ul class="int-list">' + reqs + '</ul>' +
    '</div>' +

    '<div class="int-warn">' +
      '<b>为什么不能直接内置：</b>' + esc(info.license.kind) + '。开源部分（' +
      esc(info.license.openPart) + '）可以自由使用；但 ' + esc(info.license.closedPart) + '。' +
      '本仓库是公开仓库，把那部分源码拷进来发布就等于再分发，所以这里只做「探测 + 嵌入 + 跳转」，不复制它的任何代码。' +
      '<br>另外本工作站的研判是<b>本机规则引擎</b>算的，不调用大模型，也不需要任何 API Key；装了它之后可以在上面那块直接嵌进来对照看。' +
    '</div>';
}

async function loadIntegrationPanel() {
  const body = $('#agentsIntegrationBody');
  if (!body) return;
  body.innerHTML = '<div class="loading">正在检查本机是否有实例在运行…</div>';
  let info = null;
  let status = null;
  try {
    const list = await api('/api/integrations');
    info = (list.integrations || [])[0] || null;
  } catch (err) { /* 下面统一处理 */ }
  if (!info) {
    body.innerHTML = '<span class="error">接入信息加载失败，请点「重新加载整个工作站」再试。</span>';
    return;
  }
  try { status = await api('/api/integrations/status?id=' + encodeURIComponent(info.id)); } catch (err) { /* 探测失败就按「未检测到」展示 */ }
  body.innerHTML = integrationHtml(info, status);

  const reprobe = () => loadIntegrationPanel();
  const btnReprobe = $('#intReprobe');
  if (btnReprobe) btnReprobe.addEventListener('click', reprobe);

  const save = $('#intSave');
  if (save) save.addEventListener('click', async () => {
    const url = ($('#intUrl') || {}).value || '';
    save.disabled = true;
    try {
      await api('/api/integrations/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: info.id, baseUrl: url })
      });
      toast('接入地址已保存，正在重新探测', 'ok');
      await loadIntegrationPanel();
    } catch (err) {
      save.disabled = false;
      toast('保存失败：' + err.message, 'err');
    }
  });

  const embed = $('#intEmbed');
  if (embed && status && status.activeUrl) {
    embed.addEventListener('click', () => {
      const box = $('#intFrameBox');
      if (!box) return;
      box.innerHTML = '<iframe class="int-frame" src="' + esc(status.activeUrl) + '" title="TradingAgents-CN" referrerpolicy="no-referrer"></iframe>';
      embed.disabled = true;
      embed.innerHTML = icon('check') + ' 已嵌入';
    });
  }
}

/* ---------------------------------- 路由 ---------------------------------- */

/*
 * 数据新鲜度：每个页签记住「上次成功拿到数据的时间」。
 * 打开页签时只在该页数据过期时才重新取；取失败不会被记成「已加载」，
 * 所以任何一页出问题都能重试，不会像以前那样一次失败就永久空白。
 */
const VIEW_TTL_MS = {
  overview: 30000, stocks: 30000, news: 60000, sources: 60000, screener: 180000,
  advice: 180000, agents: 300000, guba: 60000, analysis: 60000, commodity: 60000, coal: 120000, knowledge: 600000,
  embed: 600000
};
/* 状态栏倒计时用：比 TTL 略短，保证到点就会刷 */
const VIEW_REFRESH_SEC = {
  overview: 30, stocks: 30, news: 60, sources: 60, screener: 180,
  advice: 180, agents: 300, guba: 60, analysis: 60, commodity: 60, coal: 120, knowledge: 600,
  embed: 600
};

const loaded = {};   // name -> { at, busy, error }

function viewState(name) {
  if (!loaded[name]) loaded[name] = { at: 0, busy: false, error: null };
  return loaded[name];
}

function activeViewName() {
  const v = document.querySelector('.view.active');
  return v ? v.id.replace('view-', '') : 'overview';
}

const VIEW_LOADERS = {
  overview: async () => { const d = await api('/api/overview'); renderOverview(d); renderStockTable(d); },
  stocks: async () => {
    const d = await api('/api/overview');
    renderOverview(d);
    renderStockTable(d);
    loadStockFundFlow();          // 资金流接口较慢，不 await：先让行情表出来
  },
  news: () => renderNews(),
  sources: () => renderSources(),
  screener: () => renderScreener(),
  advice: () => renderAdvice(),
  agents: () => initAgents(),
  guba: () => initGuba(),
  analysis: () => initAnalysis(),
  commodity: () => renderCommodity(),
  coal: () => loadCoal(),
  knowledge: async () => { renderKnowledge(await api('/api/knowledge')); },
  embed: (opts) => initEmbed(opts)
};

function isViewStale(name) {
  const st = loaded[name];
  if (!st || !st.at) return true;
  if (st.error) return true;                       // 上次失败：允许随时再试
  return Date.now() - st.at > (VIEW_TTL_MS[name] || 60000);
}

function clearViewError(name) {
  const view = document.getElementById('view-' + name);
  const box = view && view.querySelector('.view-error');
  if (box) box.remove();
}

function viewError(name, err) {
  const view = document.getElementById('view-' + name);
  if (!view) return;
  let box = view.querySelector('.view-error');
  if (!box) {
    box = document.createElement('div');
    box.className = 'notice view-error';
    view.prepend(box);
  }
  box.innerHTML = '<b>这一页的数据这次没取到：</b>' + esc((err && err.message) || err) +
    '　<button class="action ghost" data-retry="' + name + '">重试</button>' +
    '<br><span class="dim">常见原因：上游站点临时限流或网络抖动、后台服务刚重启。点「重试」即可，' +
    '也可以等下一轮自动刷新。</span>';
  const btn = box.querySelector('[data-retry]');
  if (btn) btn.addEventListener('click', () => loadView(name, { force: true }));
}

/** 取某一页的数据；失败会留下错误条 + 重试按钮，绝不再把它标记成「已加载」。 */
async function loadView(name, opts) {
  const loader = VIEW_LOADERS[name];
  if (!loader) return undefined;
  const st = viewState(name);
  if (st.busy) return undefined;
  st.busy = true;
  if (opts && opts.force) clearViewError(name);
  updateDataBar();
  try {
    await loader(opts);
    st.at = Date.now();
    st.error = null;
    clearViewError(name);
  } catch (err) {
    st.error = String((err && err.message) || err);
    viewError(name, err);
  } finally {
    st.busy = false;
    updateDataBar();
  }
  return undefined;
}

/** 状态栏：本页数据时间 + 自动刷新节奏 + 立即刷新按钮 */
function updateDataBar() {
  const el = $('#sbData');
  if (!el) return;
  const name = activeViewName();
  const st = loaded[name];
  if (!st || !st.at) {
    el.innerHTML = '<span class="dim">本页数据：' + (st && st.busy ? '加载中…' : '尚未加载') + '</span>';
    return;
  }
  const ageSec = Math.max(0, Math.round((Date.now() - st.at) / 1000));
  const sec = VIEW_REFRESH_SEC[name] || 60;
  const err = st.error ? '<span class="up">' + icon('alert') + ' 上次刷新失败</span> · ' : '';
  el.innerHTML = err + '本页数据 ' + fmt.time(new Date(st.at).toISOString()) + '（' + ageSec + ' 秒前）' +
    ' <span class="dim">· 每 ' + sec + ' 秒自动刷新</span>';
}

/** 自动刷新：只刷当前正在看的那一页，到点才刷，页面不可见时暂停。 */
function autoRefreshTick() {
  updateDataBar();
  if (document.hidden) return;
  const name = activeViewName();
  const st = loaded[name];
  if (!st || st.busy) return;
  if (isViewStale(name)) loadView(name);
}

/** 强制刷新所有页：清掉新鲜度标记，回到哪页就重取哪页，其余页签下次进入时重取。 */
function refreshAllViews() {
  Object.keys(VIEW_LOADERS).forEach((name) => { loaded[name] = { at: 0, busy: false, error: null }; });
  const name = activeViewName();
  loadView(name, { force: true });
  toast('已清空各页缓存标记，正在重新拉取「' + (VIEW_LABELS[name] || name) + '」的数据', 'ok');
}

async function switchView(name) {
  if (VIEW_LABELS[name]) {
    try { localStorage.setItem(LAST_VIEW_KEY, name); } catch (err) { /* 隐私模式下忽略 */ }
    const sbView = $('#sbView');
    if (sbView) sbView.textContent = '页签：' + VIEW_LABELS[name];
  }
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));

  // 切页签回到顶部：手机上换了页还停在半中间很容易让人以为「没反应」
  if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);

  // 手机上的页签栏是横向可滑的（12 个页签一屏放不下），
  // 切完之后把当前页签滚到中间，用户才知道自己现在在哪、也能发现这条栏可以滑
  const activeTab = document.querySelector('#tabs button.active');
  if (activeTab && typeof activeTab.scrollIntoView === 'function') {
    try { activeTab.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (err) { /* 老浏览器忽略 */ }
  }

  if (VIEW_LOADERS[name] && isViewStale(name)) loadView(name);
  // 切回总览时补画一次分时图（它之前在后台渲染过，那时画布宽度是 0）
  if (name === 'overview' && state.overview) drawWatchMinutes(state.overview.watchlist);
  if (name === 'analysis' && state.analysisData) renderKline(state.analysisData);

  updateDataBar();
}

function bindEvents() {
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

  // 自选股：查询 / 加入 / 编辑弹窗
  const wlInput = $('#wlInput');
  if (wlInput) wlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchWatchStock(); });
  if ($('#wlSearchBtn')) $('#wlSearchBtn').addEventListener('click', () => searchWatchStock());
  if ($('#wlSaveBtn')) $('#wlSaveBtn').addEventListener('click', () => saveWatchEditor());
  if ($('#wlCloseBtn')) $('#wlCloseBtn').addEventListener('click', () => closeWatchEditor());
  if ($('#wlModal')) $('#wlModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeWatchEditor(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const m = $('#wlModal');
    if (m && m.classList.contains('open')) closeWatchEditor();
  });

  $$('#newsFilters button[data-topic]').forEach((b) => {
    b.addEventListener('click', () => {
      state.newsTopic = b.dataset.topic;
      $$('#newsFilters button[data-topic]').forEach((x) => x.classList.toggle('active', x === b));
      renderNews();
    });
  });
  $('#newsRefresh').addEventListener('click', () => renderNews());

  $('#coalImportBtn').addEventListener('click', async () => {
    const csv = $('#coalCsvInput').value.trim();
    if (!csv) { $('#coalImportMsg').textContent = '请先粘贴 CSV 数据'; return; }
    $('#coalImportMsg').textContent = '导入中…';
    try {
      const result = await api('/api/coal/inventory/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csv })
      });
      $('#coalImportMsg').textContent = result.message + '：新增 ' + result.added + ' 行，覆盖 ' + result.replaced + ' 行，台账共 ' + result.total + ' 行。';
      renderCoal(result.series);
    } catch (err) {
      $('#coalImportMsg').innerHTML = '<span class="error">' + esc(err.message) + '</span>';
    }
  });
  $('#coalReloadBtn').addEventListener('click', () => loadCoal());

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if ($('#view-analysis').classList.contains('active') && state.analysisData) renderKline(state.analysisData);
      if ($('#view-commodity').classList.contains('active') && loaded.commodity && loaded.commodity.at) renderCommodity();
      if ($('#view-coal').classList.contains('active') && state.coal) renderCoal(state.coal);
      sizeEmbedFrame();
    }, 260);
  });

  bindEmbedEvents();
  bindWorkbenchEvents();
}

bindEvents();

// 回到上次看的页签：双击桌面快捷方式接着看，不用每次重新点
let startView = 'overview';
try {
  const saved = localStorage.getItem(LAST_VIEW_KEY);
  if (saved && VIEW_LABELS[saved]) startView = saved;
} catch (err) { /* 隐私模式下忽略 */ }
// 手机桌面图标的快捷方式会带 ?view=xxx，优先按它打开
try {
  const want = new URLSearchParams(location.search).get('view');
  if (want && VIEW_LABELS[want]) startView = want;
} catch (err) { /* 老浏览器忽略 */ }
switchView(startView);

// 总览每 60 秒自动刷新一次行情与舆情
setInterval(() => {
  if ($('#view-overview').classList.contains('active')) {
    api('/api/overview').then((data) => {
      renderOverview(data);
      renderStockTable(data);
    }).catch(() => {});
  }
}, 60000);

/* ============================== 工作站事件绑定 ============================== */

function bindWorkbenchEvents() {
  const gubaInput = $('#gubaCode');
  if ($('#gubaLoad')) $('#gubaLoad').addEventListener('click', () => loadGuba(gubaInput.value));
  if (gubaInput) gubaInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadGuba(gubaInput.value); });

  const aInput = $('#analysisCode');
  if ($('#analysisLoad')) $('#analysisLoad').addEventListener('click', () => openAnalysis(aInput.value));
  if (aInput) aInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') openAnalysis(aInput.value); });

  const gInput = $('#agentsCode');
  if ($('#agentsLoad')) $('#agentsLoad').addEventListener('click', () => runAgents(gInput.value));
  if (gInput) gInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runAgents(gInput.value); });

  const impBtn = $('#importCsvBtn');
  if (impBtn) impBtn.addEventListener('click', async () => {
    const csv = $('#importCsvInput').value.trim();
    if (!csv) { $('#importMsg').textContent = '请先粘贴 CSV 数据'; return; }
    $('#importMsg').textContent = '导入中…';
    try {
      const result = await api('/api/coal/import/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csv })
      });
      $('#importMsg').textContent = result.message + '：新增 ' + result.added + ' 行，覆盖 ' + result.replaced + ' 行，台账共 ' + result.total + ' 行。';
      renderCoalImport(result.series);
    } catch (err) {
      $('#importMsg').innerHTML = '<span class="error">' + esc(err.message) + '</span>';
    }
  });
  const impReload = $('#importReloadBtn');
  if (impReload) impReload.addEventListener('click', async () => {
    try { renderCoalImport(await api('/api/coal/import')); }
    catch (err) { $('#importMsg').innerHTML = '<span class="error">' + esc(err.message) + '</span>'; }
  });

  bindMenubar();
  initShell();

  window.addEventListener('resize', () => {
    if ($('#view-analysis').classList.contains('active') && state.analysisCode) {
      setTimeout(() => drawMinute(state.analysisCode), 300);
    }
  });
}
