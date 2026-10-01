'use strict';

const fs = require('fs');
const path = require('path');
const { fetchJson } = require('./http');

/**
 * 英文快讯的机器翻译（面向中文读者）。
 *
 * 为什么自己包一层，而不是直接调一个翻译 API：
 *   1) 这台机器上「免密钥」的翻译接口能用的很少，实测：
 *      谷歌 translate.googleapis.com / translate.google.com 超时；
 *      Bing ttranslatev3（含 cn.bing.com）返回 200 但 body 为空；
 *      Yandex v1 已下线（410）；腾讯 transmart / 搜狗 要签名；
 *      能通的只有「有道 demo」和「MyMemory」。
 *   2) 两个源都有硬限制，必须限速排队 + 跳过冷却 + 持久化缓存：
 *      - 有道：连着发 4~5 条就返回 errorCode 411，约 10 秒后自动恢复；
 *      - MyMemory：实测 500ms 间隔可稳定连续翻（responseStatus 200、quotaFinished=false）。
 *      同一条英文稿一辈子只翻一次，翻完存盘，重启不重翻，也不浪费额度。
 *   3) 光靠「用户请求时顺带翻」跟不上金十那种滚动快讯（旧条目很快被挤掉），
 *      所以另起一个**后台队列**持续把英文稿翻好写进缓存；
 *      页面再来请求时直接命中缓存，中文是现成的、不用等。
 *   4) 一轮翻不完就留到下一轮接着翻（界面先显示英文原文），绝不为了翻译把新闻页卡住。
 *   5) 两个源都不可用时**不编造**：保留英文原文，界面标注「未翻译」。
 *
 * 只处理「金十数据·快讯」这类一条一条的英文短稿；中文条目直接跳过，一个请求都不发。
 */

const CACHE_FILE = path.join(__dirname, '..', 'data', 'translate-cache.json');
const CACHE_MAX = 3000;

const state = {
  cache: new Map(),        // key -> { zh, provider, at }
  loaded: false,
  saveTimer: null,
  providers: {}            // name -> { ok, fail, lastError, readyAt, cooldownUntil }
};

/* ------------------------------- 缓存 ------------------------------- */

const keyOf = (text) => String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim();

function loadCache() {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8').replace(/^\uFEFF/, ''));
    Object.keys(raw).forEach((k) => {
      const v = raw[k];
      if (v && v.zh) state.cache.set(k, v);
    });
  } catch (err) {
    /* 文件不存在或内容坏了都当空缓存：翻译是锦上添花，不能因为它起不来 */
  }
}

/** 去抖落盘：翻译很碎，别每来一条就写一次文件。 */
function scheduleSave() {
  if (state.saveTimer) return;
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    try {
      const slim = {};
      Array.from(state.cache.entries()).slice(-CACHE_MAX).forEach(([k, v]) => { slim[k] = v; });
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(slim));
    } catch (err) { /* 落盘失败只影响省额度，不影响功能 */ }
  }, 2000);
  if (state.saveTimer.unref) state.saveTimer.unref();
}

/* ----------------------------- 语言判断 ----------------------------- */

/** 需要翻译吗：有足够多的拉丁字母，且中文字符占比很低。纯数字/代码/短词一律跳过。 */
function needsTranslation(text) {
  const s = String(text === null || text === undefined ? '' : text);
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (latin < 12) return false;
  return cjk / (cjk + latin) < 0.1;
}

/* ----------------------------- 结果润色 ----------------------------- */

/**
 * 免费接口的译文有两类小毛病，顺手修掉：
 *   - 金额写成「310 $」，中文财经稿里习惯写「310美元」；
 *   - 「15 bln / 15 mln」这种英文数量级，换成中文的「150亿 / 1500万」。
 * 只在数字后面才替换，避免把普通 $ 符号也一起改了。
 */
function tidy(zh) {
  let s = String(zh === null || zh === undefined ? '' : zh).replace(/\s+/g, ' ').trim();
  s = s.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '');
  const num = (n) => Math.round(Number(String(n).replace(/,/g, '')) * 100) / 100;
  const B = '(?:bln|billion)(?![A-Za-z])';   // 不能用 \b：后面跟中文时 \b 是不成立的
  const M = '(?:mln|million)(?![A-Za-z])';
  // 顺序有讲究：带数量级的先处理（"$15 bln" → "150亿美元"），
  // 否则 "15 $" 会先被换成 "15美元"，剩下孤零零的 bln 再也匹配不上。
  // 每条都带可选的「美元」，是因为翻译引擎自己也可能吐出「15 bln美元」这种半中半英。
  s = s.replace(new RegExp('\\$\\s*(\\d[\\d,.]*)\\s*' + B + '\\s*(?:美元|美金)?', 'gi'), (m, n) => num(n) * 10 + '亿美元');
  s = s.replace(new RegExp('(\\d[\\d,.]*)\\s*' + B + '\\s*(?:美元|美金)', 'gi'), (m, n) => num(n) * 10 + '亿美元');
  s = s.replace(new RegExp('(\\d[\\d,.]*)\\s*' + B, 'gi'), (m, n) => num(n) * 10 + '亿');
  s = s.replace(new RegExp('\\$\\s*(\\d[\\d,.]*)\\s*' + M + '\\s*(?:美元|美金)?', 'gi'), (m, n) => num(n) * 100 + '万美元');
  s = s.replace(new RegExp('(\\d[\\d,.]*)\\s*' + M + '\\s*(?:美元|美金)', 'gi'), (m, n) => num(n) * 100 + '万美元');
  s = s.replace(new RegExp('(\\d[\\d,.]*)\\s*' + M, 'gi'), (m, n) => num(n) * 100 + '万');
  s = s.replace(/(\d[\d,.]*)\s*\$/g, (m, n) => n + '美元');
  s = s.replace(/\$\s*(\d[\d,.]*)/g, (m, n) => n + '美元');
  s = s.replace(/美元美元/g, '美元');
  // 中文与数字之间的多余空格（"2000万 吨" → "2000万吨"），中文读起来更顺
  s = s.replace(/([0-9%万亿])\s+([\u4e00-\u9fff])/g, '$1$2');
  s = s.replace(/([\u4e00-\u9fff])\s+([0-9])/g, '$1$2');
  return s;
}

/* --------------------------- 送翻前的预处理 --------------------------- */

/**
 * 「(MRVL.O)」这类括号里的英文代码在删掉之后再翻。
 * 原因：有道会把括号代码当成股票去查，返回「（mrv . o：行情）」这种乱码，
 * 实测还会把「上调至」翻成「降至」——方向都反了。去掉之后译文干净且正确，
 * 而英文原文在界面上照样完整显示（就在中文下面一行），代码不会丢。
 */
const TICKER_RE = /[（(]\s*[A-Za-z]{1,6}\s*[.．]\s*[A-Za-z]{1,3}\s*[)）]/g;

function prepForTranslate(text) {
  const s = String(text === null || text === undefined ? '' : text);
  const stripped = s.replace(TICKER_RE, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([,:;.])/g, '$1').trim();
  return stripped.length >= 8 ? stripped : s.trim();   // 整条就是代码时不硬删
}

/** 缓存键：统一用「预处理之后」的文本，同一件事的两种写法共用一份译文。 */
function cacheKey(text) { return keyOf(prepForTranslate(text)); }

/* ------------------------------ 翻译源 ------------------------------ */

function providerState(name) {
  if (!state.providers[name]) {
    state.providers[name] = { ok: 0, fail: 0, lastError: null, readyAt: 0, cooldownUntil: 0 };
  }
  return state.providers[name];
}

/**
 * 只等「同源最小间隔」，**不等冷却期**。
 * 早期版本这里会把冷却期一起等（最长 15 秒），结果一个源被限流之后，
 * 每翻一条都要先干等十几秒 —— 一次刷新只能翻出三四条，滚动快讯永远追不上。
 * 现在冷却中的源由上层直接跳过，把机会让给另一个源。
 */
async function waitTurn(st, minGapMs) {
  const now = Date.now();
  const wait = Math.max(st.readyAt - now, 0);
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
  st.readyAt = Date.now() + minGapMs;
}

/** 有道 demo 接口：中文质量较好，但连着发几条就 411，约 10 秒后恢复。 */
async function viaYoudao(text) {
  const st = providerState('youdao');
  await waitTurn(st, 1300);
  const url = 'https://aidemo.youdao.com/trans?q=' + encodeURIComponent(text) + '&from=en&to=zh-CHS';
  const json = await fetchJson(url, { referer: 'https://fanyi.youdao.com/', timeoutMs: 9000 });
  const code = Number(json.errorCode);
  if (code === 411) {
    st.fail += 1;
    st.lastError = '有道返回 411（访问频率受限）';
    st.cooldownUntil = Date.now() + 15000;   // 实测约 10 秒恢复，留点余量
    return null;
  }
  if (code !== 0) {
    st.fail += 1;
    st.lastError = '有道返回 errorCode ' + json.errorCode;
    st.cooldownUntil = Date.now() + 30000;
    return null;
  }
  const zh = tidy((json.translation || [])[0]);
  if (!zh) { st.fail += 1; st.lastError = '有道返回空译文'; return null; }
  st.ok += 1;
  st.lastError = null;
  return { zh: zh, provider: 'youdao' };
}
viaYoudao.providerName = 'youdao';

/** MyMemory：匿名有每日字符额度，但实测 500ms 间隔可稳定连发，是后台队列的主力。 */
async function viaMyMemory(text) {
  const st = providerState('mymemory');
  await waitTurn(st, 450);
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|zh-CN';
  const json = await fetchJson(url, { referer: 'https://mymemory.translated.net/', timeoutMs: 9000 });
  const detail = String(json.responseDetails || '');
  const raw = json.responseData && json.responseData.translatedText;
  if (Number(json.responseStatus) !== 200 || !raw) {
    st.fail += 1;
    st.lastError = 'MyMemory 返回异常：' + (detail || json.responseStatus);
    if (/QUOTA|LIMIT|MYMEMORY WARNING/i.test(detail)) st.cooldownUntil = Date.now() + 600000;
    return null;
  }
  if (/^(INVALID|QUERY LENGTH|MYMEMORY WARNING)/i.test(String(raw))) {
    st.fail += 1;
    st.lastError = 'MyMemory 拒绝：' + String(raw).slice(0, 60);
    st.cooldownUntil = Date.now() + 600000;
    return null;
  }
  const zh = tidy(raw);
  if (!zh) { st.fail += 1; st.lastError = 'MyMemory 返回空译文'; return null; }
  st.ok += 1;
  st.lastError = null;
  return { zh: zh, provider: 'mymemory' };
}
viaMyMemory.providerName = 'mymemory';

/** 有道优先（财经措辞更准），它被限流时 MyMemory 顶上。 */
const CHAIN = [viaYoudao, viaMyMemory];

/**
 * 翻译一段英文。命中缓存直接返回（不计额度、不计耗时）；两个源都不行时返回 null。
 * 冷却中的源直接跳过 —— 不等，让另一个源接手。
 */
async function translateText(text) {
  loadCache();
  const key = cacheKey(text);
  if (!key || !needsTranslation(key)) return null;
  const hit = state.cache.get(key);
  if (hit && hit.zh) return { zh: hit.zh, provider: hit.provider, cached: true };

  let skippedAll = true;
  for (const fn of CHAIN) {
    const st = providerState(fn.providerName);
    if (st.cooldownUntil > Date.now()) continue;   // 冷却中：跳过，不阻塞
    skippedAll = false;
    let r = null;
    try { r = await fn(key); }
    catch (err) {
      st.fail += 1;
      st.lastError = String((err && err.message) || err);
      st.cooldownUntil = Date.now() + 30000;
    }
    if (r && r.zh) {
      state.cache.set(key, { zh: r.zh, provider: r.provider, at: new Date().toISOString() });
      scheduleSave();
      return { zh: r.zh, provider: r.provider, cached: false };
    }
  }
  return skippedAll ? { zh: null, provider: null, cooling: true } : null;
}

/* --------------------------- 后台翻译队列 --------------------------- */

/**
 * 光靠用户请求顺带翻，追不上滚动快讯（英文条目几十秒就被挤下去）。
 * 这里维护一个后台队列：谁见了英文稿就往里塞，后台一直以「翻译源能承受的速度」慢慢翻，
 * 翻好直接进持久缓存。页面下次刷新就是中文，而且不额外等。
 */
const queue = {
  items: [],        // 待翻的 key（去重、先进先出）
  seen: new Set(),  // 最近入过队的 key，避免同一条反复排队
  running: false,
  done: 0,
  lastAt: null
};
const QUEUE_MAX = 600;
const SEEN_MAX = 6000;

function enqueue(texts) {
  loadCache();
  let added = 0;
  for (const t of texts) {
    if (!t) continue;
    const key = cacheKey(t);
    if (!key || !needsTranslation(key)) continue;
    if (state.cache.has(key) || queue.seen.has(key)) continue;
    queue.seen.add(key);
    if (queue.items.length < QUEUE_MAX) { queue.items.push(key); added += 1; }
  }
  if (queue.seen.size > SEEN_MAX) queue.seen = new Set(queue.items);
  if (added) startQueue();
  return added;
}

/** 所有源都在冷却就别空转，过几秒再看。 */
const anyProviderReady = () => CHAIN.some((fn) => providerState(fn.providerName).cooldownUntil <= Date.now());

function startQueue() {
  if (queue.running) return;
  queue.running = true;
  const tick = async () => {
    if (!queue.items.length) { queue.running = false; return; }
    if (!anyProviderReady()) { setTimeout(tick, 3000); return; }
    const key = queue.items.shift();
    try { await translateText(key); } catch (err) { /* 后台任务不抛错 */ }
    queue.done += 1;
    queue.lastAt = new Date().toISOString();
    setTimeout(tick, 30);
  };
  setTimeout(tick, 30);
}

/* --------------------------- 批量（资讯条目） --------------------------- */

/**
 * 就地为资讯条目补上中文：item.titleZh / item.summaryZh，并标 item.translatedBy。
 * 1) 先把所有英文稿塞进后台队列（下一轮刷新就不缺了）；
 * 2) 再就地补：命中缓存的直接填（免费、瞬间），没缓存的按 budget / maxWaitMs 硬上限翻几条。
 * 到点就走人，剩下的留给后台队列和下一轮，绝不为翻译把新闻页卡住。
 */
async function translateItems(items, options) {
  const opts = options || {};
  const budget = Number.isFinite(opts.budget) ? opts.budget : 20;
  const deadline = Date.now() + (Number.isFinite(opts.maxWaitMs) ? opts.maxWaitMs : 8000);
  const list = (items || []).filter(Boolean);
  const todo = [];
  const seen = new Set();
  const toQueue = [];
  for (const item of list) {
    const jobs = [
      { item: item, text: item.title, field: 'titleZh' },
      { item: item, text: item.summary, field: 'summaryZh' }
    ];
    for (const job of jobs) {
      if (!job.text || job.item[job.field]) continue;
      if (!needsTranslation(job.text)) continue;
      const key = cacheKey(job.text);
      // summary 和 title 一样长的时候（金十的短讯经常如此）不重复翻
      if (job.field === 'summaryZh' && key === cacheKey(item.title)) {
        todo.push({ item: item, text: null, field: 'summaryZh', copyFromTitle: true });
        continue;
      }
      if (!state.cache.has(key)) toQueue.push(job.text);
      if (seen.has(key)) { todo.push({ item: item, text: null, field: job.field, reuseKey: key }); continue; }
      seen.add(key);
      todo.push({ item: item, text: job.text, field: job.field });
    }
  }
  enqueue(toQueue);

  const results = new Map();   // key -> zh
  let spent = 0;
  for (const job of todo) {
    if (job.copyFromTitle || job.reuseKey) continue;
    const key = cacheKey(job.text);
    const hit = state.cache.get(key);
    if (hit && hit.zh) { results.set(key, hit.zh); continue; }   // 缓存命中不算预算
    if (spent >= budget || Date.now() > deadline) continue;
    const r = await translateText(job.text);
    if (r && r.zh) { results.set(key, r.zh); if (!r.cached) spent += 1; }
  }

  for (const job of todo) {
    if (job.copyFromTitle) {
      if (job.item.titleZh) job.item.summaryZh = job.item.titleZh;
      continue;
    }
    const zh = job.reuseKey ? results.get(job.reuseKey) : results.get(cacheKey(job.text));
    if (zh) {
      job.item[job.field] = zh;
      job.item.translatedBy = '机器翻译';
    }
  }
  return list;
}

/** 给界面/自检看的当前状态：命中缓存多少条、队列还剩多少、各源成功失败多少、上次错在哪。 */
function stats() {
  loadCache();
  const providers = {};
  Object.keys(state.providers).forEach((k) => {
    const st = state.providers[k];
    providers[k] = { ok: st.ok, fail: st.fail, lastError: st.lastError, cooling: st.cooldownUntil > Date.now() };
  });
  return {
    cached: state.cache.size,
    queue: { pending: queue.items.length, done: queue.done, running: queue.running, lastAt: queue.lastAt },
    providers: providers
  };
}

module.exports = { needsTranslation, prepForTranslate, tidy, cacheKey, translateText, translateItems, enqueue, stats, CACHE_FILE };
