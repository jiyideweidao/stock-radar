'use strict';

const { fetchJson } = require('../lib/http');
const { cached } = require('../lib/cache');
const sentiment = require('../lib/sentiment');
const { TOPIC_KEYWORDS, classifyTopics, normalizeTitle, decorate, stripHtml } = require('../lib/feed');
const cls = require('./cls');
const ths = require('./ths');
const globalFeed = require('./global');
const translate = require('../lib/translate');

const EM_REF = 'https://so.eastmoney.com/';
const SINA_REF = 'https://finance.sina.com.cn';

/**
 * 定向检索探针：东方财富全站检索对「棉花」这类宽词噪声较大，
 * 改用行业惯用词（郑棉 / 动力煤）能显著提高主题命中率。
 */
const PROBES = [
  { topic: 'cotton', keyword: '郑棉' },
  { topic: 'cotton', keyword: '棉价' },
  { topic: 'coal', keyword: '动力煤' },
  { topic: 'coal', keyword: '煤价' },
  { topic: 'coal', keyword: '秦皇岛港 煤炭库存' },
  { topic: 'commodity', keyword: '大宗商品' },
  { topic: 'commodity', keyword: '商品期货' }
];

const FINANCE_HINT = ['股', '市场', '经济', '政策', '期货', '商品', '央行', '证券', '基金', '债', '汇率', '煤', '棉', '价', '出口', '进口', '企业', '产业', '投资'];

/** 东方财富 7x24 全球快讯。 */
async function fetchEmFastNews(pageSize = 80) {
  return cached('news:em724:' + pageSize, 60000, async () => {
    const url =
      'https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724' +
      '&fastColumn=102&sortEnd=&pageSize=' + pageSize + '&req_trace=' + Date.now();
    const json = await fetchJson(url, { referer: 'https://kuaixun.eastmoney.com/' });
    const list = (json && json.data && json.data.fastNewsList) || [];
    return list.map((row) =>
      decorate({
        id: 'em724-' + row.code,
        source: '东方财富·7x24快讯',
        title: row.title || stripHtml(row.summary).slice(0, 60),
        summary: row.summary || '',
        url: 'https://so.eastmoney.com/news/s?keyword=' + encodeURIComponent(row.title || ''),
        timestamp: row.showTime
      })
    );
  });
}

/** 东方财富全站新闻检索。 */
async function fetchEmSearch(keyword, pageSize = 20, sort = 'time') {
  const key = 'news:emsearch:' + keyword + ':' + pageSize + ':' + sort;
  return cached(key, 300000, async () => {
    const param = {
      uid: '',
      keyword: keyword,
      type: ['cmsArticleWebOld'],
      client: 'web',
      clientType: 'web',
      clientVersion: 'curr',
      param: { cmsArticleWebOld: { searchScope: 'default', sort: sort, pageIndex: 1, pageSize: pageSize, preTag: '', postTag: '' } }
    };
    const url = 'https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=' + encodeURIComponent(JSON.stringify(param));
    const json = await fetchJson(url, { referer: EM_REF });
    const list = (json && json.result && json.result.cmsArticleWebOld) || [];
    return list.map((row) =>
      decorate({
        id: 'emsearch-' + row.code,
        source: row.mediaName ? '东方财富·' + row.mediaName : '东方财富',
        title: stripHtml(row.title),
        summary: stripHtml(row.content),
        url: row.url,
        timestamp: row.date
      })
    );
  });
}

/** 新浪财经滚动新闻（已按财经相关性过滤）。 */
async function fetchSinaRoll(num = 60) {
  return cached('news:sina:' + num, 180000, async () => {
    const url = 'https://feed.mix.sina.com.cn/api/roll/get?pageid=155&lid=1686&num=' + num + '&page=1';
    const json = await fetchJson(url, { referer: SINA_REF });
    const list = (json && json.result && json.result.data) || [];
    return list
      .filter((row) => {
        const blob = [row.title, row.intro].filter(Boolean).join(' ');
        if (/星座|天气|返程|限行|菜谱|养生|健康提示|招生|考试/.test(blob)) return false;
        return FINANCE_HINT.some((w) => blob.includes(w));
      })
      .map((row) =>
        decorate({
          id: 'sina-' + (row.docid || row.url),
          source: '新浪财经·' + (row.media_name || '财经'),
          title: row.title,
          summary: row.intro || '',
          url: row.url,
          timestamp: Number(row.ctime) || null
        })
      );
  });
}

/**
 * 数据源清单：每个源独立可查，供「数据源浏览」页签按源查看。
 */
const SOURCES = {
  cls: { label: '财联社', describe: '电报（sign 签名接口）', load: () => cls.fetchTelegraph(40) },
  em724: { label: '东方财富 7x24', describe: '全球快讯', load: () => fetchEmFastNews(80) },
  ths: { label: '同花顺', describe: '当日要闻', load: () => ths.fetchNewsList(30) },
  sina: { label: '新浪财经', describe: '滚动新闻', load: () => fetchSinaRoll(60) },
  wscn: {
    label: '华尔街见闻',
    describe: '全球快讯 + 热门文章',
    load: async () => {
      const parts = await Promise.allSettled([globalFeed.fetchWscnLives(30), globalFeed.fetchWscnHot(15)]);
      return parts.filter((p) => p.status === 'fulfilled').flatMap((p) => p.value);
    }
  },
  jin10: { label: '金十数据', describe: '实时快讯', load: () => globalFeed.fetchJin10(40) }
};

async function getSourceFeed(sourceId, limit = 60) {
  const src = SOURCES[sourceId];
  if (!src) return null;
  const items = await src.load();
  // 英文条目（目前只有金十数据）先翻一遍：这一页是给用户逐源看的，英文原稿看不懂就没意义
  await translate.translateItems(items, { budget: 12, maxWaitMs: 8000 });
  return {
    id: sourceId,
    label: src.label,
    describe: src.describe,
    updatedAt: new Date().toISOString(),
    count: items.length,
    overall: sentiment.aggregate(items),
    items: items.slice(0, limit)
  };
}

/**
 * 聚合新闻流：多源 + 定向检索 -> 去重 -> 时间倒序 -> 主题过滤。
 * 任一数据源失败不影响整体。
 */
async function getNewsFeed(options = {}) {
  const { topics = [], limit = 80, includeSina = true, includeGlobal = true } = options;

  const probeList = topics.length ? PROBES.filter((p) => topics.includes(p.topic)) : PROBES;
  const activeProbes = probeList.length ? probeList : PROBES;

  const tasks = [
    fetchEmFastNews(80).then((l) => l.map((item) => ({ item, topic: null }))),
    cls.fetchTelegraph(30).then((l) => l.map((item) => ({ item, topic: null }))).catch(() => []),
    ths.fetchNewsList(30).then((l) => l.map((item) => ({ item, topic: null }))).catch(() => [])
  ];
  for (const probe of activeProbes) {
    tasks.push(
      fetchEmSearch(probe.keyword, 20)
        .then((l) => l.map((item) => ({ item, topic: probe.topic })))
        .catch(() => [])
    );
  }
  if (includeSina) tasks.push(fetchSinaRoll(60).then((l) => l.map((item) => ({ item, topic: null }))).catch(() => []));
  if (includeGlobal) {
    tasks.push(globalFeed.getGlobalFeed(40).then((r) => r.items.map((item) => ({ item, topic: null }))).catch(() => []));
  }

  const settled = await Promise.allSettled(tasks);
  const merged = [];
  const seen = new Set();
  for (const res of settled) {
    if (res.status !== 'fulfilled') continue;
    for (const { item, topic } of res.value) {
      const key = normalizeTitle(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const itemTopics = item.topics || [];
      merged.push(topic && !itemTopics.includes(topic) ? { ...item, topics: itemTopics.concat([topic]) } : item);
    }
  }

  merged.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  // 英文快讯（目前只有金十数据）先翻成中文再算主题和情绪，否则它们既进不了
  //「棉花 / 煤炭」这些主题筛选，情绪分也永远是 0，等于在舆情统计里凭空消失。
  // 只翻最新的一批：一来看得见的就是这批，二来免费翻译接口有额度，不能全量翻。
  const fresh = merged.slice(0, 80);
  await translate.translateItems(fresh, { budget: 10, maxWaitMs: 7000 });
  fresh.forEach((item) => {
    if (!item.titleZh) return;
    const blob = [item.titleZh, item.summaryZh].filter(Boolean).join('。');
    item.topics = classifyTopics(blob, item.topics || []);
    item.sentiment = sentiment.analyze(blob);
  });

  const filtered = topics.length ? merged.filter((item) => (item.topics || []).some((t) => topics.includes(t))) : merged;

  return {
    updatedAt: new Date().toISOString(),
    totalScanned: merged.length,
    matched: filtered.length,
    overall: sentiment.aggregate(merged.slice(0, 200)),
    sourceCounts: countBySource(merged),
    items: filtered.slice(0, limit)
  };
}

function countBySource(items) {
  const map = new Map();
  for (const item of items) {
    const key = String(item.source || '').split('·')[0];
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Array.from(map.entries()).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);
}

/** 单只股票的相关新闻 + 情绪聚合。 */
async function getStockNews(name, code, pageSize = 15) {
  const [primary, secondary] = await Promise.all([
    fetchEmSearch(name, pageSize).catch(() => []),
    fetchEmSearch(code, Math.ceil(pageSize / 2)).catch(() => [])
  ]);
  const merged = [];
  const seen = new Set();
  for (const item of primary.concat(secondary)) {
    const key = normalizeTitle(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  merged.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  const relevant = merged.filter((item) => {
    const blob = (item.title || '') + (item.summary || '');
    return blob.includes(name) || blob.includes(code);
  });

  const finalList = relevant.length ? relevant : merged;
  return { items: finalList, sentiment: sentiment.aggregate(finalList) };
}

module.exports = {
  fetchEmFastNews,
  fetchEmSearch,
  fetchSinaRoll,
  getNewsFeed,
  getStockNews,
  getSourceFeed,
  SOURCES,
  classifyTopics,
  TOPIC_KEYWORDS,
  PROBES
};
