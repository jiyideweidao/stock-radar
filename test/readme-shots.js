'use strict';
/**
 * 生成 README「界面预览」与 GitHub 社交预览用的图片。
 * 依赖：playwright-core + 本机 Edge（与 visual-check.js / mobile-check.js 同一套）。
 * 用法：先 npm start 起服务，再 npm run shots
 *       SHOTS_ONLY=social npm run shots   # 只重出社交预览图，不重截界面
 * 输出：docs/images/*.jpg（桌面 1600x1000、手机 824x1830）+ docs/images/social-preview.png（1280x640）
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = path.join(__dirname, '..', 'docs', 'images');
const ONLY = process.env.SHOTS_ONLY || 'all';
const DESKTOP = { width: 1600, height: 1000 };
const PHONE = { width: 412, height: 915 };

// [页签 id, 输出文件名, 等待毫秒]——选股建议要跑十几只股票的技术面体检，给足时间
const TABS = [
  ['overview', 'overview', 5000],
  ['stocks', 'stocks', 6000],
  ['news', 'news', 11000],
  ['screener', 'screener', 13000],
  ['advice', 'advice', 60000],
  ['guba', 'guba', 13000],
  ['commodity', 'commodity', 11000],
  ['coal', 'coal', 11000],
  ['knowledge', 'knowledge', 9000]
];

const want = (name) => ONLY === 'all' || ONLY === name;

/** 无头 Edge 偶发启动失败（进程秒退），重试几次即可。 */
async function launch() {
  let last = null;
  for (let i = 1; i <= 5; i += 1) {
    try {
      return await chromium.launch({ executablePath: EDGE, headless: true, args: ['--disable-gpu'] });
    } catch (err) {
      last = err;
      console.log('  启动 Edge 第 ' + i + ' 次失败：' + err.message);
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw last;
}

const shoot = (page, file) => page.screenshot({ path: path.join(OUT, file + '.jpg'), type: 'jpeg', quality: 82 });

/** 社交预览卡片：左文右图，文字列限宽 620px，页脚定位在 body 上（放在 .wrap 里会被当成相对定位基准）。 */
function socialHtml(shotBase64, chips) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>' +
    '*{box-sizing:border-box;margin:0;padding:0}' +
    'html,body{width:1280px;height:640px}' +
    'body{position:relative;background:#0b1017;color:#e6edf6;font-family:"Microsoft YaHei","Segoe UI",sans-serif;overflow:hidden}' +
    '.glow{position:absolute;width:760px;height:760px;right:-240px;top:-320px;border-radius:50%;background:radial-gradient(circle,rgba(224,64,64,.30),rgba(224,64,64,0) 62%)}' +
    '.glow2{position:absolute;width:620px;height:620px;left:-260px;bottom:-340px;border-radius:50%;background:radial-gradient(circle,rgba(34,168,120,.26),rgba(34,168,120,0) 62%)}' +
    '.wrap{position:relative;padding:52px 0 0 56px;width:700px}' +
    'h1{font-size:50px;line-height:1.12;letter-spacing:1px}' +
    'h1 em{font-style:normal;color:#ff5d5d}' +
    '.sub{margin-top:14px;font-size:18px;line-height:1.55;color:#93a3b8;max-width:640px}' +
    '.chips{margin-top:26px;display:flex;flex-wrap:wrap;gap:10px;max-width:600px}' +
    '.chip{font-size:15px;padding:7px 15px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.13);color:#c9d6e6}' +
    '.shot{position:absolute;right:56px;top:50%;transform:translateY(-50%);width:500px;border-radius:12px;border:1px solid rgba(255,255,255,.16);box-shadow:0 20px 60px rgba(0,0,0,.6);overflow:hidden}' +
    '.shot img{display:block;width:100%}' +
    '.foot{position:absolute;left:56px;bottom:46px;font-size:15px;color:#6f8299}' +
    '</style></head><body><div class="glow"></div><div class="glow2"></div>' +
    '<div class="wrap"><h1>股民<em>舆情</em>与商品看板</h1>' +
    '<div class="sub">A 股舆情 · 自选股体检 · 选股建议 · 棉花与煤炭价格，一个工作站看全</div>' +
    '<div class="chips">' + chips + '</div></div>' +
    '<div class="shot"><img src="data:image/jpeg;base64,' + shotBase64 + '"></div>' +
    '<div class="foot">Node + 原生前端 · 无第三方运行时依赖 · 数据全部来自公开来源</div>' +
    '</body></html>';
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const errors = [];

  // ---------- 桌面：1600x1000 固定视口 ----------
  if (want('desktop')) {
    const page = await browser.newPage({ viewport: DESKTOP, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });

    for (const [id, file, waitMs] of TABS) {
      await page.click('#tabs button[data-view="' + id + '"]');
      await page.waitForTimeout(waitMs);
      await shoot(page, file);
      const text = await page.evaluate(() => {
        const a = document.querySelector('.view.active');
        return a ? a.innerText.trim().length : 0;
      });
      console.log('  -> ' + file + '.jpg 文本 ' + text + (text < 40 ? '  !! 疑似空白' : ''));
    }

    // 个股体检：从自选股点第一行进（菜单里已没有该入口）
    await page.click('#tabs button[data-view="stocks"]');
    await page.waitForTimeout(2000);
    const row = await page.$('#stockTable tbody tr');
    if (!row) throw new Error('自选股行情表没有数据行，无法截「个股体检」');
    await row.click();
    await page.waitForTimeout(15000);
    const analysis = await page.evaluate(() => ({
      view: (document.querySelector('.view.active') || {}).id,
      title: (document.querySelector('#analysisTitle') || {}).textContent || ''
    }));
    console.log('  -> analysis.jpg 页签=' + analysis.view + ' 标题=' + analysis.title.trim());
    await shoot(page, 'analysis');
  }

  // ---------- 手机：412x915 @2x ----------
  if (want('mobile')) {
    const phone = await browser.newPage({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await phone.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
    for (const [id, file, waitMs] of [['overview', 'mobile-overview', 5000], ['stocks', 'mobile-stocks', 6000]]) {
      await phone.evaluate((view) => {
        const b = document.querySelector('#tabs button[data-view="' + view + '"]');
        if (b) b.scrollIntoView({ block: 'nearest', inline: 'center' });
      }, id);
      await phone.click('#tabs button[data-view="' + id + '"]');
      await phone.waitForTimeout(waitMs);
      await shoot(phone, file);
      console.log('  -> ' + file + '.jpg 完成');
    }
  }

  // ---------- GitHub 社交预览 1280x640 ----------
  if (want('social')) {
    const social = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
    const shot = fs.readFileSync(path.join(OUT, 'overview.jpg')).toString('base64');
    const chips = ['舆情新闻聚合', '自选股与个股体检', '选股器 / 选股建议', '棉花与大宗商品', '煤炭库存与进口', '交易知识库']
      .map((t) => '<span class="chip">' + t + '</span>').join('');
    await social.setContent(socialHtml(shot, chips), { waitUntil: 'load' });
    await social.waitForTimeout(700);
    await social.screenshot({ path: path.join(OUT, 'social-preview.png'), type: 'png' });
    console.log('  -> social-preview.png 完成');
  }

  await browser.close();
  const bad = errors.filter((e) => !/favicon|ERR_/.test(e));
  console.log('');
  console.log('完成（' + ONLY + '），控制台错误 ' + bad.length + ' 条');
  bad.slice(0, 10).forEach((e) => console.log('  ' + e));
})().catch((err) => { console.error('截图脚本失败: ' + err.message); process.exit(1); });
