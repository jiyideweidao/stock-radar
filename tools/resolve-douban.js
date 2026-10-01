'use strict';
/**
 * 把每本书解析到豆瓣的「具体书目页」（而不是搜索结果页），产出 server/data/book-links.json。
 * 只抓公开的书目 ID / 标题 / 评分 / 出版社等元数据，不抓取、不保存任何书籍正文内容。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'server', 'data');
const OUT = path.join(DATA, 'book-links.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      timeout: 20000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const norm = (s) => String(s || '')
  .replace(/[《》]/g, '')
  .replace(/[（(]/g, '(').replace(/[）)]/g, ')')
  .replace(/[\s:：\-—·.]/g, '')
  .toLowerCase();

function cleanBase(title) {
  const m = String(title || '').match(/《(.+?)》/);
  let base = m ? m[1] : String(title || '');
  base = base.replace(/（[^）]*版[^）]*）$/, '').replace(/\([^)]*版[^)]*\)$/, '').trim();
  return base;
}

function parseBlocks(html) {
  return html.split('class="result"').slice(1).map((blk) => {
    const sid = (blk.match(/sid:\s*(\d+)/) || [])[1] || null;
    const title = (blk.match(/title="([^"]*)"/) || [])[1] || '';
    const rating = (blk.match(/rating_nums">([\d.]+)/) || [])[1] || '';
    const cast = (blk.match(/subject-cast">([^<]*)</) || [])[1] || '';
    return {
      sid,
      title: title.trim(),
      rating,
      cast: cast.trim(),
      trial: blk.includes('可试读'),
      ebook: blk.includes('有电子版')
    };
  }).filter((x) => x.sid);
}

async function search(query) {
  const url = 'https://www.douban.com/search?cat=1001&q=' + encodeURIComponent(query);
  const { status, body } = await fetchText(url);
  if (status !== 200) throw new Error('status ' + status);
  return parseBlocks(body);
}

(async () => {
  const knowledge = JSON.parse(fs.readFileSync(path.join(DATA, 'knowledge.json'), 'utf8').replace(/^\uFEFF/, ''));
  const links = {};
  const report = [];

  for (const b of knowledge.books) {
    const base = cleanBase(b.title);
    let hit = null;
    let how = '';
    try {
      let cands = await search(base);
      hit = cands.find((c) => norm(c.title).includes(norm(base)));
      how = 'full';
      if (!hit) {
        const short = base.split(/[：:]/)[0].trim();
        if (short && short !== base) {
          await sleep(1600);
          cands = await search(short);
          hit = cands.find((c) => norm(c.title).includes(norm(short)));
          how = 'short:' + short;
        }
      }
    } catch (e) {
      how = 'ERROR ' + e.message;
    }

    if (hit) {
      links[b.id] = {
        subjectId: hit.sid,
        url: 'https://book.douban.com/subject/' + hit.sid + '/',
        matchedTitle: hit.title,
        rating: hit.rating,
        cast: hit.cast,
        trial: hit.trial,
        ebook: hit.ebook
      };
      report.push([b.id, 'OK', hit.title + ' | ' + hit.rating + ' | ' + (hit.trial ? '可试读 ' : '') + (hit.ebook ? '有电子版' : '') + ' | ' + how]);
    } else {
      report.push([b.id, 'MISS', b.title + ' | ' + how]);
    }
    await sleep(1800);
  }

  fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), source: 'douban legacy search (public metadata only)', links }, null, 2) + '\n', 'utf8');
  console.log('resolved ' + Object.keys(links).length + ' / ' + knowledge.books.length);
  report.forEach((r) => console.log('  [' + r[1] + '] ' + r[0] + ' :: ' + r[2]));
})();