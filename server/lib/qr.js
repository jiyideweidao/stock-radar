'use strict';

/**
 * 极简 QR 码生成器 —— 只为实现「手机扫码打开工作站」。
 *
 * 为什么自己写：这个工作站是零运行时依赖的，不想为了一个二维码去引 npm 包。
 * 只实现真正用得到的部分：字节模式、纠错等级 M/L、版本 1–10（最大 271 字节），
 * 放 "http://192.168.0.101:8787/?app=1" 这种局域网地址绰绰有余。
 *
 * 输出 SVG：任意放大都不糊，体积只有几百字节，前端直接 innerHTML 塞进去就能显示。
 */

/* --------------------------- GF(256) 与 Reed-Solomon --------------------------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }

/** n 次 RS 生成多项式，最高次项在前，首项恒为 1。 */
function rsGen(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** 给定数据码字，算出 ecLen 个纠错码字。 */
function rsEncode(data, ecLen) {
  const gen = rsGen(ecLen);
  const res = new Array(ecLen).fill(0);
  for (let k = 0; k < data.length; k++) {
    const factor = data[k] ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

/* ------------------------------- 版本容量表 ------------------------------- */

// [每块纠错码字, 第1组块数, 第1组数据码字, 第2组块数, 第2组数据码字]，下标 = 版本号
const RS_BLOCKS = {
  L: [
    null,
    [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69]
  ],
  M: [
    null,
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]
  ]
};

// 校正图形中心坐标（版本 1 没有校正图形）
const ALIGN = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
];

const MAX_VERSION = 10;
const EC_FORMAT_BITS = { L: 1, M: 0 };   // 格式信息里纠错等级的 2 bit 编码

function dataCodewordCount(v, level) {
  const b = RS_BLOCKS[level][v];
  return b[1] * b[2] + b[3] * b[4];
}
function byteCapacity(v, level) {
  const headerBits = 4 + (v <= 9 ? 8 : 16);
  return Math.floor((dataCodewordCount(v, level) * 8 - headerBits) / 8);
}

/* ------------------------------- 数据编码 ------------------------------- */

function buildDataCodewords(bytes, v, level) {
  const total = dataCodewordCount(v, level);
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(4, 4);                                   // 模式指示符：0100 = 字节模式
  push(bytes.length, v <= 9 ? 8 : 16);          // 字符计数
  for (const b of bytes) push(b, 8);
  const cap = total * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);   // 结束符
  while (bits.length % 8 !== 0) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | bits[i + j];
    out.push(val);
  }
  const PAD = [0xec, 0x11];
  let p = 0;
  while (out.length < total) out.push(PAD[p++ % 2]);
  return out;
}

/** 按版本分块、逐块算纠错，再按规范交错排列。 */
function interleave(dataCodewords, v, level) {
  const def = RS_BLOCKS[level][v];
  const ecLen = def[0];
  const blocks = [];
  let pos = 0;
  for (let i = 0; i < def[1]; i++) { const d = dataCodewords.slice(pos, pos + def[2]); pos += def[2]; blocks.push({ d: d, e: rsEncode(d, ecLen) }); }
  for (let i = 0; i < def[3]; i++) { const d = dataCodewords.slice(pos, pos + def[4]); pos += def[4]; blocks.push({ d: d, e: rsEncode(d, ecLen) }); }
  const maxData = Math.max(def[2], def[4]);
  const out = [];
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

/* ------------------------------- 矩阵构建 ------------------------------- */

function blank(n) { const m = []; for (let i = 0; i < n; i++) m.push(new Array(n).fill(null)); return m; }

/** 版本信息：6 位数据 + BCH(18,6)，只有版本 >= 7 才有。 */
function versionBits(v) {
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (v << 12) | rem;
}

/**
 * 按一条掩码构建完整矩阵。格式信息与版本信息的格子先留 0（占位），由调用方最后回填，
 * 这样 8 条掩码的评分口径和规范一致。
 * 顺序完全对照规范：定位图形 -> 定时图形 -> 校正图形 -> 格式/版本区占位 -> 数据位蛇形填充。
 * 用 null 表示「尚未占用」，所以功能图形格天生不会被数据覆盖。
 */
function buildMatrix(v, codewords, mask) {
  const n = v * 4 + 17;
  const m = blank(n);

  // 1) 定位图形 + 分隔带：r/c 从 -1 起，多出来的那一圈就是分隔带
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      if (row + r < 0 || row + r >= n) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c < 0 || col + c >= n) continue;
        const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                   (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                   (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[row + r][col + c] = on ? 1 : 0;
      }
    }
  };
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);

  // 2) 定时图形：黑白相间；已被定位图形占用（非 null）的格子不动
  for (let i = 8; i < n - 8; i++) {
    if (m[i][6] === null) m[i][6] = i % 2 === 0 ? 1 : 0;
    if (m[6][i] === null) m[6][i] = i % 2 === 0 ? 1 : 0;
  }

  // 3) 校正图形：只跳过与定位图形重叠的三个角（按坐标表下标判定，不能按「格子是否已占用」判定，
  //    因为版本 >= 7 时 (6,22)、(22,6) 这类校正图形中心就落在定时图形上，必须照画并覆盖定时图形）
  const centers = ALIGN[v] || [];
  const last = centers.length - 1;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const row = centers[i];
      const col = centers[j];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          m[row + r][col + c] = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) ? 1 : 0;
        }
      }
    }
  }

  // 4a) 格式信息区占位（15 位 x 2 份）
  for (let i = 0; i < 15; i++) {
    if (i < 6) m[i][8] = 0;
    else if (i < 8) m[i + 1][8] = 0;
    else m[n - 15 + i][8] = 0;
  }
  for (let i = 0; i < 15; i++) {
    if (i < 8) m[8][n - 1 - i] = 0;
    else if (i < 9) m[8][15 - i] = 0;
    else m[8][14 - i] = 0;
  }
  m[n - 8][8] = 1;                              // 固定黑块

  // 4b) 版本信息区（18 位 x 2 份，版本 >= 7 才有；与掩码无关，直接写真值）
  if (v >= 7) {
    const vbits = versionBits(v);
    for (let i = 0; i < 18; i++) {
      const b = (vbits >> i) & 1;
      m[Math.floor(i / 3)][(i % 3) + n - 11] = b;
      m[(i % 3) + n - 11][Math.floor(i / 3)] = b;
    }
  }

  // 5) 数据位：自右下角起两列一组上下蛇形；只有 null 的格子才填，并同步异或掩码
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let idx = 0;
  let inc = -1;
  for (let col = n - 1, row = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;                       // 第 6 列整列是定时图形，跳过
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (m[row][cc] !== null) continue;
        let dark = idx < bits.length ? bits[idx] : 0;
        if (maskAt(mask, row, cc)) dark ^= 1;
        m[row][cc] = dark;
        idx += 1;
      }
      row += inc;
      if (row < 0 || row >= n) { row -= inc; inc = -inc; break; }
    }
  }
  return m;
}

function maskAt(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

/** 格式信息：5 位数据 + BCH(15,5) 纠错，最后异或 0x5412 掩码。 */
function formatBits(level, mask) {
  const data = (EC_FORMAT_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function writeFormat(m, level, mask) {
  const n = m.length;
  const bits = formatBits(level, mask);
  const bit = (i) => (bits >> i) & 1;
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6);
  m[8][8] = bit(7);
  m[8][7] = bit(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) m[8][n - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) m[n - 15 + i][8] = bit(i);
  m[n - 8][8] = 1;                          // 固定黑块
}

/** 版本信息：6 位数据 + BCH(18,6)，只有版本 ≥ 7 才有。 */
function writeVersion(m, v) {
  if (v < 7) return;
  const n = m.length;
  let rem = v;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (v << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const b = (bits >> i) & 1;
    const a = n - 11 + (i % 3);
    const y = Math.floor(i / 3);
    m[y][a] = b;
    m[a][y] = b;
  }
}

/** 规范里的 4 条掩码惩罚规则，取分数最低的掩码。 */
function penaltyScore(m) {
  const n = m.length;
  let score = 0;
  const runScore = (len) => (len >= 5 ? 3 + (len - 5) : 0);

  for (let y = 0; y < n; y++) {
    let run = 1;
    for (let x = 1; x < n; x++) { if (m[y][x] === m[y][x - 1]) run += 1; else { score += runScore(run); run = 1; } }
    score += runScore(run);
  }
  for (let x = 0; x < n; x++) {
    let run = 1;
    for (let y = 1; y < n; y++) { if (m[y][x] === m[y - 1][x]) run += 1; else { score += runScore(run); run = 1; } }
    score += runScore(run);
  }

  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  }

  const PAT = [1, 0, 1, 1, 1, 0, 1];
  const scan = (get) => {
    for (let i = 0; i + 11 <= n; i++) {
      let head = true;
      for (let k = 0; k < 7; k++) if (get(i + k) !== PAT[k]) { head = false; break; }
      if (head) { let ok = true; for (let k = 0; k < 4; k++) if (get(i + 7 + k) !== 0) { ok = false; break; } if (ok) score += 40; }
      let tail = true;
      for (let k = 0; k < 7; k++) if (get(i + 4 + k) !== PAT[k]) { tail = false; break; }
      if (tail) { let ok = true; for (let k = 0; k < 4; k++) if (get(i + k) !== 0) { ok = false; break; } if (ok) score += 40; }
    }
  };
  for (let y = 0; y < n; y++) scan((i) => m[y][i]);
  for (let x = 0; x < n; x++) scan((i) => m[i][x]);

  // 规则 4：黑模块占比偏离 50% 的程度，每 5% 记 10 分
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) dark += 1;
  const percent = dark * 100 / (n * n);
  score += Math.abs(Math.ceil(percent / 5) - 10) * 10;
  return score;
}

/* ------------------------------- 对外接口 ------------------------------- */

/** 把文本编成 QR 矩阵；返回 null 表示超出容量。 */
function encode(text, level) {
  const bytes = Buffer.from(String(text), 'utf8');
  if (bytes.length === 0) return null;            // 空内容编出来是个扫了也没用的码
  if (bytes.length > byteCapacity(MAX_VERSION, 'L')) return null;
  const levels = level ? [level] : ['M', 'L'];
  for (const lv of levels) {
    for (let v = 1; v <= MAX_VERSION; v++) {
      if (byteCapacity(v, lv) < bytes.length) continue;
      const codewords = interleave(buildDataCodewords(bytes, v, lv), v, lv);
      let best = null;
      for (let mask = 0; mask < 8; mask++) {
        const cand = buildMatrix(v, codewords, mask);
        writeFormat(cand, lv, mask);          // 评分口径与规范一致：格式信息计入惩罚分
        const s = penaltyScore(cand);
        if (!best || s < best.score) best = { score: s, m: cand, mask: mask };
      }
      return { matrix: best.m, version: v, ecLevel: lv, mask: best.mask, size: best.m.length };
    }
  }
  return null;
}

/** 生成 SVG 字符串（quiet=4 个模块的静默区，扫码必须留）。 */
function toSvg(matrix, options) {
  const opts = options || {};
  const quiet = Number.isFinite(opts.quiet) ? opts.quiet : 4;
  const fg = opts.fg || '#000000';
  const bg = opts.bg || '#ffffff';
  const n = matrix.length;
  const side = n + quiet * 2;
  let d = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!matrix[y][x]) { x += 1; continue; }
      let run = 1;
      while (x + run < n && matrix[y][x + run]) run += 1;
      d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h' + run + 'v1h-' + run + 'z';
      x += run;
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + side + ' ' + side +
    '" width="' + side + '" height="' + side + '" shape-rendering="crispEdges" role="img" aria-label="扫码在手机上打开">' +
    '<rect width="' + side + '" height="' + side + '" fill="' + bg + '"/>' +
    '<path d="' + d + '" fill="' + fg + '"/></svg>';
}

/** 给一个网址返回可直接嵌入的二维码信息。 */
function forUrl(url, options) {
  const opts = options || {};
  const encoded = encode(String(url), opts.level);
  if (!encoded) return null;
  return {
    url: String(url),
    svg: toSvg(encoded.matrix, opts),
    size: encoded.size,
    version: encoded.version,
    ecLevel: encoded.ecLevel,
    mask: encoded.mask
  };
}

module.exports = { encode, toSvg, forUrl };

// 仅供自检/比对使用：暴露内部步骤，方便和独立实现逐码字、逐模块对照。
module.exports._internals = {
  buildDataCodewords, interleave, buildMatrix, versionBits,
  dataCodewordCount, byteCapacity, formatBits, RS_BLOCKS, ALIGN
};

