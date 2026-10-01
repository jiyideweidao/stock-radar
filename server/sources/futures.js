'use strict';

const { fetchText, fetchJson } = require('../lib/http');
const { cached } = require('../lib/cache');

/**
 * 期货「连续合约」行情。
 * 数据源：新浪财经 hq.sinajs.cn（GBK 文本）与新浪期货日线接口。
 * 说明：国内主力连续合约，不含夜盘细节；动力煤 ZC 因活跃度极低常返回空值。
 */
const COMMODITIES = [
  { symbol: 'CF0', name: '郑棉主连', group: '棉花 / 农产品', unit: '元/吨', highlight: true },
  { symbol: 'CY0', name: '棉纱主连', group: '棉花 / 农产品', unit: '元/吨' },
  { symbol: 'JM0', name: '焦煤主连', group: '煤炭 / 黑色系', unit: '元/吨', highlight: true },
  { symbol: 'J0', name: '焦炭主连', group: '煤炭 / 黑色系', unit: '元/吨', highlight: true },
  { symbol: 'ZC0', name: '动力煤主连', group: '煤炭 / 黑色系', unit: '元/吨', highlight: true },
  { symbol: 'RB0', name: '螺纹钢主连', group: '黑色系', unit: '元/吨' },
  { symbol: 'I0', name: '铁矿石主连', group: '黑色系', unit: '元/吨' },
  { symbol: 'FG0', name: '玻璃主连', group: '建材', unit: '元/吨' },
  { symbol: 'SA0', name: '纯碱主连', group: '建材', unit: '元/吨' },
  { symbol: 'CU0', name: '沪铜主连', group: '有色金属', unit: '元/吨' },
  { symbol: 'AL0', name: '沪铝主连', group: '有色金属', unit: '元/吨' },
  { symbol: 'AU0', name: '沪金主连', group: '贵金属', unit: '元/克' },
  { symbol: 'SC0', name: '原油主连', group: '能源', unit: '元/桶' },
  { symbol: 'M0', name: '豆粕主连', group: '农产品', unit: '元/吨' },
  { symbol: 'SR0', name: '白糖主连', group: '农产品', unit: '元/吨' },
  { symbol: 'RU0', name: '橡胶主连', group: '农产品', unit: '元/吨' },
  { symbol: 'TA0', name: 'PTA主连', group: '化工', unit: '元/吨' },
  { symbol: 'MA0', name: '甲醇主连', group: '化工', unit: '元/吨' }
];

const SINA_REF = 'https://finance.sina.com.cn';

/**
 * 新浪 nf_ 字段位（0 基）：0 名称 1 时间 2 开盘 3 最高 4 最低 5 收盘
 * 6 买价 7 卖价 8 最新价 9 今结算 10 昨收 11 买量 12 卖量 13 持仓量 14 成交量
 * 15 交易所 16 品种 17 日期
 */
function parseSinaFutures(text) {
  const out = [];
  const re = /var\s+hq_str_nf_([A-Za-z0-9]+)="([^"]*)";/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const symbol = m[1];
    const raw = m[2];
    if (!raw) {
      out.push({ symbol: symbol, available: false, note: '该合约当前无行情（可能停牌或已不活跃）' });
      continue;
    }
    const f = raw.split(',');
    const num = (i) => {
      const v = Number(f[i]);
      return Number.isFinite(v) ? v : null;
    };
    const last = num(8);
    const prevClose = num(10);
    const change = last !== null && prevClose !== null ? Number((last - prevClose).toFixed(2)) : null;
    const changePct =
      change !== null && prevClose ? Number(((change / prevClose) * 100).toFixed(2)) : null;
    out.push({
      symbol: symbol,
      available: true,
      name: f[0],
      variety: f[16],
      exchange: f[15],
      date: f[17],
      open: num(2),
      high: num(3),
      low: num(4),
      last: last,
      settle: num(9),
      prevClose: prevClose,
      change: change,
      changePct: changePct,
      openInterest: num(13),
      volume: num(14)
    });
  }
  return out;
}

async function getFuturesRealtime(ttlMs = 30000) {
  return cached('futures:realtime', ttlMs, async () => {
    const url = 'https://hq.sinajs.cn/list=' + COMMODITIES.map((c) => 'nf_' + c.symbol).join(',');
    const text = await fetchText(url, { referer: SINA_REF, encoding: 'gbk' });
    const parsed = parseSinaFutures(text);
    return COMMODITIES.map((meta) => {
      const hit = parsed.find((p) => p.symbol === meta.symbol);
      return { ...meta, ...(hit || { available: false, note: '未返回数据' }) };
    });
  });
}

/** 期货日线历史（新浪 InnerFuturesNewService），默认取最近 limit 根。 */
async function getFuturesDaily(symbol, limit = 120) {
  return cached('futures:daily:' + symbol + ':' + limit, 600000, async () => {
    const url =
      'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_' + symbol +
      '=/InnerFuturesNewService.getDailyKLine?symbol=' + symbol;
    const json = await fetchJson(url, { referer: SINA_REF });
    const rows = Array.isArray(json) ? json : [];
    const mapped = rows.map((r) => ({
      date: r.d,
      open: Number(r.o),
      high: Number(r.h),
      low: Number(r.l),
      close: Number(r.c),
      volume: Number(r.v),
      openInterest: Number(r.p)
    }));
    return mapped.slice(-limit);
  });
}

module.exports = { COMMODITIES, getFuturesRealtime, getFuturesDaily, parseSinaFutures };
