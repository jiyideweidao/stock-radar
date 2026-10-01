'use strict';

/**
 * 技术指标计算库（纯函数，无外部依赖，便于离线自检）。
 * 全部指标按「与输入等长数组、起始段以 null 填充」返回，方便前端与 K 线对齐。
 */

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = Number((sum / n).toFixed(4));
  }
  return out;
}

function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    prev = prev === null ? v : v * k + prev * (1 - k);
    out[i] = Number(prev.toFixed(4));
  }
  return out;
}

/** MACD(12,26,9)：返回 DIF、DEA 与柱状值（国内习惯：柱 = (DIF-DEA)*2）。 */
function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) => Number((emaFast[i] - emaSlow[i]).toFixed(4)));
  const dea = ema(dif, signal);
  const hist = dif.map((v, i) => Number(((v - dea[i]) * 2).toFixed(4)));
  return { dif, dea, hist };
}

/** KDJ(9,3,3)：用最高价/最低价通道计算 RSV 后平滑。 */
function kdj(klines, n = 9, m1 = 3, m2 = 3) {
  const k = new Array(klines.length).fill(null);
  const d = new Array(klines.length).fill(null);
  const j = new Array(klines.length).fill(null);
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < klines.length; i += 1) {
    const from = Math.max(0, i - n + 1);
    let hi = -Infinity;
    let lo = Infinity;
    for (let x = from; x <= i; x += 1) {
      if (klines[x].high > hi) hi = klines[x].high;
      if (klines[x].low < lo) lo = klines[x].low;
    }
    const rsv = hi === lo ? 50 : ((klines[i].close - lo) / (hi - lo)) * 100;
    prevK = (m1 - 1) / m1 * prevK + (1 / m1) * rsv;
    prevD = (m2 - 1) / m2 * prevD + (1 / m2) * prevK;
    k[i] = Number(prevK.toFixed(2));
    d[i] = Number(prevD.toFixed(2));
    j[i] = Number((3 * prevK - 2 * prevD).toFixed(2));
  }
  return { k, d, j };
}

/** RSI（Wilder 平滑）。 */
function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);
    if (i <= n) {
      avgGain += gain / n;
      avgLoss += loss / n;
      if (i === n) out[i] = avgLoss === 0 ? 100 : Number((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      out[i] = avgLoss === 0 ? 100 : Number((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
    }
  }
  return out;
}

/** 布林带(20,2)。 */
function boll(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i += 1) {
    const slice = closes.slice(i - n + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
    const sd = Math.sqrt(variance);
    upper[i] = Number((mean + k * sd).toFixed(4));
    lower[i] = Number((mean - k * sd).toFixed(4));
  }
  return { mid, upper, lower };
}

/** 成交量均线。 */
function volumeMA(klines, n = 5) {
  return sma(klines.map((k) => k.volume), n);
}

function crossUp(a, b, i) {
  return i > 0 && a[i - 1] !== null && b[i - 1] !== null && a[i] !== null && b[i] !== null &&
    a[i - 1] <= b[i - 1] && a[i] > b[i];
}

function crossDown(a, b, i) {
  return i > 0 && a[i - 1] !== null && b[i - 1] !== null && a[i] !== null && b[i] !== null &&
    a[i - 1] >= b[i - 1] && a[i] < b[i];
}

/**
 * 规则化技术面判定。返回逐条可解释信号 + 多空计数，不做价格预测。
 */
function analyze(kline) {
  if (!kline || kline.length < 30) {
    return { ready: false, trend: '数据不足', bull: 0, bear: 0, signals: [], indicators: null };
  }
  const closes = kline.map((k) => k.close);
  const i = kline.length - 1;
  const last = kline[i];
  const prev = kline[i - 1];

  const ma = { ma5: sma(closes, 5), ma10: sma(closes, 10), ma20: sma(closes, 20), ma60: sma(closes, 60) };
  const macdRes = macd(closes);
  const kdjRes = kdj(kline);
  const rsiRes = rsi(closes, 14);
  const bollRes = boll(closes, 20, 2);
  const volMa5 = volumeMA(kline, 5);
  const volMa10 = volumeMA(kline, 10);

  const signals = [];
  const add = (type, text, group) => signals.push({ type, text, group });

  // --- 均线 ---
  const m5 = ma.ma5[i], m10 = ma.ma10[i], m20 = ma.ma20[i], m60 = ma.ma60[i];
  if (m5 !== null && m10 !== null && m20 !== null) {
    if (m5 > m10 && m10 > m20) add('bullish', '均线多头排列（MA5 > MA10 > MA20）', '均线');
    else if (m5 < m10 && m10 < m20) add('bearish', '均线空头排列（MA5 < MA10 < MA20）', '均线');
    else add('neutral', '均线交织，趋势方向不明', '均线');
  }
  if (m20 !== null) {
    add(last.close >= m20 ? 'bullish' : 'bearish',
      '收盘价' + (last.close >= m20 ? '站上' : '跌破') + ' MA20（' + m20 + '）', '均线');
  }
  if (m60 !== null) {
    add(last.close >= m60 ? 'bullish' : 'bearish',
      (last.close >= m60 ? '位于' : '跌破') + ' MA60（' + m60 + '），中期结构' + (last.close >= m60 ? '未破' : '转弱'), '均线');
  }
  if (crossUp(ma.ma5, ma.ma20, i)) add('bullish', 'MA5 上穿 MA20（金叉）', '均线');
  if (crossDown(ma.ma5, ma.ma20, i)) add('bearish', 'MA5 下穿 MA20（死叉）', '均线');

  // --- MACD ---
  if (crossUp(macdRes.dif, macdRes.dea, i)) add('bullish', 'MACD 金叉（DIF 上穿 DEA）', 'MACD');
  if (crossDown(macdRes.dif, macdRes.dea, i)) add('bearish', 'MACD 死叉（DIF 下穿 DEA）', 'MACD');
  if (macdRes.hist[i] > 0 && macdRes.hist[i - 1] <= 0) add('bullish', 'MACD 柱由绿翻红', 'MACD');
  if (macdRes.hist[i] < 0 && macdRes.hist[i - 1] >= 0) add('bearish', 'MACD 柱由红翻绿', 'MACD');
  if (macdRes.dif[i] > 0 && macdRes.dea[i] > 0) add('bullish', 'MACD 位于零轴上方（多头区间）', 'MACD');
  if (macdRes.dif[i] < 0 && macdRes.dea[i] < 0) add('bearish', 'MACD 位于零轴下方（空头区间）', 'MACD');

  // --- KDJ ---
  if (crossUp(kdjRes.k, kdjRes.d, i) && kdjRes.k[i] < 40) add('bullish', 'KDJ 低位金叉（K=' + kdjRes.k[i] + '）', 'KDJ');
  if (crossDown(kdjRes.k, kdjRes.d, i) && kdjRes.k[i] > 60) add('bearish', 'KDJ 高位死叉（K=' + kdjRes.k[i] + '）', 'KDJ');
  if (kdjRes.j[i] > 100) add('bearish', 'KDJ 的 J 值超买（' + kdjRes.j[i] + '）', 'KDJ');
  if (kdjRes.j[i] < 0) add('bullish', 'KDJ 的 J 值超卖（' + kdjRes.j[i] + '）', 'KDJ');

  // --- RSI ---
  const r = rsiRes[i];
  if (r !== null) {
    if (r >= 70) add('bearish', 'RSI 超买（' + r + '）', 'RSI');
    else if (r <= 30) add('bullish', 'RSI 超卖（' + r + '）', 'RSI');
    else add('neutral', 'RSI 中性（' + r + '）', 'RSI');
  }

  // --- BOLL ---
  if (bollRes.upper[i] !== null) {
    if (last.close >= bollRes.upper[i]) add('bearish', '收盘触及布林上轨（' + bollRes.upper[i] + '），短期偏热', 'BOLL');
    if (last.close <= bollRes.lower[i]) add('bullish', '收盘触及布林下轨（' + bollRes.lower[i] + '），短期超跌', 'BOLL');
    if (crossUp(closes, bollRes.mid, i)) add('bullish', '价格上穿布林中轨', 'BOLL');
    if (crossDown(closes, bollRes.mid, i)) add('bearish', '价格下穿布林中轨', 'BOLL');
  }

  // --- 量能 ---
  const avgVol10 = volMa10[i];
  const volRatio = avgVol10 ? last.volume / avgVol10 : null;
  if (volRatio !== null) {
    if (volRatio >= 1.8 && last.close >= prev.close) add('bullish', '放量上行（量为 10 日均量 ' + volRatio.toFixed(2) + ' 倍）', '量能');
    else if (volRatio >= 1.8 && last.close < prev.close) add('bearish', '放量下行（量为 10 日均量 ' + volRatio.toFixed(2) + ' 倍）', '量能');
    else if (volRatio <= 0.6) add('neutral', '缩量（仅为 10 日均量 ' + volRatio.toFixed(2) + ' 倍）', '量能');
  }

  // --- 位置与形态 ---
  const win = kline.slice(-20);
  const hi20 = Math.max.apply(null, win.map((k) => k.high));
  const lo20 = Math.min.apply(null, win.map((k) => k.low));
  const pos20 = hi20 === lo20 ? 50 : Math.round(((last.close - lo20) / (hi20 - lo20)) * 100);
  add('neutral', '近 20 日区间位置 ' + pos20 + '%（' + lo20 + ' ~ ' + hi20 + '）', '位置');

  if (kline.length >= 25) {
    const prior = kline.slice(-21, -1);
    const priorHigh = Math.max.apply(null, prior.map((k) => k.high));
    if (last.close > priorHigh && volRatio !== null && volRatio >= 1.5) {
      add('bullish', '放量突破前 20 日高点（' + priorHigh + '）', '形态');
    }
    const priorLow = Math.min.apply(null, prior.map((k) => k.low));
    if (last.close < priorLow && volRatio !== null && volRatio >= 1.5) {
      add('bearish', '放量跌破前 20 日低点（' + priorLow + '）', '形态');
    }
  }

  // 影线形态
  const body = Math.abs(last.close - last.open);
  const upperShadow = last.high - Math.max(last.close, last.open);
  const lowerShadow = Math.min(last.close, last.open) - last.low;
  const range = last.high - last.low || 1;
  if (lowerShadow > body * 2 && lowerShadow / range > 0.5) add('bullish', '长下影（下影占振幅 ' + Math.round(lowerShadow / range * 100) + '%），下方有承接', '形态');
  if (upperShadow > body * 2 && upperShadow / range > 0.5) add('bearish', '长上影（上影占振幅 ' + Math.round(upperShadow / range * 100) + '%），上方有抛压', '形态');
  if (body / range < 0.1) add('neutral', '实体很小（十字星），多空僵持', '形态');

  // 近 5 日累计涨跌
  if (kline.length >= 6) {
    const chg5 = (last.close / kline[i - 5].close - 1) * 100;
    add(chg5 > 0 ? 'bullish' : chg5 < 0 ? 'bearish' : 'neutral', '近 5 日累计' + (chg5 >= 0 ? '上涨 ' : '下跌 ') + Math.abs(chg5).toFixed(2) + '%', '动量');
  }

  const bull = signals.filter((s) => s.type === 'bullish').length;
  const bear = signals.filter((s) => s.type === 'bearish').length;
  const trend = bull - bear >= 3 ? '技术面偏多' : bull - bear <= -3 ? '技术面偏空' : '技术面中性';

  return {
    ready: true,
    trend,
    bull,
    bear,
    signals,
    indicators: {
      ma5: m5, ma10: m10, ma20: m20, ma60: m60,
      dif: macdRes.dif[i], dea: macdRes.dea[i], macdHist: macdRes.hist[i],
      k: kdjRes.k[i], d: kdjRes.d[i], j: kdjRes.j[i],
      rsi14: rsiRes[i],
      bollUpper: bollRes.upper[i], bollMid: bollRes.mid[i], bollLower: bollRes.lower[i],
      volRatio: volRatio === null ? null : Number(volRatio.toFixed(2)),
      rangePosition20: pos20
    }
  };
}

module.exports = { sma, ema, macd, kdj, rsi, boll, volumeMA, analyze };
