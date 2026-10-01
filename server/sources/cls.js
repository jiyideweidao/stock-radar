'use strict';

const crypto = require('crypto');
const { fetchJson } = require('../lib/http');
const { cached } = require('../lib/cache');
const { decorate, stripHtml } = require('../lib/feed');

/**
 * 财联社电报。
 *
 * 财联社接口要求 sign 参数。签名算法与其网页端一致：
 *   1. 将参数按 key 升序拼接为 k=v&k=v 形式；
 *   2. 对该串取 sha1 十六进制；
 *   3. 对 sha1 结果再取 md5 十六进制，即为 sign。
 * 这是「如实复现该站点自身请求」的只读抓取，请求频率由缓存控制在 60 秒一次。
 */

const REF = 'https://www.cls.cn/telegraph';
const BASE_PARAMS = { app: 'CailianpressWeb', os: 'web', sv: '8.4.6' };

function buildSign(params) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => k + '=' + params[k])
    .join('&');
  const sha1 = crypto.createHash('sha1').update(sorted).digest('hex');
  const sign = crypto.createHash('md5').update(sha1).digest('hex');
  return { sorted, sign };
}

function signedUrl(endpoint, params) {
  const merged = { ...BASE_PARAMS, ...params };
  const { sorted, sign } = buildSign(merged);
  return 'https://www.cls.cn' + endpoint + '?' + sorted + '&sign=' + sign;
}

/**
 * 电报列表。rn 为条数，lastTime 用于翻页（传上一条的 ctime）。
 * @returns {Promise<Array>} 归一化后的资讯条目
 */
async function fetchTelegraph(rnArg = 30, lastTime = '') {
  // 实测：rn 超过 50 时接口返回空列表，必须夹取
  const rn = Math.max(1, Math.min(50, Number(rnArg) || 30));
  const params = { rn: String(rn) };
  if (lastTime) {
    params.last_time = String(lastTime);
    params.lastTime = String(lastTime);
  }
  return cached('cls:telegraph:' + rn + ':' + lastTime, 60000, async () => {
    const json = await fetchJson(signedUrl('/v1/roll/get_roll_list', params), { referer: REF });
    if (json.errno !== 0) throw new Error('财联社返回 errno=' + json.errno + ' ' + (json.msg || ''));
    const list = (json.data && json.data.roll_data) || [];
    return list.map((row) =>
      decorate({
        id: 'cls-' + row.id,
        source: '财联社·电报',
        title: row.title || stripHtml(row.content).slice(0, 60),
        summary: stripHtml(row.brief || row.content),
        url: row.shareurl || ('https://www.cls.cn/detail/' + row.id),
        timestamp: row.ctime,
        meta: {
          level: row.level,
          readingNum: row.reading_num,
          commentNum: row.comment_num,
          subjects: (row.subjects || []).map((s) => s.subject_name).filter(Boolean).slice(0, 5),
          stocks: (row.stock_list || []).map((s) => s.name || s.stock_name || s.code).filter(Boolean).slice(0, 5),
          isTop: row.is_top === 1,
          hasImage: row.has_img === 1
        }
      }, ['telegraph'])
    );
  });
}

/** 财联社热门概念（从电报的 subjects 聚合，反映当日被反复提及的题材）。 */
async function getHotSubjects(hours = 24) {
  const items = await fetchTelegraphMulti(150);
  const since = Date.now() - hours * 3600000;
  const counter = new Map();
  for (const item of items) {
    if (item.timestamp && new Date(item.timestamp).getTime() < since) continue;
    for (const name of (item.meta && item.meta.subjects) || []) {
      const entry = counter.get(name) || { name, count: 0, scoreSum: 0, sample: null };
      entry.count += 1;
      entry.scoreSum += item.sentiment ? item.sentiment.score : 0;
      if (!entry.sample) entry.sample = { title: item.title, url: item.url };
      counter.set(name, entry);
    }
  }
  return Array.from(counter.values())
    .map((e) => ({ name: e.name, count: e.count, avgScore: Math.round(e.scoreSum / e.count), sample: e.sample }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

/**
 * 取更多电报。
 *
 * 实测限制：该接口只返回「最新 50 条」，且 last_time / lastTime 翻页参数均不被认可
 *（传上一页最旧时间后仍返回同一批），因此这里如实把上限设在 50 条，
 * 不再假装能翻页。50 条约覆盖最近 12-18 小时的快讯。
 */
async function fetchTelegraphMulti(total = 50) {
  const want = Math.max(1, Math.min(50, Number(total) || 50));
  return fetchTelegraph(want);
}

module.exports = { fetchTelegraph, fetchTelegraphMulti, getHotSubjects, buildSign };
