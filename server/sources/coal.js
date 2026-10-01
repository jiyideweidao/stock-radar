'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 煤炭港口库存 / 动力煤价格模块。
 *
 * 数据来源现状（重要，务必如实告知使用者）：
 *  - CCTD 中国煤炭市场网、秦皇岛煤炭网（环渤海动力煤价格指数）等权威口径的
 *    港口库存明细表为付费/登录数据，无法匿名稳定抓取；
 *  - 因此本模块以「CSV 数据台账 + 新闻正文数值抽取」两条腿走路：
 *      1) server/data/coal_inventory.csv —— 唯一数据源，可手工维护或由 POST 导入；
 *      2) 从新闻文本中抽取「秦皇岛港库存 xxx 万吨」「动力煤 xxx 元/吨」等读数，
 *         作为半自动增量（标注为 news-extracted，需人工复核）。
 *  - 随包附带的数据行 source 字段为「示例数据」，不是真实行情，仅用于演示图表。
 */

const CSV_PATH = path.join(__dirname, '..', 'data', 'coal_inventory.csv');
const CSV_HEADER = 'date,port,metric,value,unit,source';

const KNOWN_PORTS = ['秦皇岛港', '曹妃甸港', '京唐港', '黄骅港', '广州港', '北方九港'];

function parseCsv(text) {
  const lines = String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const rows = [];
  for (const line of lines) {
    const cells = line.split(',').map((c) => c.trim());
    if (cells[0] === 'date') continue; // 表头
    if (cells.length < 5) continue;
    const value = Number(cells[3]);
    if (!cells[0] || !Number.isFinite(value)) continue;
    rows.push({
      date: cells[0],
      port: cells[1],
      metric: cells[2],
      value: value,
      unit: cells[4] || '',
      source: cells[5] || 'manual'
    });
  }
  return rows;
}

function serializeCsv(rows) {
  const body = rows
    .map((r) => [r.date, r.port, r.metric, r.value, r.unit, r.source].join(','))
    .join('\n');
  return CSV_HEADER + '\n' + body + '\n';
}

function readRows() {
  try {
    return parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
}

function writeRows(rows) {
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
  fs.writeFileSync(CSV_PATH, serializeCsv(rows), 'utf8');
}

/** 追加导入（同 date+port+metric 视为覆盖，避免重复点入库）。 */
function importCsv(text, sourceLabel = 'imported') {
  const incoming = parseCsv(text);
  if (!incoming.length) {
    return { added: 0, replaced: 0, total: readRows().length, message: 'CSV 中没有可识别的有效数据行' };
  }
  const rows = readRows();
  const index = new Map(rows.map((r) => [r.date + '|' + r.port + '|' + r.metric, r]));
  let added = 0;
  let replaced = 0;
  for (const row of incoming) {
    const key = row.date + '|' + row.port + '|' + row.metric;
    const normalized = { ...row, source: row.source === 'manual' ? sourceLabel : row.source };
    if (index.has(key)) {
      Object.assign(index.get(key), normalized);
      replaced += 1;
    } else {
      const created = normalized;
      index.set(key, created);
      rows.push(created);
      added += 1;
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.port.localeCompare(b.port)));
  writeRows(rows);
  return { added: added, replaced: replaced, total: rows.length, message: '导入完成' };
}

/** 组装图表数据：各港口库存柱状图 + 合计趋势 + 动力煤价格序列。 */
function buildSeries(rows = readRows()) {
  const inventory = rows.filter((r) => r.metric === '库存');
  const prices = rows.filter((r) => r.metric === '价格');

  const dates = Array.from(new Set(inventory.map((r) => r.date))).sort();
  const ports = Array.from(new Set(inventory.map((r) => r.port)));

  const byPort = ports.map((port) => {
    const points = inventory
      .filter((r) => r.port === port)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((r) => ({ date: r.date, value: r.value, source: r.source }));
    const latest = points[points.length - 1] || null;
    const prev = points[points.length - 2] || null;
    return {
      port: port,
      latest: latest,
      prev: prev,
      delta: latest && prev ? Number((latest.value - prev.value).toFixed(2)) : null,
      deltaPct: latest && prev && prev.value ? Number((((latest.value - prev.value) / prev.value) * 100).toFixed(2)) : null,
      points: points
    };
  });

  const totals = dates.map((date) => {
    const sum = inventory.filter((r) => r.date === date).reduce((acc, r) => acc + r.value, 0);
    return { date: date, value: Number(sum.toFixed(2)) };
  });

  const priceSeries = prices
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((r) => ({ date: r.date, value: r.value, source: r.source }));

  const sources = Array.from(new Set(rows.map((r) => r.source)));
  const containsSample = sources.some((s) => /示例|sample|demo/i.test(s));

  return {
    csvPath: CSV_PATH,
    rowCount: rows.length,
    dates: dates,
    ports: byPort,
    totals: totals,
    priceSeries: priceSeries,
    latestPrice: priceSeries[priceSeries.length - 1] || null,
    provenance: {
      sources: sources,
      containsSampleData: containsSample,
      disclaimer: containsSample
        ? '数据中混有「示例数据」，仅用于验证图表渲染，请勿据此判断真实煤价与库存。'
        : '数据来自 CSV 台账或新闻抽取，请核对后再使用。'
    }
  };
}

const PORT_PATTERN = '(秦皇岛港?|曹妃甸港?|京唐港?|黄骅港?|北方九港|环渤海港口?|广州港)';
const INVENTORY_RE = new RegExp(
  PORT_PATTERN + '[^。；;，,]{0,24}?库存[^。；;]{0,28}?([0-9]+(?:\\.[0-9]+)?)\\s*万吨',
  'g'
);
const INVENTORY_RE2 = new RegExp(
  '库存[^。；;]{0,28}?([0-9]+(?:\\.[0-9]+)?)\\s*万吨[^。；;]{0,24}?' + PORT_PATTERN,
  'g'
);
const PRICE_RE = /(?:动力煤|5500\s*大卡|5500K|现货煤价?)[^。；;]{0,26}?([1-9][0-9]{2,3}(?:\.[0-9]+)?)\s*元/;
const PRICE_RE2 = /([1-9][0-9]{2,3}(?:\.[0-9]+)?)\s*元\/吨[^。；;]{0,20}?(?:动力煤|5500\s*大卡)/;

function normalizePort(name) {
  if (!name) return null;
  if (name.includes('秦皇岛')) return '秦皇岛港';
  if (name.includes('曹妃甸')) return '曹妃甸港';
  if (name.includes('京唐')) return '京唐港';
  if (name.includes('黄骅')) return '黄骅港';
  if (name.includes('广州港')) return '广州港';
  if (name.includes('九港') || name.includes('环渤海')) return '北方九港';
  return name;
}

function extractFromNews(items) {
  const inventoryPoints = [];
  const pricePoints = [];
  const mentions = [];

  for (const item of items || []) {
    const blob = [item.title, item.summary].filter(Boolean).join('。');
    if (!blob) continue;
    const date = item.timestamp ? new Date(item.timestamp).toISOString().slice(0, 10) : null;
    if (!date) continue;

    INVENTORY_RE.lastIndex = 0;
    let m;
    while ((m = INVENTORY_RE.exec(blob)) !== null) {
      const port = normalizePort(m[1]);
      const value = Number(m[2]);
      if (!port || !Number.isFinite(value)) continue;
      inventoryPoints.push({ date: date, port: port, metric: '库存', value: value, unit: '万吨', source: 'news-extracted', evidence: m[0], url: item.url, title: item.title });
    }
    INVENTORY_RE2.lastIndex = 0;
    while ((m = INVENTORY_RE2.exec(blob)) !== null) {
      const port = normalizePort(m[2]);
      const value = Number(m[1]);
      if (!port || !Number.isFinite(value)) continue;
      inventoryPoints.push({ date: date, port: port, metric: '库存', value: value, unit: '万吨', source: 'news-extracted', evidence: m[0], url: item.url, title: item.title });
    }

    const pm = PRICE_RE.exec(blob) || PRICE_RE2.exec(blob);
    if (pm) {
      const value = Number(pm[1]);
      if (Number.isFinite(value) && value >= 200 && value <= 2000) {
        pricePoints.push({ date: date, port: '动力煤5500K', metric: '价格', value: value, unit: '元/吨', source: 'news-extracted', evidence: pm[0], url: item.url, title: item.title });
      }
    }

    if (inventoryPoints.length || pricePoints.length) {
      mentions.push({ title: item.title, url: item.url, date: date, source: item.source });
    }
  }

  const dedupe = (arr, keyOf) => {
    const map = new Map();
    for (const row of arr) map.set(keyOf(row), row);
    return Array.from(map.values());
  };

  return {
    inventoryPoints: dedupe(inventoryPoints, (r) => r.date + '|' + r.port),
    pricePoints: dedupe(pricePoints, (r) => r.date),
    mentions: mentions.slice(0, 30)
  };
}

module.exports = {
  CSV_PATH,
  CSV_HEADER,
  KNOWN_PORTS,
  parseCsv,
  readRows,
  writeRows,
  importCsv,
  buildSeries,
  extractFromNews
};
