'use strict';

const { DEFAULT_UA } = require('../lib/http');

/**
 * 「原样嵌入第三方页面」的白名单。
 *
 * 为什么要有白名单，而不是让前端随便传 URL：
 *   1) 本地服务就永远只是一个读取固定几个页面的客户端，不会变成任意 URL 的转发器；
 *   2) 一个页面能不能被 iframe 嵌进去，取决于对方返回的 X-Frame-Options /
 *      Content-Security-Policy: frame-ancestors。同一个网站的不同页面结论可能不一样
 *      （实测金融界：大盘云图没有任何限制，涨跌停温度计和龙虎榜都是 SAMEORIGIN），
 *      所以每次都要先探一次，把「对方禁止嵌入」如实告诉界面，而不是甩一个白屏给用户。
 */
const EMBEDS = {
  dpyt: {
    name: '大盘云图',
    url: 'https://summary.jrj.com.cn/dataCenter/dpyt/',
    describe: '全市场按行业分块的涨跌热力图 · 方块≈市值，红涨绿跌'
  },
  zdtwdj: {
    name: '涨跌停温度计',
    url: 'https://summary.jrj.com.cn/dataCenter/zdtwdj',
    describe: '涨跌停家数与温度计'
  },
  lhb: {
    name: '龙虎榜',
    url: 'https://summary.jrj.com.cn/dataCenter/lhb',
    describe: '每日龙虎榜营业部席位明细'
  }
};

/* 本机服务自己的地址：判断 frame-ancestors 是否放行时用得上 */
const SELF_ORIGIN = 'http://127.0.0.1:' + Number(process.env.PORT || 8787);

/**
 * 白名单校验：同步抛错，调用方（路由 / 自检）一眼就能看出是参数问题而不是网络问题。
 * 这样「只允许金融界这三个页面」这条约束本身就能被离线自检覆盖。
 */
function resolve(id) {
  const key = String(id === undefined || id === null ? '' : id);
  const item = Object.prototype.hasOwnProperty.call(EMBEDS, key) ? EMBEDS[key] : null;
  if (!item) throw new Error('不支持的嵌入项：' + key + '（可用：' + Object.keys(EMBEDS).join(', ') + '）');
  return Object.assign({ id: key }, item);
}

function list() {
  return Object.entries(EMBEDS).map(([id, x]) => ({
    id: id, name: x.name, url: x.url, describe: x.describe
  }));
}

/** 从响应头判断「这个页面允不允许被我们嵌进 iframe」。返回 null 表示允许。 */
function frameBlock(headers) {
  const xfo = headers.get('x-frame-options');
  if (xfo) {
    const v = xfo.trim().toUpperCase();
    if (v.indexOf('DENY') === 0) return 'X-Frame-Options: ' + xfo.trim();
    if (v.indexOf('SAMEORIGIN') === 0) return 'X-Frame-Options: ' + xfo.trim();
    if (v.indexOf('ALLOW-FROM') === 0 && v.indexOf(SELF_ORIGIN.toUpperCase()) < 0) {
      return 'X-Frame-Options: ' + xfo.trim();
    }
  }
  const csp = headers.get('content-security-policy') || '';
  const m = csp.match(/frame-ancestors([^;]*)/i);
  if (m) {
    const value = m[1].trim();
    const allows = value === '*' || value.split(/\s+/).some((s) => s && s !== "'none'" &&
      (s === SELF_ORIGIN || s.indexOf('127.0.0.1') >= 0 || s.indexOf('localhost') >= 0));
    if (!allows) return 'Content-Security-Policy: frame-ancestors ' + value;
  }
  return null;
}

/** 探测某个白名单页面现在能不能嵌：能/不能、为什么不能，都说清楚。 */
async function preflight(id) {
  const item = resolve(id);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  let res;
  try {
    res = await fetch(item.url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    });
  } catch (err) {
    const reason = err && err.name === 'AbortError'
      ? '请求超时（12 秒）' : ((err && err.message) || err);
    return {
      id: id, name: item.name, url: item.url, describe: item.describe,
      reachable: false, ok: false, frameable: false,
      error: '连不上金融界（' + reason + '）',
      ms: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
  const blockedBy = frameBlock(res.headers);
  /* 这里只关心响应头，不需要正文；把 body 取消掉，别占着连接不还 */
  try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (err) { /* 忽略 */ }
  return {
    id: id,
    name: item.name,
    url: item.url,
    describe: item.describe,
    reachable: true,
    ok: res.ok,
    status: res.status,
    frameable: res.ok && !blockedBy,
    blockedBy: blockedBy,
    error: res.ok ? null : ('金融界返回 HTTP ' + res.status),
    ms: Date.now() - started
  };
}

module.exports = { EMBEDS, resolve, list, preflight, frameBlock };
