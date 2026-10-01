'use strict';

const { fetchText } = require('../lib/http');
const { cached } = require('../lib/cache');
const { stripHtml } = require('../lib/feed');
const sentiment = require('../lib/sentiment');

/**
 * 股吧（散户讨论区）。
 *
 * 数据源选择说明：
 *  - 东方财富股吧接口（gbapi.eastmoney.com/webarticlelist）本机实测持续返回
 *    `{"re":[],"count":0,"me":"系统繁忙, 请稍后再试[00003]"}`，即该接口已做访问限制；
 *  - 雪球讨论接口需要登录态（xq_a_token），匿名不可用；
 *  - 新浪「股市汇」股吧页面可匿名访问（GB2312 编码），因此作为股吧来源。
 * 讨论区内容仅代表散户情绪，不作为事实依据，界面需明示。
 */

/**
 * 股吧口语词表：股吧标题以口语和情绪宣泄为主，通用财经词表命中率很低，
 * 因此补充一层股吧专用词（权重 1-2，弱于新闻词表的 3），与通用词表结果相加。
 */
const GUBA_BULLISH = ['起飞', '干了', '干杯', '加仓', '建仓', '抄底', '上车', '拉升', '雄起', '翻倍', '牛回', '反转', '突破', '要涨', '利好', '吃肉', '稳了', '见底'];
const GUBA_BEARISH = ['垃圾', '割肉', '套牢', '被套', '割韭菜', '完蛋', '凉了', '拉稀', '阴跌', '出货', '跑路', '坑人', '骗人', '砸盘', '退钱', '要跌', '利空', '危险', '接盘', '站岗'];

function gubaSentiment(text) {
  const base = sentiment.analyze(text);
  let extra = 0;
  const hits = base.hits.slice();
  for (const w of GUBA_BULLISH) {
    if (text.includes(w)) { extra += 2; hits.push({ term: w, polarity: 'bullish', weight: 2 }); }
  }
  for (const w of GUBA_BEARISH) {
    if (text.includes(w)) { extra -= 2; hits.push({ term: w, polarity: 'bearish', weight: 2 }); }
  }
  const score = Math.max(-100, Math.min(100, base.score + extra * 8));
  return {
    score,
    label: sentiment.labelOf(score),
    hits,
    positive: hits.filter((h) => h.polarity === 'bullish').length,
    negative: hits.filter((h) => h.polarity === 'bearish').length
  };
}

const REF = 'https://guba.sina.com.cn/';
const BASE = 'https://guba.sina.com.cn/';

/** 股票代码 -> 新浪股吧代码（sh600121 / sz002212） */
function toGubaCode(code) {
  const c = String(code).replace(/\D/g, '');
  return (/^(6|9|5)/.test(c) ? 'sh' : 'sz') + c;
}

/**
 * 抓取某只股票的股吧帖子列表。
 * @returns {Promise<{board, posts, sentiment, hotWords}>}
 */
async function fetchBoard(code, limit = 30) {
  const gubaCode = toGubaCode(code);
  return cached('guba:board:' + gubaCode + ':' + limit, 180000, async () => {
    const html = await fetchText(BASE + '?s=bar&name=' + gubaCode, { referer: REF, encoding: 'gbk' });

    const boardMatch = html.match(/<title>([\s\S]*?)<\/title>/);
    const board = boardMatch ? stripHtml(boardMatch[1]).replace(/_.*$/, '') : gubaCode;

    const posts = [];
    const seen = new Set();
    const re = /<a\s+href="(\/\?s=thread&tid=(\d+)&bid=(\d+))"[^>]*class="[^"]*linkblack[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = BASE.replace(/\/$/, '') + m[1];
      const title = stripHtml(m[4]).trim();
      if (!title || title.length < 2 || seen.has(m[2])) continue;
      seen.add(m[2]);
      posts.push({
        id: 'guba-' + m[2],
        tid: m[2],
        bid: m[3],
        title,
        url,
        sentiment: gubaSentiment(title)
      });
    }

    // 作者按出现顺序与帖子一一对应（页面结构为「标题…作者」成对出现）
    const authors = [];
    const authorRe = /<a\s+href='\/u\/(\d+)'\s+title='([^']*)'/g;
    let am;
    while ((am = authorRe.exec(html)) !== null) authors.push({ userId: am[1], name: stripHtml(am[2]) });
    posts.forEach((p, i) => { p.author = authors[i] ? authors[i].name : ''; });

    const hotWords = topWords(posts.map((p) => p.title), 20, board);

    return {
      board,
      gubaCode,
      url: BASE + '?s=bar&name=' + gubaCode,
      count: posts.length,
      posts: posts.slice(0, limit),
      sentiment: sentiment.aggregate(posts.map((p) => ({ sentiment: p.sentiment, timestamp: null }))),
      hotWords,
      disclaimer: '股吧内容为散户个人观点，不代表事实，也不构成投资建议；仅用于观察市场情绪。'
    };
  });
}

/** 简单中文分词：抽取 2-4 字高频片段（无外部词典，按标题共现统计）。 */
function topWords(titles, limit = 20, boardName = '') {
  const stop = new Set(['股票', '今天', '明天', '什么', '怎么', '这个', '那个', '我们', '你们', '他们', '可以', '已经', '还是', '就是', '真的', '不是', '没有', '一个', '现在', '就是', '一个', '时候', '感觉', '各位', '大家']);
  // 剔除股票名与代码片段，否则热词会被自家名字刷屏
  const nameFrags = new Set();
  const nameOnly = String(boardName).replace(/[^\u4e00-\u9fa5]/g, '');
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i + n <= nameOnly.length; i += 1) nameFrags.add(nameOnly.slice(i, i + n));
  }
  const counter = new Map();
  for (const title of titles) {
    const clean = String(title).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, ' ');
    for (const seg of clean.split(/\s+/)) {
      // 纯字母/数字片段（如 SH600121、600、00）一律丢弃
      if (!/[\u4e00-\u9fa5]/.test(seg)) continue;
      const len = seg.length;
      for (let n = 2; n <= 4; n += 1) {
        for (let i = 0; i + n <= len; i += 1) {
          const w = seg.slice(i, i + n);
          if (w.length < 2 || stop.has(w)) continue;
          if (!/[\u4e00-\u9fa5]/.test(w)) continue;
          if (nameFrags.has(w) || nameOnly.includes(w)) continue;
          counter.set(w, (counter.get(w) || 0) + 1);
        }
      }
    }
  }
  const sorted = Array.from(counter.entries()).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
  const picked = [];
  for (const [word, count] of sorted) {
    if (picked.some((p) => p.word.includes(word) || word.includes(p.word))) continue;
    picked.push({ word, count });
    if (picked.length >= limit) break;
  }
  return picked;
}

module.exports = { fetchBoard, toGubaCode, topWords, gubaSentiment };
