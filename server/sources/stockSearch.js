'use strict';
/**
 * 股票名称联想（选股时「输入名称找代码」用）。
 *
 * 用东方财富的 suggest 接口：支持中文名、拼音缩写、代码片段，返回 JSON，
 * 比在行情节点里翻页搜名称靠谱得多——全市场 5000 多只，翻页永远搜不全。
 */
const http = require('../lib/http');
const { cached } = require('../lib/cache');

const ENDPOINT = 'https://searchapi.eastmoney.com/api/suggest/get';
// 东财网页版公开使用的固定 token，不是账号凭证
const TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

/**
 * 关键词 -> A 股候选（已过滤掉港美股、基金、债券等）。
 * @returns {Promise<Array<{code:string,name:string,market:string}>>}
 */
async function search(keyword, limit = 12) {
  const q = String(keyword || '').trim();
  if (!q) return [];
  const count = Math.max(1, Math.min(20, Number(limit) || 12));
  const url = ENDPOINT + '?input=' + encodeURIComponent(q) + '&type=14&token=' + TOKEN + '&count=' + count;

  return cached('stocksuggest:' + q + ':' + count, 60000, async () => {
    const data = await http.fetchJson(url, { referer: 'https://www.eastmoney.com/', timeoutMs: 12000 });
    const rows = (data && data.QuotationCodeTable && data.QuotationCodeTable.Data) || [];
    return rows
      .filter((r) => r && r.Classify === 'AStock' && /^\d{6}$/.test(String(r.Code || '')))
      .map((r) => ({
        code: String(r.Code),
        name: String(r.Name || ''),
        market: String(r.SecurityTypeName || ''),
        pinyin: String(r.PinYin || '')
      }));
  });
}

module.exports = { search, ENDPOINT };
