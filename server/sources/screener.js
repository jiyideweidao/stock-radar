'use strict';

const { fetchText } = require('../lib/http');
const { cached } = require('../lib/cache');

/**
 * 选股器。
 *
 * 数据源：新浪财经 Market_Center 行情节点接口（可匿名、支持排序与分页）。
 * 说明：东方财富的 clist 全市场列表接口在本机网络下持续 fetch failed
 *（已知 push2.eastmoney.com 的 clist 路径不可用，ulist.np 与 push2his 则正常），
 * 因此全市场列表改用新浪。
 *
 * 返回字段中 mktcap / nmc 单位为「万元」，per 为市盈率，pb 为市净率，
 * turnoverratio 为换手率（%）。字段值为字符串，需转换。
 */

const REF = 'https://finance.sina.com.cn/';
const API = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/';

const NODES = {
  hs_a: '沪深A股',
  sh_a: '沪市A股',
  sz_a: '深市A股',
  cyb: '创业板',
  kcb: '科创板',
  hs_bjs: '北交所'
};

const SORT_FIELDS = ['changepercent', 'amount', 'volume', 'turnoverratio', 'per', 'pb', 'mktcap', 'nmc', 'trade', 'pricechange'];

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapRow(r) {
  return {
    code: r.code,
    symbol: r.symbol,
    name: r.name,
    price: toNum(r.trade),
    change: toNum(r.pricechange),
    changePct: toNum(r.changepercent),
    open: toNum(r.open),
    high: toNum(r.high),
    low: toNum(r.low),
    prevClose: toNum(r.settlement),
    volumeShares: toNum(r.volume),
    amountYuan: toNum(r.amount),
    pe: toNum(r.per),
    pb: toNum(r.pb),
    marketCapYi: r.mktcap ? Number((Number(r.mktcap) / 10000).toFixed(2)) : null,
    floatCapYi: r.nmc ? Number((Number(r.nmc) / 10000).toFixed(2)) : null,
    turnoverRate: toNum(r.turnoverratio),
    tickTime: r.ticktime || ''
  };
}

async function fetchNodeCount(node) {
  return cached('screener:count:' + node, 3600000, async () => {
    const text = await fetchText(API + 'Market_Center.getHQNodeStockCount?node=' + node, { referer: REF });
    const n = Number(String(text).replace(/[^\d]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  });
}

/** 取某个节点的行情列表（单页）。 */
async function fetchNodePage(node, page = 1, num = 60, sort = 'changepercent', asc = 0) {
  const key = ['screener:page', node, page, num, sort, asc].join(':');
  return cached(key, 120000, async () => {
    const url = API + 'Market_Center.getHQNodeData?page=' + page + '&num=' + num +
      '&sort=' + sort + '&asc=' + asc + '&node=' + node + '&symbol=';
    const text = await fetchText(url, { referer: REF });
    let rows;
    try {
      rows = JSON.parse(text);
    } catch (err) {
      throw new Error('新浪选股数据解析失败: ' + String(text).slice(0, 80));
    }
    if (!Array.isArray(rows)) return [];
    return rows.map(mapRow);
  });
}

const PRESETS = {
  momentum: {
    label: '强势动量',
    describe: '涨幅居前且换手活跃、市值中等，剔除涨停板与ST',
    query: { sort: 'changepercent', asc: 0, pages: 3, minChangePct: 3, maxChangePct: 9.7, minTurnover: 3, maxTurnover: 20, minMarketCapYi: 20, maxMarketCapYi: 800, minPe: 0, excludeSt: true }
  },
  oversold: {
    label: '超跌观察',
    describe: '跌幅居前但市净率不高，用于观察超跌反弹标的（左侧交易风险高）',
    query: { sort: 'changepercent', asc: 1, pages: 3, minChangePct: -9.5, maxChangePct: -4, minPe: 0, maxPb: 4, excludeSt: true }
  },
  value: {
    label: '低估值',
    // 注意：不能按 PE 升序取数——负 PE（亏损股）会占据前若干页，
    // 过滤后为空。改用 PB 升序，PB 很少为负，更能稳定落到低估值区间。
    describe: '市净率由低到高，PE 0-20、PB 小于 2 且市值大于 100 亿',
    query: { sort: 'pb', asc: 1, pages: 3, minPe: 0.1, maxPe: 20, minPb: 0.05, maxPb: 2, minMarketCapYi: 100, excludeSt: true }
  },
  active: {
    label: '高换手活跃',
    describe: '换手率居前，成交活跃的中小市值标的',
    query: { sort: 'turnoverratio', asc: 0, pages: 3, minTurnover: 5, maxTurnover: 25, minMarketCapYi: 20, maxMarketCapYi: 500, excludeSt: true }
  },
  turnoverTop: {
    label: '成交额榜',
    describe: '成交额居前且当日上涨，反映资金聚集方向',
    query: { sort: 'amount', asc: 0, pages: 2, minChangePct: 0, excludeSt: true }
  },
  blueChip: {
    label: '权重蓝筹',
    describe: '市值居前，PE 0-30、PB 小于 4，波动相对温和',
    query: { sort: 'mktcap', asc: 0, pages: 2, minPe: 0, maxPe: 30, maxPb: 4, minMarketCapYi: 300, excludeSt: true }
  }
};

function applyFilters(rows, q) {
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const minPrice = num(q.minPrice), maxPrice = num(q.maxPrice);
  const minChange = num(q.minChangePct), maxChange = num(q.maxChangePct);
  const minPe = num(q.minPe), maxPe = num(q.maxPe);
  const minPb = num(q.minPb), maxPb = num(q.maxPb);
  const minCap = num(q.minMarketCapYi), maxCap = num(q.maxMarketCapYi);
  const minTurn = num(q.minTurnover), maxTurn = num(q.maxTurnover);
  const minAmt = num(q.minAmountYi);
  const keyword = q.nameKeyword ? String(q.nameKeyword).trim() : '';

  return rows.filter((r) => {
    if (r.price === null) return false;
    if (q.excludeSt !== false && /ST|退/.test(r.name)) return false;
    if (minPrice !== null && r.price < minPrice) return false;
    if (maxPrice !== null && r.price > maxPrice) return false;
    if (minChange !== null && (r.changePct === null || r.changePct < minChange)) return false;
    if (maxChange !== null && (r.changePct === null || r.changePct > maxChange)) return false;
    if (minPe !== null && (r.pe === null || r.pe < minPe)) return false;
    if (maxPe !== null && (r.pe === null || r.pe > maxPe)) return false;
    if (minPb !== null && (r.pb === null || r.pb < minPb)) return false;
    if (maxPb !== null && (r.pb === null || r.pb > maxPb)) return false;
    if (minCap !== null && (r.marketCapYi === null || r.marketCapYi < minCap)) return false;
    if (maxCap !== null && (r.marketCapYi === null || r.marketCapYi > maxCap)) return false;
    if (minTurn !== null && (r.turnoverRate === null || r.turnoverRate < minTurn)) return false;
    if (maxTurn !== null && (r.turnoverRate === null || r.turnoverRate > maxTurn)) return false;
    if (minAmt !== null && (r.amountYuan === null || r.amountYuan < minAmt * 1e8)) return false;
    if (keyword && !r.name.includes(keyword) && !r.code.startsWith(keyword)) return false;
    return true;
  });
}

/**
 * 运行选股。
 * @param {object} q 查询：preset / node / sort / asc / pages / 各类过滤条件 / limit
 */
async function screen(q = {}) {
  const preset = q.preset && PRESETS[q.preset] ? PRESETS[q.preset] : null;
  const merged = { ...(preset ? preset.query : {}), ...q };
  const node = NODES[merged.node] ? merged.node : 'hs_a';
  const sort = SORT_FIELDS.includes(merged.sort) ? merged.sort : 'changepercent';
  const asc = String(merged.asc) === '1' || merged.asc === 1 ? 1 : 0;
  const pages = Math.max(1, Math.min(6, Number(merged.pages) || 2));
  const limit = Math.max(1, Math.min(200, Number(merged.limit) || 50));

  const pageList = [];
  for (let p = 1; p <= pages; p += 1) pageList.push(await fetchNodePage(node, p, 60, sort, asc));
  const rows = pageList.flat();

  const filtered = applyFilters(rows, merged)
    .sort((a, b) => {
      const av = a[sort === 'mktcap' ? 'marketCapYi' : sort === 'nmc' ? 'floatCapYi' : sort === 'trade' ? 'price' : sort] ?? -Infinity;
      const bv = b[sort === 'mktcap' ? 'marketCapYi' : sort === 'nmc' ? 'floatCapYi' : sort === 'trade' ? 'price' : sort] ?? -Infinity;
      return asc === 1 ? av - bv : bv - av;
    })
    .slice(0, limit);

  return {
    updatedAt: new Date().toISOString(),
    node,
    nodeLabel: NODES[node],
    source: '新浪财经 Market_Center（全市场行情节点）',
    preset: preset ? { id: q.preset, label: preset.label, describe: preset.describe } : null,
    scanned: rows.length,
    matched: filtered.length,
    results: filtered
  };
}

module.exports = { screen, PRESETS, NODES, SORT_FIELDS, fetchNodePage, fetchNodeCount };
