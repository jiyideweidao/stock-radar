'use strict';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchText(url, options = {}) {
  const { referer, encoding = 'utf-8', timeoutMs = 15000, headers = {} } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(referer ? { Referer: referer } : {}),
        ...headers
      }
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status + ' ' + res.statusText + ' -> ' + url);
      err.status = res.status;
      throw err;
    }
    if (encoding === 'gbk' || encoding === 'gb18030') {
      return new TextDecoder('gb18030').decode(buf);
    }
    return buf.toString('utf8');
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时 -> ' + url);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 剥掉 JSONP 包装（cb({...}) / var x=([...]) / 带 script 前缀），返回纯 JSON 文本。 */
function unwrapJsonp(text) {
  const cleaned = String(text).trim().replace(/^\/\*[\s\S]*?\*\/\s*/, '');
  const firstObj = cleaned.indexOf('{');
  const firstArr = cleaned.indexOf('[');
  const candidates = [firstObj, firstArr].filter((i) => i >= 0);
  if (!candidates.length) throw new Error('响应中没有 JSON 负载');
  const start = Math.min.apply(null, candidates);
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (end <= start) throw new Error('JSON 负载不完整');
  return cleaned.slice(start, end + 1);
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  return JSON.parse(unwrapJsonp(text));
}

/** 并发抓取：单项失败不影响整体，返回 { name: { ok, data|error } }。 */
async function settleAll(tasks) {
  const entries = Object.entries(tasks);
  const results = await Promise.all(
    entries.map(async ([name, fn]) => {
      try {
        return [name, { ok: true, data: await fn() }];
      } catch (err) {
        return [name, { ok: false, error: String((err && err.message) || err) }];
      }
    })
  );
  return Object.fromEntries(results);
}

module.exports = { fetchText, fetchJson, unwrapJsonp, settleAll, DEFAULT_UA };
