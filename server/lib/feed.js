'use strict';

/**
 * 资讯归一化与主题分类（被 news / cls / global 等来源共用，避免循环依赖）。
 */
const sentiment = require('./sentiment');

const TOPIC_KEYWORDS = {
  cotton: ['棉花', '郑棉', '棉纱', '棉价', '籽棉', '皮棉', '新疆棉', '纺织', '棉市', '棉花期货', '棉纺'],
  coal: ['煤炭', '煤价', '动力煤', '焦煤', '焦炭', '秦皇岛', '港口库存', '电煤', '煤企', '煤化工', '长协', '煤炭库存', '电厂', '煤矿'],
  commodity: ['大宗商品', '期货', '原油', '铁矿石', '螺纹钢', '铜价', '现货', '商品指数', '黄金', '有色金属', '玻璃', '纯碱', '橡胶', '豆粕', '商品价格', '伦铜', '布伦特'],
  macro: ['央行', '降准', '降息', 'LPR', '国常会', '发改委', '财政部', '关税', '美联储', 'CPI', 'PPI', 'PMI', '汇率', '人民币', '财政政策', '货币政策', '加息', '欧央行'],
  market: ['北向', '主力资金', '龙虎榜', '融资余额', 'ETF', '基金', 'A股', '指数', '涨停', '跌停', '板块', '两融', '新股'],
  global: ['美股', '纳斯达克', '标普', '道指', '欧洲', '日本', '港股', '恒生', '黄金', '原油', '美元指数', '美债', '全球', '海外']
};

function classifyTopics(text, extra) {
  const src = String(text || '');
  const out = new Set(extra || []);
  for (const [topic, words] of Object.entries(TOPIC_KEYWORDS)) {
    if (words.some((w) => src.includes(w))) out.add(topic);
  }
  return Array.from(out);
}

function normalizeTitle(title) {
  return String(title || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[【】\[\]（）()《》「」:：,，。.、!！?？\-—_"'|｜\/]/g, '')
    .slice(0, 40);
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function toTimestamp(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)) {
    const d = new Date(text.replace(' ', 'T') + (text.length <= 16 ? ':00' : '') + '+08:00');
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  const fallback = new Date(text);
  return Number.isFinite(fallback.getTime()) ? fallback.toISOString() : null;
}

/** 统一资讯条目结构，并附加主题标签与情绪分。 */
function decorate(item, extraTopics) {
  const blob = [item.title, item.summary].filter(Boolean).join('。');
  return {
    id: item.id,
    source: item.source,
    title: item.title || stripHtml(item.summary).slice(0, 60),
    summary: item.summary || '',
    url: item.url || '',
    timestamp: toTimestamp(item.timestamp),
    topics: classifyTopics(blob, extraTopics),
    sentiment: sentiment.analyze(blob),
    meta: item.meta || {}
  };
}

module.exports = { TOPIC_KEYWORDS, classifyTopics, normalizeTitle, stripHtml, toTimestamp, decorate };
