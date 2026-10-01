'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 煤炭进口数据。
 *
 * 数据来源现状：
 *  - 海关总署统计页面（customs.gov.cn）本机返回 412，国家统计局数据接口返回 403，
 *    均无法匿名取数；
 *  - 东方财富数据中心接口可用（datacenter-web.eastmoney.com/api/data/v1/get），
 *    但仅验证到「海关进出口总额」报表（RPT_ECONOMY_CUSTOMS），
 *    未找到可用的「煤及褐煤分项进口量」报表；
 *  - 因此与港口库存一致，采用「CSV 月度台账 + 新闻正文数值抽取」两条腿。
 *    随包示例行的 source 为「示例数据」，不是真实海关数据。
 */

const CSV_PATH = path.join(__dirname, '..', 'data', 'coal_import.csv');
const CSV_HEADER = 'period,variety,value_10kt,yoy_pct,amount_usd,source';

const VARIETIES = ['煤及褐煤', '动力煤', '炼焦煤', '无烟煤'];

function parseCsv(text) {
  const lines = String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const rows = [];
  for (const line of lines) {
    const c = line.split(',').map((x) => x.trim());
    if (c[0] === 'period') continue;
    if (c.length < 3) continue;
    const value = Number(c[2]);
    if (!/^\d{4}-\d{2}$/.test(c[0]) || !Number.isFinite(value)) continue;
    rows.push({
      period: c[0],
      variety: c[1] || '煤及褐煤',
      value10kt: value,
      yoyPct: Number.isFinite(Number(c[3])) ? Number(c[3]) : null,
      amountUsd: Number.isFinite(Number(c[4])) && c[4] !== '' ? Number(c[4]) : null,
      source: c[5] || 'manual'
    });
  }
  return rows;
}

function serializeCsv(rows) {
  return CSV_HEADER + '\n' + rows
    .map((r) => [r.period, r.variety, r.value10kt, r.yoyPct === null ? '' : r.yoyPct, r.amountUsd === null ? '' : r.amountUsd, r.source].join(','))
    .join('\n') + '\n';
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

function importCsv(text, sourceLabel = 'imported') {
  const incoming = parseCsv(text);
  if (!incoming.length) return { added: 0, replaced: 0, total: readRows().length, message: 'CSV 中没有可识别的有效数据行（period 需为 YYYY-MM）' };
  const rows = readRows();
  const index = new Map(rows.map((r) => [r.period + '|' + r.variety, r]));
  let added = 0;
  let replaced = 0;
  for (const row of incoming) {
    const key = row.period + '|' + row.variety;
    const normalized = { ...row, source: row.source === 'manual' ? sourceLabel : row.source };
    if (index.has(key)) { Object.assign(index.get(key), normalized); replaced += 1; }
    else { index.set(key, normalized); rows.push(normalized); added += 1; }
  }
  rows.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : a.variety.localeCompare(b.variety)));
  writeRows(rows);
  return { added, replaced, total: rows.length, message: '导入完成' };
}

/** 构造月度进口序列（按品种分组）。 */
function buildSeries(rows = readRows()) {
  const varieties = Array.from(new Set(rows.map((r) => r.variety)));
  const groups = varieties.map((v) => {
    const points = rows
      .filter((r) => r.variety === v)
      .sort((a, b) => (a.period < b.period ? -1 : 1))
      .map((r) => ({ period: r.period, label: r.period.slice(2).replace('-', '/'), value: r.value10kt, yoyPct: r.yoyPct, source: r.source }));
    const latest = points[points.length - 1] || null;
    const prev = points[points.length - 2] || null;
    const sameMonthLastYear = points.find((p) => p.period === (latest ? String(Number(latest.period.slice(0, 4)) - 1) + latest.period.slice(4) : '')) || null;
    return {
      variety: v,
      latest,
      prev,
      momPct: latest && prev && prev.value ? Number((((latest.value - prev.value) / prev.value) * 100).toFixed(1)) : null,
      yoyComputed: latest && sameMonthLastYear && sameMonthLastYear.value
        ? Number((((latest.value - sameMonthLastYear.value) / sameMonthLastYear.value) * 100).toFixed(1)) : null,
      points
    };
  });
  const sources = Array.from(new Set(rows.map((r) => r.source)));
  const containsSampleData = sources.some((s) => /示例|sample|demo/i.test(s));
  return {
    csvPath: CSV_PATH,
    rowCount: rows.length,
    groups,
    varieties,
    provenance: {
      sources,
      containsSampleData,
      disclaimer: containsSampleData
        ? '月度进口数据中含「示例数据」行，仅用于验证图表渲染，请勿据此判断真实进口量。'
        : '数据来自 CSV 台账或新闻抽取，请与海关总署发布口径核对后使用。'
    }
  };
}

/**
 * 从新闻正文抽取进口量读数。
 *
 * 实测中文财经报道的两种常见语序（此前只覆盖了第一种，导致漏抽）：
 *   A) 「8月中国炼焦煤进口量为1345.6万吨」   —— 品种在前、进口在后
 *   B) 「海关数据显示，8月份，我国进口煤炭4209万吨，同比下降1.5%」 —— 进口在前、品种在后
 * B 类才是主流写法，例如「年内大涨47％！动力煤再度逼近千吨」一文中的真实读数。
 *
 * 单位统一折算为万吨（亿吨 × 10000）。
 * 合理性校验：全国月度煤及褐煤进口量在 500-7000 万吨区间，
 * 炼焦煤在 100-2000 万吨区间，超出范围的不采信（避免把乙二醇、原油等误当煤炭）。
 */

const VARIETY_ALT = '煤及褐煤|炼焦煤|动力煤|无烟煤|焦煤|煤炭';

const RANGE = {
  '煤及褐煤': [400, 8000],
  '煤炭': [400, 8000],
  '炼焦煤': [50, 2500],
  '焦煤': [50, 2500],
  '动力煤': [20, 4000],
  '无烟煤': [10, 1500]
};

function normalizeVariety(name) {
  if (name === '煤炭') return '煤及褐煤';
  if (name === '焦煤') return '炼焦煤';
  return name;
}

function toWan(value, unit) {
  const n = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return unit === '亿吨' ? Number((n * 10000).toFixed(1)) : n;
}

function inRange(variety, wan) {
  const r = RANGE[variety];
  if (!r) return true;
  return wan >= r[0] && wan <= r[1];
}

function extractFromNews(items) {
  const importPoints = [];
  const yoyNotes = [];

  // A) 品种在前：「…炼焦煤进口…1345.6万吨」
  const reA = new RegExp('(\\d{1,2})月[^。；;]{0,20}?(' + VARIETY_ALT + ')[^。；;]{0,12}?进口[^。；;]{0,14}?([\\d,]+(?:\\.\\d+)?)\\s*(万吨|亿吨)', 'g');
  // B) 进口在前：「…进口煤炭4209万吨」
  const reB = new RegExp('(\\d{1,2})月份?[^。；;]{0,34}?进口\\s*(?:量|额为|为|达)?\\s*(' + VARIETY_ALT + ')[^。；;]{0,14}?([\\d,]+(?:\\.\\d+)?)\\s*(万吨|亿吨)', 'g');
  // C) 无月份但明确写「进口煤炭 XXXX 万吨」
  const reC = new RegExp('进口\\s*(' + VARIETY_ALT + ')[^。；;]{0,12}?([\\d,]+(?:\\.\\d+)?)\\s*(万吨|亿吨)', 'g');
  // 同比紧跟其后
  const reYoy = /同比\s*(增长|下降|减少|增加|回落|提高)\s*([\d.]+)\s*%|较去年同期\s*(增长|下降)\s*([\d.]+)\s*%/;

  for (const item of items || []) {
    const blob = [item.title, item.summary].filter(Boolean).join('。');
    if (!blob || blob.indexOf('进口') < 0) continue;
    const date = item.timestamp ? new Date(item.timestamp).toISOString().slice(0, 10) : null;
    if (!date) continue;
    const year = Number(date.slice(0, 4));

    const push = (month, varietyRaw, valueRaw, unit, evidence, offset) => {
      const variety = normalizeVariety(varietyRaw);
      const wan = toWan(valueRaw, unit);
      if (wan === null) return;
      if (!inRange(variety, wan)) return;
      // 月度进口数据常在次月发布：「1月报道里出现12月数据」应归到上一年。
      const articleMonth = Number(date.slice(5, 7));
      const useYear = month && month > articleMonth ? year - 1 : year;
      const period = (month ? useYear + '-' + String(month).padStart(2, '0') : date.slice(0, 7));
      // 在命中位置附近找同比
      const tail = blob.slice(offset, offset + 80);
      const ym = reYoy.exec(tail);
      const yoy = ym ? Number(ym[2] || ym[4]) * (/下降|减少|回落/.test(ym[1] || ym[3] || '') ? -1 : 1) : null;
      importPoints.push({
        period, variety, value10kt: wan, unit: '万吨', yoyPct: yoy,
        source: 'news-extracted', evidence: evidence.trim(),
        title: item.title, url: item.url, date
      });
    };

    let m;
    reA.lastIndex = 0;
    while ((m = reA.exec(blob)) !== null) push(Number(m[1]), m[2], m[3], m[4], m[0], m.index);
    reB.lastIndex = 0;
    while ((m = reB.exec(blob)) !== null) push(Number(m[1]), m[2], m[3], m[4], m[0], m.index);
    reC.lastIndex = 0;
    while ((m = reC.exec(blob)) !== null) {
      // 无月份分支：只有在上文 40 字内确实出现过「N月」时才采信。
      // 否则 period 只能取文章发布月，会把「8月数据」误记成「9月」，宁缺毋滥直接跳过。
      const before = blob.slice(Math.max(0, m.index - 40), m.index);
      const mm = before.match(/(\d{1,2})\s*月/);
      if (!mm) continue;
      push(Number(mm[1]), m[1], m[2], m[3], m[0], m.index);
    }

    const allYoy = blob.match(/同比\s*(?:增长|下降|减少|增加|回落|提高)\s*[\d.]+\s*%/g) || [];
    for (const t of allYoy) {
      if (/煤炭|煤及褐煤|炼焦煤|焦煤/.test(blob)) {
        yoyNotes.push({ date, text: t, title: item.title, url: item.url });
      }
    }
  }

  const dedupe = (arr, keyOf) => {
    const map = new Map();
    for (const r of arr) if (!map.has(keyOf(r))) map.set(keyOf(r), r);
    return Array.from(map.values());
  };

  return {
    importPoints: dedupe(importPoints, (r) => r.period + '|' + r.variety).sort((a, b) => (a.period < b.period ? -1 : 1)),
    yoyNotes: dedupe(yoyNotes, (r) => r.date + '|' + r.text).slice(0, 20),
    scanned: (items || []).length
  };
}

module.exports = { CSV_PATH, CSV_HEADER, VARIETIES, parseCsv, readRows, writeRows, importCsv, buildSeries, extractFromNews };
