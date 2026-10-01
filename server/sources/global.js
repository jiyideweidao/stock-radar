'use strict';

const { fetchJson, fetchText } = require('../lib/http');
const { cached } = require('../lib/cache');
const { decorate, stripHtml } = require('../lib/feed');

/**
 * 国际 / 环球财经资讯。
 *
 * 关于「彭博社」：bloomberg.com 及其 RSS（feeds.bloomberg.com）在本机网络下无法连通，
 * 且其行情与终端数据为订阅制，不存在可匿名接入的公开接口。
 * 因此本模块用以下两个可用的中文环球财经源替代，并在界面明确标注来源：
 *   - 华尔街见闻（全球快讯 + 热门文章）：以国际宏观、美股、大宗商品为主；
 *   - 金十数据（实时快讯）：以宏观数据、央行动态、商品报价为主。
 */

const REF_WSCN = 'https://wallstreetcn.com/';
const REF_JIN10 = 'https://www.jin10.com/';

/** 华尔街见闻实时快讯。 */
async function fetchWscnLives(limit = 30) {
  return cached('global:wscn:lives:' + limit, 60000, async () => {
    const url = 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&client=pc&limit=' + limit;
    const json = await fetchJson(url, { referer: REF_WSCN });
    const items = (json.data && json.data.items) || [];
    return items.map((row) =>
      decorate({
        id: 'wscn-' + row.id,
        source: '华尔街见闻·全球快讯',
        title: stripHtml(row.title || row.content_short || row.content).slice(0, 90),
        summary: stripHtml(row.content_short || row.content),
        url: row.uri || ('https://wallstreetcn.com/livenews/' + row.id),
        timestamp: row.display_time,
        meta: { importance: row.importance, score: row.score }
      }, ['global'])
    );
  });
}

/** 华尔街见闻热门文章（按阅读量）。 */
async function fetchWscnHot(limit = 20) {
  return cached('global:wscn:hot:' + limit, 300000, async () => {
    const url = 'https://api-one.wallstcn.com/apiv1/content/articles/hot?period=all&limit=' + limit;
    const json = await fetchJson(url, { referer: REF_WSCN });
    const data = (json.data || {});
    const items = data.day_items || data.items || [];
    return items.map((row) =>
      decorate({
        id: 'wscn-article-' + row.id,
        source: '华尔街见闻·热门',
        title: stripHtml(row.title),
        summary: stripHtml(row.content_short || row.summary || ''),
        url: row.uri || ('https://wallstreetcn.com/articles/' + row.id),
        timestamp: row.display_time,
        meta: { pageviews: row.pageviews, commentCount: row.comment_count }
      }, ['global'])
    );
  });
}

/** 金十数据实时快讯。 */
async function fetchJin10(limit = 30) {
  return cached('global:jin10:' + limit, 60000, async () => {
    const text = await fetchText('https://www.jin10.com/flash_newest.js', { referer: REF_JIN10 });
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) throw new Error('金十响应格式异常');
    const rows = JSON.parse(text.slice(start, end + 1));
    return rows.slice(0, limit).map((row) => {
      const d = row.data || {};
      return decorate({
        id: 'jin10-' + row.id,
        source: '金十数据·快讯',
        title: stripHtml(d.title || d.content).slice(0, 90),
        summary: stripHtml(d.content),
        url: 'https://www.jin10.com/',
        timestamp: row.time,
        meta: { type: row.type, dataSource: d.source || '', link: d.link || '' }
      }, ['global']);
    });
  });
}

/** 环球财经聚合（多源合并去重）。 */
async function getGlobalFeed(limit = 60) {
  const parts = await Promise.allSettled([fetchWscnLives(30), fetchWscnHot(15), fetchJin10(30)]);
  const merged = [];
  const seen = new Set();
  const failures = [];
  for (const res of parts) {
    if (res.status !== 'fulfilled') { failures.push(String(res.reason && res.reason.message || res.reason)); continue; }
    for (const item of res.value) {
      const key = String(item.title || '').replace(/\s+/g, '').slice(0, 36);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  merged.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  return {
    updatedAt: new Date().toISOString(),
    substituteNote: '彭博社（bloomberg.com）在本机网络不可达且为订阅制，此处以华尔街见闻与金十数据替代，来源已逐条标注。',
    failures,
    items: merged.slice(0, limit)
  };
}

module.exports = { fetchWscnLives, fetchWscnHot, fetchJin10, getGlobalFeed };
