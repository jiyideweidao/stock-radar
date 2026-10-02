'use strict';
/**
 * 自选股的读写。
 *
 * 界面上的「增加 / 删除 / 改标签 / 调顺序」最终都落到 server/data/watchlist.json，
 * 所以这里只做三件事：把用户输入洗干净、限制规模、用「临时文件 + 改名」原子写盘
 * （直接覆盖写的话，进程正好被打断就会留下半个 JSON，自选股会整份读不出来）。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'watchlist.json');
const MAX_STOCKS = 30;
const MAX_TAGS = 8;
const MAX_POINTS = 10;
const MAX_TAG_LEN = 16;
const MAX_POINT_LEN = 60;

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** 6 位数字代码。带 sh/sz 前缀、空格、全角数字都先剥掉非数字字符。 */
function normalizeCode(value) {
  const code = String(value === null || value === undefined ? '' : value).replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) throw fail('股票代码必须是 6 位数字（如 600519）', 400);
  return code;
}

function sanitizeText(value, maxLen) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, maxLen || 60);
}

/** 标签 / 关注要点：数组或「逗号、顿号、换行」分隔的字符串都收，去重、限量、限长。 */
function sanitizeList(value, maxCount, maxLen) {
  const raw = Array.isArray(value)
    ? value
    : String(value === null || value === undefined ? '' : value).split(/[,，、;；\n]/);
  const out = [];
  for (const item of raw) {
    const text = sanitizeText(item, maxLen);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= maxCount) break;
  }
  return out;
}

function load() {
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(data.stocks)) data.stocks = [];
  if (!data.settings) data.settings = {};
  return data;
}

/** 原子写：写同目录的 .tmp 再 rename（同分区 rename 是原子的）。 */
function save(data) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
  return data;
}

/** 新增。name 由调用方先解析好（行情源查不到时用户可以自己填）。 */
function add(payload, resolvedName) {
  const body = payload || {};
  const code = normalizeCode(body.code);
  const data = load();
  if (data.stocks.some((s) => s.code === code)) {
    throw fail('自选股里已经有 ' + code + ' 了', 409);
  }
  if (data.stocks.length >= MAX_STOCKS) {
    throw fail('自选股最多 ' + MAX_STOCKS + ' 只，先删掉几只再添加', 400);
  }
  data.stocks.push({
    code: code,
    name: sanitizeText(resolvedName || body.name, MAX_TAG_LEN) || code,
    tags: sanitizeList(body.tags, MAX_TAGS, MAX_TAG_LEN),
    watchPoints: sanitizeList(body.watchPoints, MAX_POINTS, MAX_POINT_LEN)
  });
  return save(data);
}

function remove(payload) {
  const code = normalizeCode((payload || {}).code);
  const data = load();
  const before = data.stocks.length;
  data.stocks = data.stocks.filter((s) => s.code !== code);
  if (data.stocks.length === before) throw fail('自选股里没有 ' + code, 404);
  return save(data);
}

function update(payload) {
  const body = payload || {};
  const code = normalizeCode(body.code);
  const data = load();
  const item = data.stocks.find((s) => s.code === code);
  if (!item) throw fail('自选股里没有 ' + code, 404);
  if (body.name !== undefined) item.name = sanitizeText(body.name, MAX_TAG_LEN) || item.name;
  if (body.tags !== undefined) item.tags = sanitizeList(body.tags, MAX_TAGS, MAX_TAG_LEN);
  if (body.watchPoints !== undefined) item.watchPoints = sanitizeList(body.watchPoints, MAX_POINTS, MAX_POINT_LEN);
  return save(data);
}

/** 调顺序：delta < 0 上移一位，否则下移一位；已经在头/尾就原样返回，不算错误。 */
function move(payload) {
  const body = payload || {};
  const code = normalizeCode(body.code);
  const delta = Number(body.delta) < 0 ? -1 : 1;
  const data = load();
  const from = data.stocks.findIndex((s) => s.code === code);
  if (from < 0) throw fail('自选股里没有 ' + code, 404);
  const to = from + delta;
  if (to < 0 || to >= data.stocks.length) return data;
  const moved = data.stocks.splice(from, 1)[0];
  data.stocks.splice(to, 0, moved);
  return save(data);
}

module.exports = {
  FILE, MAX_STOCKS, MAX_TAGS, MAX_POINTS,
  load, save, add, remove, update, move,
  normalizeCode, sanitizeText, sanitizeList
};
