'use strict';

const { fetchJson, fetchText } = require('../lib/http');
const { cached } = require('../lib/cache');
const ths = require('./ths');

/**
 * 市场全景：涨跌家数、涨停池、个股资金流、板块涨跌。
 *
 * 板块数据说明：东方财富的 clist 接口（m:90 板块列表）在本机网络下持续
 * fetch failed，多个主机名均不可用，故板块改用同花顺 bk_ 板块指数接口。
 */

const REF_EM = 'https://quote.eastmoney.com/';

const FUEL_FLOW_FIELDS = 'f12,f14,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87';

/* 坑：这个接口带 fltt=1 时百分比字段会被放大 100 倍（f184=441 表示 4.41%），
   直接拿去显示会变成「主力净占比 1442%」，所以统一除回 100 并保留两位小数。 */
const pctOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Number((n / 100).toFixed(2)) : 0;
};

/** 全市场涨跌家数（沪 + 深）。 */
async function getBreadth() {
  return cached('market:breadth', 60000, async () => {
    const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=1&secids=1.000001,0.399001' +
      '&fields=f12,f14,f2,f3,f6,f104,f105,f106,f124';
    const json = await fetchJson(url, { referer: REF_EM });
    const rows = (json.data && json.data.diff) || [];
    const sum = (key) => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
    const up = sum('f104');
    const down = sum('f105');
    const flat = sum('f106');
    const total = up + down + flat;
    return {
      updatedAt: new Date().toISOString(),
      up, down, flat, total,
      upRatio: total ? Number(((up / total) * 100).toFixed(1)) : null,
      downRatio: total ? Number(((down / total) * 100).toFixed(1)) : null,
      amountYuan: sum('f6'),
      indexes: rows.map((r) => ({ code: r.f12, name: r.f14, price: (Number(r.f2) || 0) / 100, changePct: (Number(r.f3) || 0) / 100 }))
    };
  });
}

/** 涨停池（东财 push2ex）。date 形如 20260925。 */
async function getLimitUpPool(date, pageSize = 20) {
  const d = date || new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  return cached('market:ztpool:' + d + ':' + pageSize, 300000, async () => {
    const url = 'https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989' +
      '&dpt=wz.ztzt&Pageindex=0&pagesize=' + pageSize + '&sort=fbt%3Aasc&date=' + d;
    const json = await fetchJson(url, { referer: REF_EM });
    const pool = (json.data && json.data.pool) || [];
    return pool.map((r) => ({
      code: r.c,
      name: r.n,
      price: r.p / 1000,
      changePct: r.zdp,
      amount: r.amount,
      turnoverRate: r.hs,
      firstLimitTime: String(r.fbt).padStart(6, '0').replace(/(\d{2})(\d{2})(\d{2})/, '$1:$2:$3'),
      lastLimitTime: String(r.lbt).padStart(6, '0').replace(/(\d{2})(\d{2})(\d{2})/, '$1:$2:$3'),
      openTimes: r.zbc,
      limitUpDays: r.lbc,
      industry: r.hybk
    }));
  });
}

/** 个股资金流（东财 ulist，f62 主力净额等）。 */
async function getFundFlow(codes) {
  const list = (codes || []).map((c) => String(c).replace(/\D/g, '')).filter(Boolean);
  if (!list.length) return [];
  const hash = list.slice().sort().join(',');
  return cached('market:flow:' + hash, 60000, async () => {
    const secids = list.map((c) => (/^(6|9|5)/.test(c) ? '1.' : '0.') + c).join(',');
    const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=1&secids=' + secids + '&fields=' + FUEL_FLOW_FIELDS;
    const json = await fetchJson(url, { referer: REF_EM });
    const rows = (json.data && json.data.diff) || [];
    return rows.map((r) => ({
      code: r.f12,
      name: r.f14,
      mainNet: Number(r.f62) || 0,
      mainPct: pctOf(r.f184),
      superNet: Number(r.f66) || 0,
      superPct: pctOf(r.f69),
      bigNet: Number(r.f72) || 0,
      bigPct: pctOf(r.f75),
      midNet: Number(r.f78) || 0,
      midPct: pctOf(r.f81),
      smallNet: Number(r.f84) || 0,
      smallPct: pctOf(r.f87)
    }));
  });
}

/** 板块涨跌（同花顺 bk_ 板块指数）。 */
async function getSectors(boardCodes) {
  const codes = boardCodes && boardCodes.length ? boardCodes : [];
  return ths.fetchSectorQuotes(codes);
}

/** 综合市场全景。 */
async function getMarketOverview(watchCodes, boardCodes) {
  const [breadth, sectors, flow] = await Promise.all([
    getBreadth().catch(() => null),
    getSectors(boardCodes).catch(() => []),
    getFundFlow(watchCodes).catch(() => [])
  ]);
  return {
    updatedAt: new Date().toISOString(),
    breadth,
    sectors,
    sectorSource: '同花顺板块指数（bk_）',
    fundFlow: flow.sort((a, b) => b.mainNet - a.mainNet)
  };
}

module.exports = { getBreadth, getLimitUpPool, getFundFlow, getSectors, getMarketOverview, pctOf };
