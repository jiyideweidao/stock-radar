'use strict';

const { fetchText } = require('../lib/http');
const { cached } = require('../lib/cache');
const { decorate, stripHtml } = require('../lib/feed');

/**
 * 同花顺公开行情接口（d.10jqka.com.cn）。
 *
 * 接口返回形如 `quotebridge_v6_xxx({...})` 的 JS，需剥壳后 JSON.parse。
 * 必须带 Referer，否则可能被拒。
 *
 * 字段位说明（realhead，键为数字字符串）：
 *   5 代码 | 10 最新价 | 6 昨收 | 7 开盘 | 8 最高 | 9 最低
 *   13 成交量(股) | 19 成交额(元) | 199112 涨跌幅% | 264648 涨跌额
 *   1968584 换手率% | 1771976 量比 | 1149395 市净率
 *   69 涨停价 | 70 跌停价 | 3475914 总市值 | 3541450 流通市值
 *   name 名称 | updateTime 更新时间 | stockStatus 状态
 * 以上已与东方财富同标的同交易日数据交叉验证一致。
 *
 * 日 K 记录字段序（**与东方财富不同，注意**）：
 *   date, open, high, low, close, volume(股), amount(元), turnover%
 */

const REF_STOCK = 'https://stockpage.10jqka.com.cn/';
const REF_BOARD = 'https://q.10jqka.com.cn/';
const REF_NEWS = 'https://news.10jqka.com.cn/';

function unwrapJs(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('同花顺响应不是可解析的 JS 对象');
  return JSON.parse(text.slice(start, end + 1));
}

function num(v) {
  if (v === '' || v === undefined || v === null || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function marketPrefix(code) {
  const c = String(code).replace(/\D/g, '');
  return /^(6|9|5)/.test(c) ? 'hs_' : 'hs_';
}

/** 同花顺个股实时行情。 */
async function fetchQuote(code) {
  const c = String(code).replace(/\D/g, '');
  return cached('ths:quote:' + c, 30000, async () => {
    const url = 'https://d.10jqka.com.cn/v6/realhead/hs_' + c + '/defer/last.js';
    const text = await fetchText(url, { referer: REF_STOCK });
    const obj = unwrapJs(text);
    const it = obj.items || {};
    return {
      code: it['5'] || c,
      name: it.name || '',
      price: num(it['10']),
      prevClose: num(it['6']),
      open: num(it['7']),
      high: num(it['8']),
      low: num(it['9']),
      volumeShares: num(it['13']),
      amountYuan: num(it['19']),
      changePct: num(it['199112']),
      change: num(it['264648']),
      turnoverRate: num(it['1968584']),
      volumeRatio: num(it['1771976']),
      pb: num(it['1149395']),
      limitUp: num(it['69']),
      limitDown: num(it['70']),
      marketCap: num(it['3475914']),
      floatCap: num(it['3541450']),
      updateTime: it.updateTime || '',
      status: it.stockStatus || '',
      source: '同花顺'
    };
  });
}

/** 同花顺日 K 线（01 = 前复权）。 */
async function fetchDaily(code, limit = 250) {
  const c = String(code).replace(/\D/g, '');
  return cached('ths:daily:' + c + ':' + limit, 300000, async () => {
    const url = 'https://d.10jqka.com.cn/v6/line/hs_' + c + '/01/last.js';
    const text = await fetchText(url, { referer: REF_STOCK });
    const obj = unwrapJs(text);
    const rows = String(obj.data || '').split(';').filter(Boolean);
    const parsed = rows.map((row) => {
      const p = row.split(',');
      const d = p[0];
      return {
        date: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8),
        open: Number(p[1]),
        high: Number(p[2]),
        low: Number(p[3]),
        close: Number(p[4]),
        volume: Number(p[5]),
        amount: Number(p[6]),
        turnoverRate: Number(p[7]) || null
      };
    });
    return { name: obj.name || '', total: Number(obj.total) || parsed.length, rows: parsed.slice(-limit) };
  });
}

/** 同花顺分时（当日逐分钟，含均价线）。 */
async function fetchMinute(code) {
  const c = String(code).replace(/\D/g, '');
  return cached('ths:minute:' + c, 60000, async () => {
    const url = 'https://d.10jqka.com.cn/v6/time/hs_' + c + '/last.js';
    const text = await fetchText(url, { referer: REF_STOCK });
    const obj = unwrapJs(text);
    const v = obj['hs_' + c] || {};
    const points = String(v.data || '').split(';').filter(Boolean).map((row) => {
      const p = row.split(',');
      const hm = p[0];
      return {
        time: hm.slice(0, 2) + ':' + hm.slice(2, 4),
        price: Number(p[1]),
        volume: Number(p[2]),
        avgPrice: Number(p[3])
      };
    });
    return { date: v.date, prevClose: Number(v.pre), points, isTrading: v.isTrading === 1 };
  });
}

/** 同花顺板块指数行情（bk_ 代码）。 */
async function fetchSectorQuote(boardCode) {
  const code = String(boardCode).replace(/^bk_/, '');
  return cached('ths:sector:' + code, 60000, async () => {
    const url = 'https://d.10jqka.com.cn/v6/realhead/bk_' + code + '/defer/last.js';
    const text = await fetchText(url, { referer: REF_BOARD });
    const it = unwrapJs(text).items || {};
    return {
      code: 'bk_' + code,
      name: it.name || '',
      price: num(it['10']),
      prevClose: num(it['6']),
      changePct: num(it['199112']),
      change: num(it['264648']),
      volumeShares: num(it['13']),
      amountYuan: num(it['19']),
      leaderName: '',
      source: '同花顺板块'
    };
  });
}

async function fetchSectorQuotes(boardCodes) {
  const list = await Promise.all(
    (boardCodes || []).map((c) => fetchSectorQuote(c).catch(() => null))
  );
  return list.filter(Boolean).sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
}

/** 同花顺当日要闻列表（GBK 页面，正则解析）。 */
async function fetchNewsList(limit = 30) {
  return cached('ths:news:' + limit, 300000, async () => {
    const html = await fetchText('https://news.10jqka.com.cn/today_list/', { referer: REF_NEWS, encoding: 'gbk' });
    const out = [];
    const seen = new Set();
    const re = /<a[^>]+href="(http:\/\/news\.10jqka\.com\.cn\/(\d{8})\/c(\d+)\.shtml)"[^>]*?(?:title="([^"]*)")?[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = m[1];
      const date = m[2];
      const title = (m[4] || m[5] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!title || title.length < 6 || seen.has(url)) continue;
      seen.add(url);
      out.push(decorate({
        id: 'ths-' + m[3],
        source: '同花顺·要闻',
        title,
        summary: '',
        url,
        timestamp: date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8) + 'T09:00:00+08:00'
      }));
    }
    return out.slice(0, limit);
  });
}

module.exports = { fetchQuote, fetchDaily, fetchMinute, fetchSectorQuote, fetchSectorQuotes, fetchNewsList, unwrapJs };
