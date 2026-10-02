'use strict';
/**
 * 工作站自检：把「这个工作站还能不能正常用」拆成一条条可读的检查项。
 *   scope=local  只查本机（文件 / 台账 / 算法 / 窗口能力），秒级返回
 *   scope=full   本机 + HTTP 接口 + 外部数据源（联网，约 30-90 秒）
 * 每一项都返回 ok / fail / skip 与一句人话说明，方便在界面上直接看。
 */
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(SERVER_DIR, 'data');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const BASE = 'http://' + HOST + ':' + PORT;

const sentiment = require('./sentiment');
const indicators = require('./indicators');
const windowBridge = require('./window');
const coal = require(path.join(SERVER_DIR, 'sources', 'coal'));
const coalImport = require(path.join(SERVER_DIR, 'sources', 'coalImport'));
const futures = require(path.join(SERVER_DIR, 'sources', 'futures'));
const quotes = require(path.join(SERVER_DIR, 'sources', 'quotes'));
const news = require(path.join(SERVER_DIR, 'sources', 'news'));
const cls = require(path.join(SERVER_DIR, 'sources', 'cls'));
const ths = require(path.join(SERVER_DIR, 'sources', 'ths'));
const globalFeed = require(path.join(SERVER_DIR, 'sources', 'global'));
const market = require(path.join(SERVER_DIR, 'sources', 'market'));
const guba = require(path.join(SERVER_DIR, 'sources', 'guba'));
const screener = require(path.join(SERVER_DIR, 'sources', 'screener'));
const analysis = require(path.join(SERVER_DIR, 'sources', 'analysis'));
const advice = require(path.join(SERVER_DIR, 'sources', 'advice'));
const embed = require(path.join(SERVER_DIR, 'sources', 'embed'));
const translate = require(path.join(SERVER_DIR, 'lib', 'translate'));

/* --------------------------------- 工具 --------------------------------- */

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' 超时（' + ms + 'ms）')), ms);
    })
  ]);
}

function syntheticBars(n, dir) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const c = 20 + dir * i * 0.12 + Math.sin(i / 3.5) * 0.6;
    out.push({ date: '2026-01-' + String((i % 28) + 1).padStart(2, '0'), open: c - 0.1, high: c + 0.3, low: c - 0.3, close: c, volume: 1000 + i * 8 });
  }
  return out;
}

async function fetchText(url, ms) {
  const res = await withTimeout(fetch(url), ms || 12000, url);
  const text = await res.text();
  return { status: res.status, text };
}

async function fetchJson(url, ms) {
  const res = await withTimeout(fetch(url), ms || 12000, url);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function countNews(feed) {
  if (!feed) return 0;
  if (Array.isArray(feed)) return feed.length;
  if (Array.isArray(feed.items)) return feed.items.length;
  return 0;
}

/* ------------------------------- 检查定义 ------------------------------- */

const GROUPS = [
  {
    group: '本机环境',
    checks: [
      {
        name: 'Node.js 版本',
        level: 'local',
        run() {
          const major = Number(process.versions.node.split('.')[0]);
          if (major >= 18) return 'v' + process.versions.node + '（满足 >=18，支持内置 fetch）';
          throw new Error('Node.js 版本过低：v' + process.versions.node + '，请升级到 18 或更高');
        }
      },
      {
        name: 'Windows 与 PowerShell',
        level: 'local',
        run() {
          const cap = windowBridge.capabilities();
          if (cap.platform !== 'win32') throw new Error('当前系统是 ' + cap.platform + '，窗口按钮只在 Windows 上可用');
          return 'PowerShell: ' + cap.powershell;
        }
      },
      {
        name: '前端静态文件',
        level: 'local',
        run() {
          const files = ['index.html', 'styles.css', 'app.js'];
          const missing = files.filter((f) => !fs.existsSync(path.join(PUBLIC_DIR, f)));
          if (missing.length) throw new Error('缺少文件: ' + missing.join(', '));
          return files.map((f) => f + ' ' + Math.round(fs.statSync(path.join(PUBLIC_DIR, f)).size / 1024) + 'KB').join(' · ');
        }
      },
      {
        name: '数据目录可写',
        level: 'local',
        run() {
          const probe = path.join(DATA_DIR, '.write-probe.tmp');
          fs.writeFileSync(probe, 'ok');
          fs.unlinkSync(probe);
          return '可写入 ' + DATA_DIR;
        }
      }
    ]
  },
  {
    group: '数据台账',
    checks: [
      {
        name: '自选股清单',
        level: 'local',
        run() {
          const wl = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'watchlist.json'), 'utf8').replace(/^\uFEFF/, ''));
          const bad = wl.stocks.filter((s) => !/^\d{6}$/.test(s.code));
          if (bad.length) throw new Error('代码格式不对: ' + bad.map((s) => s.code).join(', '));
          return wl.stocks.map((s) => s.name + '(' + s.code + ')').join(' · ');
        }
      },
      {
        name: '交易知识库',
        level: 'local',
        run() {
          const kn = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'knowledge.json'), 'utf8').replace(/^\uFEFF/, ''));
          const n = Array.isArray(kn.books) ? kn.books.length : 0;
          if (!n) throw new Error('knowledge.json 里没有 books');
          return n + ' 本书的方法论提炼（未下载或分发原书 PDF）';
        }
      },
      {
        name: '板块清单',
        level: 'local',
        run() {
          const sec = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sectors.json'), 'utf8').replace(/^\uFEFF/, ''));
          return (sec.sectors || []).length + ' 个板块代码';
        }
      },
      {
        name: '煤炭港口库存台账',
        level: 'local',
        run() {
          const rows = coal.readRows();
          const series = coal.buildSeries();
          if (!rows.length) throw new Error('coal_inventory.csv 没有数据行');
          const ports = series.ports.map((p) => p.port).join(' · ');
          const sample = series.provenance && series.provenance.containsSampleData ? '（含示例数据行，界面已标注）' : '';
          return rows.length + ' 行 · 港口：' + ports + sample;
        }
      },
      {
        name: '煤炭进口月度台账',
        level: 'local',
        run() {
          const rows = coalImport.readRows();
          const series = coalImport.buildSeries();
          if (!rows.length) throw new Error('coal_import.csv 没有数据行');
          const sample = series.provenance && series.provenance.containsSampleData ? '（含示例数据行，界面已标注）' : '';
          return rows.length + ' 行 · 品种：' + series.groups.map((g) => g.variety).join(' · ') + sample;
        }
      }
    ]
  },
  {
    group: '算法引擎',
    checks: [
      {
        name: '舆情情绪引擎',
        level: 'local',
        run() {
          const good = sentiment.analyze('公司中标大额订单，净利润增长超预期，机构上调评级').score;
          const bad = sentiment.analyze('公司被立案调查，商誉减值，股东大幅减持').score;
          if (!(good > 40 && bad < -40)) throw new Error('利好/利空打分异常: ' + good + ' / ' + bad);
          return '利好 ' + good + ' 分 / 利空 ' + bad + ' 分（含否定词翻转）';
        }
      },
      {
        name: '技术指标（MA/MACD/KDJ/RSI/BOLL）',
        level: 'local',
        run() {
          const res = indicators.analyze(syntheticBars(120, 1));
          if (!res.ready) throw new Error('指标未就绪: ' + res.trend);
          const ind = res.indicators || {};
          ['ma5', 'ma20', 'ma60', 'dif', 'dea', 'k', 'd', 'j', 'rsi14', 'bollUpper', 'bollLower'].forEach((key) => {
            if (!Number.isFinite(Number(ind[key]))) throw new Error('指标 ' + key + ' 不是有效数字');
          });
          return '趋势=' + res.trend + ' · MA20 ' + Number(ind.ma20).toFixed(2) + ' · RSI14 ' + Number(ind.rsi14).toFixed(1) + ' · BOLL ' + Number(ind.bollLower).toFixed(2) + '-' + Number(ind.bollUpper).toFixed(2);
        }
      },
      {
        name: '期货行情解析',
        level: 'local',
        run() {
          const text = 'var hq_str_nf_CF0="棉花连续,150000,15825.000,15905.000,15785.000,15835.000,15835.000,15840.000,15835.000,15840.000,15795.000,1,256,547146.000,256818,郑,棉花,2026-09-24,1";';
          const cf = futures.parseSinaFutures(text).find((r) => r.symbol === 'CF0');
          if (!cf || cf.last !== 15835) throw new Error('棉花 CF0 解析结果不对');
          return '棉花 CF0 收盘 ' + cf.last + ' · 涨跌 ' + cf.change;
        }
      },
      {
        name: '煤炭库存 / 进口抽取',
        level: 'local',
        run() {
          const stamp = new Date().toISOString();
          const items = [
            { title: '环渤海港口煤炭库存下降', summary: '截至本周，秦皇岛港煤炭库存512万吨，较上周下降18万吨。', timestamp: stamp },
            { title: '海关总署：8月份，我国进口煤炭4209万吨', summary: '8月份，我国进口煤炭4209万吨，同比减少1.5%。', timestamp: stamp }
          ];
          const inv = coal.extractFromNews(items);
          const imp = coalImport.extractFromNews(items);
          if (!inv.inventoryPoints.length && !imp.importPoints.length) throw new Error('新闻抽取没有命中任何读数');
          return '库存读数 ' + inv.inventoryPoints.length + ' 条 · 进口读数 ' + imp.importPoints.length + ' 条';
        }
      },
      {
        name: '选股建议规则',
        level: 'local',
        run() {
          const agg = advice.scoreOf([{ status: 'pass' }, { status: 'pass' }, { status: 'warn' }, { status: 'fail' }, { status: 'na' }]);
          if (agg.score !== 4 - 1 - 3) throw new Error('评分口径不对: ' + agg.score);
          const checks = advice.runRules(advice.buildContext(syntheticBars(120, 1)));
          if (checks.length !== 8) throw new Error('规则条数应为 8，实际 ' + checks.length);
          const lv = advice.keyLevels(syntheticBars(120, 1));
          if (!(lv.refStop < lv.last && lv.maxPositionPct <= 30)) throw new Error('支撑压力/止损/仓位上限异常');
          return '8 条规则 · 参考止损 ' + lv.refStop + '（' + lv.stopPct.toFixed(2) + '%）· 仓位上限 ' + lv.maxPositionPct + '%';
        }
      },
      {
        name: '个股体检手册',
        level: 'local',
        run() {
          const rules = analysis.PLAYBOOK_RULES || [];
          if (!rules.length) throw new Error('PLAYBOOK_RULES 为空');
          return rules.length + ' 条规则：' + rules.slice(0, 4).map((r) => r.label || r.id).join(' / ') + ' …';
        }
      }
    ]
  },
  {
    group: '窗口与程序外壳',
    checks: [
      {
        name: '窗口代理脚本',
        level: 'local',
        run() {
          const cap = windowBridge.capabilities();
          if (!cap.supported) throw new Error('窗口代理不可用（脚本缺失或系统不是 Windows）');
          return '桌面端可用：最小化 / 最大化 / 还原 / 关闭 / 置顶（白名单指令 ' + cap.actions.length + ' 个）';
        }
      },
      {
        name: '窗口指令连通性',
        level: 'full',
        async run() {
          const res = await windowBridge.request('state');
          const n = Number(res.count || 0);
          if (n === 0) return '代理正常应答，当前没有打开的工作站窗口（用桌面快捷方式启动后可点标题栏按钮）';
          return '代理正常应答，找到 ' + n + ' 个工作站窗口';
        }
      }
    ]
  },
  {
    group: 'HTTP 接口',
    checks: [
      {
        name: '首页与静态资源',
        level: 'full',
        async run() {
          const home = await fetchText(BASE + '/');
          if (home.status !== 200 || home.text.indexOf('工作站') < 0) throw new Error('首页返回 ' + home.status);
          const css = await fetchText(BASE + '/styles.css');
          const js = await fetchText(BASE + '/app.js');
          if (css.status !== 200 || js.status !== 200) throw new Error('样式/脚本返回 ' + css.status + '/' + js.status);
          return 'index.html + styles.css + app.js 均可访问（HTTP 200）';
        }
      },
      {
        name: '手机访问资源（manifest / 离线外壳 / 图标）',
        level: 'full',
        async run() {
          const man = await fetchJson(BASE + '/manifest.webmanifest');
          if (man.status !== 200 || !man.json || !man.json.name) throw new Error('manifest 取不到或不是合法 JSON（HTTP ' + man.status + '）');
          if (man.json.display !== 'standalone') throw new Error('manifest 的 display 不是 standalone，手机上不会全屏');
          const icons = man.json.icons || [];
          for (const icon of icons) {
            const got = await fetchText(BASE + icon.src);
            if (got.status !== 200) throw new Error('清单里的图标取不到：' + icon.src + '（HTTP ' + got.status + '）');
          }
          const sw = await fetchText(BASE + '/sw.js');
          if (sw.status !== 200) throw new Error('/sw.js 取不到（HTTP ' + sw.status + '）');
          if (sw.text.indexOf("startsWith('/api/')") < 0) throw new Error('离线外壳没有排除 /api/，会把行情写进缓存当新数据用');
          return 'manifest + sw.js + ' + icons.length + ' 个图标均可访问，display=' + man.json.display;
        }
      },
      {
        name: '局域网地址与二维码（手机访问）',
        level: 'full',
        async run() {
          const net = await fetchJson(BASE + '/api/net');
          if (net.status !== 200 || !net.json) throw new Error('/api/net 异常（HTTP ' + net.status + '）');
          const j = net.json;
          if (!j.lanExposed) throw new Error('服务当前只监听 ' + j.host + '，手机一定连不上；用「启动工作站」默认启动即可（默认监听 0.0.0.0）');
          if (!j.primary) throw new Error('没有检测到可用的局域网地址（这台电脑可能没连 Wi-Fi / 网线），手机暂时访问不到');
          if (!j.qr || !/^<svg /.test(j.qr.svg)) throw new Error('二维码没有生成');
          if (j.qr.url !== j.primary.url) throw new Error('二维码内容与首选地址不一致');
          return '手机地址 ' + j.primary.url + '（' + j.primary.iface + '）· 二维码 v' + j.qr.version + '/' + j.qr.ecLevel + ' ' + j.qr.size + '×' + j.qr.size;
        }
      },
      {
        name: '健康检查与知识库接口',
        level: 'full',
        async run() {
          const health = await fetchJson(BASE + '/api/health');
          if (!health.json || health.json.ok !== true) throw new Error('/api/health 没有返回 ok');
          const kn = await fetchJson(BASE + '/api/knowledge');
          if (kn.status !== 200) throw new Error('/api/knowledge 返回 ' + kn.status);
          return '/api/health ok · 缓存 ' + (health.json.cache || []).length + ' 项';
        }
      },
      {
        name: '总览 / 自选股接口',
        level: 'full',
        async run() {
          const ov = await fetchJson(BASE + '/api/overview', 30000);
          if (ov.status !== 200 || !ov.json || !ov.json.watchlist) throw new Error('/api/overview 异常（' + ov.status + '）');
          const priced = ov.json.watchlist.filter((s) => s.quote).length;
          return '自选股 ' + ov.json.watchlist.length + ' 只，其中 ' + priced + ' 只有实时报价';
        }
      },
      {
        name: '选股建议 / 走势分析接口',
        level: 'full',
        async run() {
          const trend = await fetchJson(BASE + '/api/trend/600519', 30000);
          if (trend.status !== 200 || !trend.json) throw new Error('/api/trend 异常（' + trend.status + '）');
          if (!trend.json.ready) throw new Error('/api/trend 未就绪：' + (trend.json.error || ''));
          const adv = await fetchJson(BASE + '/api/advice?preset=momentum&limit=3&pages=1', 90000);
          if (adv.status !== 200 || !adv.json) throw new Error('/api/advice 异常（' + adv.status + '）');
          const picks = (adv.json.results || []).length;
          if (!adv.json.scanned) throw new Error('/api/advice 没有扫描到任何行情（数据源可能不可用）');
          if (!picks) throw new Error('/api/advice 扫描 ' + adv.json.scanned + ' 只但没有产出候选');
          const hz = trend.json.horizons || { short: {}, mid: {} };
          return '贵州茅台走势 短期' + (hz.short.verdict || '—') + ' / 中期' + (hz.mid.verdict || '—') +
            ' · 选股建议 ' + picks + ' 条候选（扫描 ' + adv.json.scanned + ' 只' + (adv.json.relaxed ? '，已放宽条件' : '') + '）';
        }
      },
      {
        name: '煤炭 / 股吧接口',
        level: 'full',
        async run() {
          const inv = await fetchJson(BASE + '/api/coal/inventory', 20000);
          if (inv.status !== 200) throw new Error('/api/coal/inventory 返回 ' + inv.status);
          const imp = await fetchJson(BASE + '/api/coal/import', 20000);
          if (imp.status !== 200) throw new Error('/api/coal/import 返回 ' + imp.status);
          const gb = await fetchJson(BASE + '/api/guba/600036?limit=10', 25000);
          const posts = gb.json && gb.json.posts ? gb.json.posts.length : 0;
          return '库存 ' + inv.json.ports.length + ' 港 · 进口 ' + imp.json.groups.length + ' 品种 · 招商银行股吧 ' + posts + ' 帖';
        }
      }
    ]
  },
  {
    group: '外部数据源',
    checks: [
      {
        name: '财联社电报',
        level: 'full',
        async run() {
          const items = await withTimeout(cls.fetchTelegraph(10), 20000, '财联社');
          if (!items.length) throw new Error('没有取到电报');
          return items.length + ' 条 · 最新「' + String(items[0].title || '').slice(0, 28) + '」';
        }
      },
      {
        name: '东方财富 7×24',
        level: 'full',
        async run() {
          const items = await withTimeout(news.fetchEmFastNews(), 20000, '东财 7x24');
          if (!items.length) throw new Error('没有取到快讯');
          return items.length + ' 条 · 最新「' + String(items[0].title || '').slice(0, 28) + '」';
        }
      },
      {
        name: '同花顺要闻',
        level: 'full',
        async run() {
          const feed = await withTimeout(news.getSourceFeed('ths', 20), 20000, '同花顺');
          const n = countNews(feed);
          if (!n) throw new Error('没有取到要闻');
          return n + ' 条要闻';
        }
      },
      {
        name: '新浪财经滚动',
        level: 'full',
        async run() {
          const feed = await withTimeout(news.getSourceFeed('sina', 20), 20000, '新浪财经');
          const n = countNews(feed);
          if (!n) throw new Error('没有取到滚动新闻');
          return n + ' 条滚动新闻';
        }
      },
      {
        name: '华尔街见闻 / 金十数据',
        level: 'full',
        async run() {
          const g = await withTimeout(globalFeed.getGlobalFeed(20), 25000, '全球快讯');
          const n = countNews(g);
          if (!n) throw new Error('没有取到全球快讯');
          return n + ' 条全球快讯（彭博社为订阅制且本机不可达，用这两家替代）';
        }
      },
      {
        name: '新浪指数与全市场涨跌',
        level: 'full',
        async run() {
          const idx = await withTimeout(quotes.getIndexes(), 20000, '指数');
          if (!idx.length) throw new Error('没有取到指数');
          return idx.slice(0, 3).map((i) => i.name + ' ' + i.price).join(' · ');
        }
      },
      {
        name: '棉花期货（CF 主连）',
        level: 'full',
        async run() {
          const rows = await withTimeout(futures.getFuturesRealtime(), 20000, '期货');
          const cf = rows.find((r) => r.symbol === 'CF0');
          if (!cf || !cf.available) throw new Error('棉花 CF0 不可用');
          return '棉花 CF0 ' + cf.last + '（' + (cf.change >= 0 ? '+' : '') + cf.change + '，' + cf.changePct + '%）';
        }
      },
      {
        name: '同花顺个股行情 / 日线',
        level: 'full',
        async run() {
          const q = await withTimeout(ths.fetchQuote('600519'), 20000, '同花顺行情');
          const k = await withTimeout(ths.fetchDaily('600519', 260), 25000, '同花顺日线');
          if (!q || !q.price) throw new Error('贵州茅台实时行情为空');
          const bars = (k && k.rows) || [];
          if (bars.length < 120) throw new Error('日线只有 ' + bars.length + ' 根，不足以算中期指标');
          return '贵州茅台 ' + q.price + ' · 日线 ' + bars.length + ' 根（最近 ' + bars[bars.length - 1].date + '）';
        }
      },
      {
        name: '新浪股吧',
        level: 'full',
        async run() {
          const board = await withTimeout(guba.fetchBoard('600036', 20), 25000, '股吧');
          const n = board && board.posts ? board.posts.length : 0;
          if (!n) throw new Error('招商银行股吧没有取到帖子');
          return '招商银行股吧 ' + n + ' 帖 · 情绪分 ' + (board.sentiment ? board.sentiment.score : '—');
        }
      },
      {
        name: '选股器股票池',
        level: 'full',
        async run() {
          const res = await withTimeout(screener.screen({ preset: 'momentum', limit: 5, pages: 1 }), 45000, '选股器');
          const n = (res.results || []).length;
          if (!res.scanned) throw new Error('选股器没有扫描到行情');
          return '扫描 ' + res.scanned + ' 只 / 命中 ' + n + ' 只（来源：' + res.source + '）' + (n ? '' : '——严格条件今日无命中属正常');
        }
      },
      {
        name: '煤炭新闻抽取（联网）',
        level: 'full',
        async run() {
          const feed = await withTimeout(news.getNewsFeed({ topics: ['coal'], limit: 60 }), 30000, '煤炭新闻');
          const inv = coal.extractFromNews(feed.items);
          const imp = coalImport.extractFromNews(feed.items);
          return '扫描 ' + feed.items.length + ' 条煤炭新闻，抽出库存读数 ' + inv.inventoryPoints.length + ' / 进口读数 ' + imp.importPoints.length + '（需人工复核）';
        }
      },
      {
        name: '市场广度与资金流',
        level: 'full',
        async run() {
          const breadth = await withTimeout(market.getBreadth(), 25000, '涨跌家数');
          if (!breadth) throw new Error('涨跌家数不可用');
          return '上涨 ' + breadth.up + ' / 下跌 ' + breadth.down + '（新浪财经）';
        }
      },
      {
        name: '英文快讯机翻',
        level: 'full',
        async run() {
          // 固定句子：第一次翻完就进缓存，之后每次自检都是命中缓存，不浪费免费接口的额度
          const probe = 'Cotton futures rose on strong export demand.';
          const r = await withTimeout(translate.translateText(probe), 20000, '机器翻译');
          if (!r || !r.zh) {
            const st = translate.stats();
            const why = Object.keys(st.providers).map((k) => k + ': ' + (st.providers[k].lastError || '未知')).join('；');
            throw new Error('两个免费翻译源都没成功（' + (why || '尚未尝试') + '），英文快讯会显示原文并标注未翻译');
          }
          const st = translate.stats();
          return r.zh + '（' + r.provider + (r.cached ? ' · 命中缓存' : ' · 本次新翻') +
            '；缓存 ' + st.cached + ' 条）';
        }
      },
      {
        name: '金融界嵌入页（大盘云图）',
        level: 'full',
        async run() {
          const r = await withTimeout(embed.preflight('dpyt'), 20000, '金融界大盘云图');
          if (!r.reachable) throw new Error(r.error || '连不上金融界');
          if (!r.ok) throw new Error(r.error || '金融界返回异常状态');
          if (!r.frameable) throw new Error('对方已禁止被嵌入（' + r.blockedBy + '），界面会改为提示在新窗口打开');
          return 'HTTP ' + r.status + ' · 允许嵌入（' + r.ms + 'ms）';
        }
      }
    ]
  }
];

/* --------------------------------- 执行 --------------------------------- */

function levelEnabled(level, scope) {
  if (level === 'local') return true;
  return scope === 'full';
}

async function run(options) {
  const scope = options && options.scope === 'full' ? 'full' : 'local';
  const startedAt = new Date();
  const t0 = Date.now();
  const groups = [];
  const flat = [];

  for (const g of GROUPS) {
    const results = [];
    for (const c of g.checks) {
      const started = Date.now();
      if (!levelEnabled(c.level, scope)) {
        const item = { name: c.name, status: 'skip', detail: '未执行：需要联网或启动窗口代理，点「完整自检（联网）」可覆盖', ms: 0 };
        results.push(item);
        flat.push(item);
        continue;
      }
      try {
        const detail = await withTimeout(Promise.resolve().then(() => c.run()), c.timeout || 30000, c.name);
        const item = { name: c.name, status: 'ok', detail: String(detail === undefined || detail === null ? '' : detail), ms: Date.now() - started };
        results.push(item);
        flat.push(item);
      } catch (err) {
        const item = { name: c.name, status: 'fail', detail: String((err && err.message) || err), ms: Date.now() - started };
        results.push(item);
        flat.push(item);
      }
    }
    groups.push({ group: g.group, checks: results });
  }

  const ok = flat.filter((c) => c.status === 'ok').length;
  const fail = flat.filter((c) => c.status === 'fail').length;
  const skip = flat.filter((c) => c.status === 'skip').length;
  return {
    scope,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - t0,
    summary: { total: flat.length, ok, fail, skip, pass: fail === 0 },
    groups,
    window: windowBridge.capabilities(),
    note: scope === 'full'
      ? '已包含联网检查。外部数据源可能因对方风控或网络波动偶发失败，失败项会在下面单独列出——失败只代表「这次没取到」，不代表数据源永远不可用。'
      : '快速自检只覆盖本机文件、台账与算法（秒级）。要检查新闻、行情、股吧等联网数据源，请点右上角「完整自检（联网）」。'
  };
}

module.exports = { run, GROUPS };
