'use strict';

const { fetchJson } = require('../lib/http');
const { cached } = require('../lib/cache');

const EM_QUOTE_FIELDS = [
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f8', 'f9', 'f10', 'f12', 'f13', 'f14',
  'f15', 'f16', 'f17', 'f18', 'f20', 'f21', 'f23'
].join(',');

const UA_REF = 'https://quote.eastmoney.com/';

/** A 股代码 -> 东方财富 secid（1=沪市/科创板, 0=深市/创业板/北交所） */
function toSecid(code) {
  const c = String(code).replace(/\D/g, '');
  const market = /^(6|9|5|11|13)/.test(c) ? 1 : 0;
  return market + '.' + c;
}

function scale(value, digits) {
  if (value === null || value === undefined || value === '-' || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const dp = Number.isFinite(digits) ? digits : 2;
  return Number((num / Math.pow(10, dp)).toFixed(dp));
}

function mapQuote(row) {
  const dp = Number.isFinite(row.f1) ? row.f1 : 2;
  return {
    code: row.f12,
    name: row.f14,
    price: scale(row.f2, dp),
    changePct: scale(row.f3, 2),
    change: scale(row.f4, dp),
    volumeLots: row.f5 === '-' ? null : Number(row.f5),
    amountYuan: row.f6 === '-' ? null : Number(row.f6),
    high: scale(row.f15, dp),
    low: scale(row.f16, dp),
    open: scale(row.f17, dp),
    prevClose: scale(row.f18, dp),
    turnoverRate: scale(row.f8, 2),
    pe: scale(row.f9, 2),
    volumeRatio: scale(row.f10, 2),
    marketCap: row.f20 === '-' ? null : Number(row.f20),
    floatCap: row.f21 === '-' ? null : Number(row.f21),
    pb: scale(row.f23, 2)
  };
}

/** 批量实时行情。ttl 默认 30 秒。 */
async function getQuotes(codes, ttlMs = 30000) {
  const list = (codes || []).map((c) => String(c).replace(/\D/g, '')).filter(Boolean);
  if (!list.length) return [];
  const hash = list.slice().sort().join(',');
  return cached('quotes:' + hash, ttlMs, async () => {
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=1&secids=' +
      list.map(toSecid).join(',') +
      '&fields=' + EM_QUOTE_FIELDS;
    const json = await fetchJson(url, { referer: UA_REF });
    const diff = (json && json.data && json.data.diff) || [];
    const rows = Array.isArray(diff) ? diff : Object.values(diff);
    return rows.filter(Boolean).map(mapQuote);
  });
}

/**
 * 日 K 线。klt: 101=日 102=周 103=月
 * @returns {Array<{date,open,close,high,low,volume,amount}>}
 */
async function getKline(code, limit = 120, klt = 101) {
  const secid = toSecid(code);
  return cached('kline:' + secid + ':' + klt + ':' + limit, 300000, async () => {
    const url =
      'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid +
      '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57' +
      '&klt=' + klt + '&fqt=1&end=20500101&lmt=' + limit;
    const json = await fetchJson(url, { referer: UA_REF });
    const klines = (json && json.data && json.data.klines) || [];
    return klines.map((line) => {
      const p = line.split(',');
      return {
        date: p[0],
        open: Number(p[1]),
        close: Number(p[2]),
        high: Number(p[3]),
        low: Number(p[4]),
        volume: Number(p[5]),
        amount: Number(p[6])
      };
    });
  });
}

/** 均线计算（收盘价简单移动平均），返回与输入等长的数组，前 n-1 位为 null。 */
function sma(closes, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i += 1) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    out.push(i >= n - 1 ? Number((sum / n).toFixed(3)) : null);
  }
  return out;
}

const INDEXES = [
  { code: '000001', name: '上证指数', secid: '1.000001' },
  { code: '399001', name: '深证成指', secid: '0.399001' },
  { code: '399006', name: '创业板指', secid: '0.399006' },
  { code: '000688', name: '科创50', secid: '1.000688' }
];

async function getIndexes() {
  return cached('indexes', 30000, async () => {
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=1&secids=' +
      INDEXES.map((i) => i.secid).join(',') + '&fields=' + EM_QUOTE_FIELDS;
    const json = await fetchJson(url, { referer: UA_REF });
    const diff = (json && json.data && json.data.diff) || [];
    const rows = Array.isArray(diff) ? diff : Object.values(diff);
    return rows.filter(Boolean).map((row) => {
      const q = mapQuote(row);
      const meta = INDEXES.find((i) => i.code === q.code) || {};
      return { ...q, name: meta.name || q.name };
    });
  });
}

module.exports = { getQuotes, getKline, getIndexes, sma, toSecid, scale, INDEXES };
