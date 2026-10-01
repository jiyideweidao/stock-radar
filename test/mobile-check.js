'use strict';
/**
 * 手机端验收：用 412x915 的安卓典型视口跑一遍，确认布局真的能看能用。
 *
 * 重点查三件事（这三件做错了，手机上就是「打不开 / 看不全 / 点不动」）：
 *   1) 页面不能横向溢出 —— 溢出后整页会左右晃，图表和表格全看不全；
 *   2) 页签栏必须固定在屏幕底部 —— 手机上没人在顶部找导航；
 *   3) 按钮命中区要够大、输入框字号要够 —— 手指点不中比看不了更让人恼火。
 *
 * 另外把「手机访问」弹窗里的二维码截出来核对（有 jsQR 时顺便真解码一次）。
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = path.join(__dirname, '..', 'screenshots');
const PHONE = { width: 412, height: 915 };   // 安卓主流尺寸（Pixel / 小米 / 华为都在这个量级）

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({
    viewport: PHONE,
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36'
  });

  const problems = [];
  // 4xx / 网络失败按「状态码 + URL」去重计数：Chromium 控制台那条
  // 「Failed to load resource」不带 URL，一次能刷十几条，只报它等于没报。
  const httpBad = new Map();
  page.on('pageerror', (e) => problems.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/i.test(t)) return;   // 交给下面的 response 监听，带 URL 报
    problems.push('CONSOLE: ' + t);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const k = 'HTTP ' + r.status() + ' ' + r.url();
    httpBad.set(k, (httpBad.get(k) || 0) + 1);
  });
  page.on('requestfailed', (r) => {
    const k = 'NETFAIL ' + r.url() + ' :: ' + ((r.failure() && r.failure().errorText) || '');
    httpBad.set(k, (httpBad.get(k) || 0) + 1);
  });

  await page.goto(BASE + '/?app=1&from=pwa', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(4000);

  // ---------- 1) 不横向溢出 ----------
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    win: window.innerWidth
  }));
  console.log('横向宽度: 文档 ' + overflow.doc + ' / body ' + overflow.body + ' / 视口 ' + overflow.win);
  if (overflow.doc > overflow.win + 1) problems.push('LAYOUT: 页面横向溢出 ' + (overflow.doc - overflow.win) + 'px（手机上会左右晃）');

  // 找出到底是谁溢出了，报出来才好修
  if (overflow.doc > overflow.win + 1) {
    const culprits = await page.evaluate(() => {
      const w = window.innerWidth;
      const out = [];
      document.querySelectorAll('body *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > w + 1 && el.children.length < 40) {
          out.push((el.id ? '#' + el.id : el.className ? '.' + String(el.className).split(' ')[0] : el.tagName) + ' 右边 ' + Math.round(r.right));
        }
      });
      return out.slice(0, 8);
    });
    console.log('  溢出嫌疑元素: ' + JSON.stringify(culprits));
  }

  // ---------- 2) 页签栏固定在底部 ----------
  const tabs = await page.evaluate(() => {
    const el = document.querySelector('nav.tabs');
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const btns = Array.from(el.querySelectorAll('button')).map((b) => b.getBoundingClientRect().height);
    return {
      position: cs.position,
      bottomGap: Math.round(window.innerHeight - r.bottom),
      height: Math.round(r.height),
      scrollable: el.scrollWidth > el.clientWidth,
      minBtnH: Math.round(Math.min.apply(null, btns)),
      btnCount: btns.length
    };
  });
  console.log('页签栏: ' + JSON.stringify(tabs));
  if (tabs.position !== 'fixed') problems.push('MWEB: 页签栏没有固定定位（' + tabs.position + '）');
  if (tabs.bottomGap > 2) problems.push('MWEB: 页签栏没贴到屏幕底部（还差 ' + tabs.bottomGap + 'px）');
  if (tabs.minBtnH < 42) problems.push('MWEB: 页签按钮高度只有 ' + tabs.minBtnH + 'px，手指容易点错');

  // ---------- 3) 单列布局 ----------
  // 这里必须先切到目标页再量，不能用 display:none 子树的 gridTemplateColumns 去数空格：
  // 未参与布局的元素返回的是「指定值」，minmax(0px, 1fr) 会被切成 2 段，
  // 于是把「整页 412px、单列 388px」的正确布局误报成「还是 2 列」。
  // 可靠口径：切到该页后，数子元素真实左侧坐标有几个不同值 = 实际有几列。
  const measureCols = async (viewId, sel) => {
    await page.evaluate((v) => {
      const b = document.querySelector('#tabs button[data-view="' + v + '"]');
      if (b) b.scrollIntoView({ block: 'nearest', inline: 'center' });
    }, viewId);
    await page.click('#tabs button[data-view="' + viewId + '"]');
    await page.waitForTimeout(1500);
    return page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const kids = [...el.children].filter((c) => c.getBoundingClientRect().width > 0);
      if (!kids.length) return null;
      return new Set(kids.map((c) => Math.round(c.getBoundingClientRect().left))).size;
    }, sel);
  };
  const grids = {
    watchCards: await measureCols('overview', '#watchCards'),
    cols3: await measureCols('overview', '#view-overview .grid.cols-3'),
    cols2: await measureCols('stocks', '#view-stocks .grid.cols-2')
  };
  console.log('网格列数: ' + JSON.stringify(grids));
  for (const [k, v] of Object.entries(grids)) {
    if (v && v > 1) problems.push('MWEB: ' + k + ' 在手机视口下仍是 ' + v + ' 列，应该降为单列');
  }

  // ---------- 4) 桌面专属元素应隐藏 ----------
  const hidden = await page.evaluate(() => ({
    winControls: getComputedStyle(document.querySelector('.win-controls')).display,
    netPanel: getComputedStyle(document.querySelector('#netPanel')).display,
    menubarStatus: getComputedStyle(document.querySelector('.menubar-status')).display
  }));
  console.log('手机端隐藏项: ' + JSON.stringify(hidden));
  if (hidden.winControls !== 'none') problems.push('MWEB: 顶栏窗口按钮在手机上还显示着');
  if (hidden.netPanel !== 'none') problems.push('MWEB: 总览的「手机访问」卡片在手机上还显示着');

  // ---------- 5) 表格横向滚动 ----------
  const tables = await page.evaluate(() => {
    const wrap = document.querySelector('#stockTable .table-scroll');
    if (!wrap) return null;
    return { wrapped: true, scrollable: wrap.scrollWidth > wrap.clientWidth + 1, w: Math.round(wrap.clientWidth) };
  });
  console.log('行情表容器: ' + JSON.stringify(tables));
  if (!tables || !tables.wrapped) problems.push('MWEB: 行情表没有被包进 .table-scroll，窄屏会挤压列宽');

  // ---------- 6) 输入框字号 ----------
  const inputFont = await page.evaluate(() => {
    const el = document.querySelector('#gubaCode') || document.querySelector('input');
    return el ? parseFloat(getComputedStyle(el).fontSize) : null;
  });
  console.log('输入框字号: ' + inputFont + 'px');
  if (inputFont && inputFont < 16) problems.push('MWEB: 输入框字号 ' + inputFont + 'px，移动端会整页放大');

  // ---------- 7) 逐个页签截图 ----------
  const TABS = ['overview', 'stocks', 'news', 'screener', 'advice', 'guba', 'commodity', 'coal', 'knowledge'];
  for (const id of TABS) {
    // 底部页签栏横向可滑，先滚进可视区再点（这也是真实用户要做的手势）
    await page.evaluate((view) => {
      const b = document.querySelector('#tabs button[data-view="' + view + '"]');
      if (b) b.scrollIntoView({ block: 'nearest', inline: 'center' });
    }, id);
    await page.click('#tabs button[data-view="' + id + '"]');
    await page.waitForTimeout(id === 'advice' ? 32000 : 6500);
    const probe = await page.evaluate(() => {
      const active = document.querySelector('.view.active');
      const w = window.innerWidth;
      const bad = [];
      active.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > w + 1 && el.children.length === 0) {
          bad.push((el.className ? '.' + String(el.className).split(' ')[0] : el.tagName) + '@' + Math.round(r.right));
        }
      });
      return { text: active.innerText.trim().length, overflowNodes: bad.slice(0, 4), scrollW: document.documentElement.scrollWidth };
    });
    await page.screenshot({ path: path.join(OUT, 'mobile-' + id + '.png'), fullPage: true });
    if (probe.scrollW > PHONE.width + 1) problems.push('MWEB: 页签 ' + id + ' 横向溢出到 ' + probe.scrollW + 'px ' + JSON.stringify(probe.overflowNodes));
    if (probe.text < 40) problems.push('MWEB: 页签 ' + id + ' 内容几乎是空的');
    console.log('  -> ' + id + ' 文本 ' + probe.text + ' 宽 ' + probe.scrollW + (probe.overflowNodes.length ? ' 溢出: ' + JSON.stringify(probe.overflowNodes) : ''));
  }

  // ---------- 8) 手机访问弹窗 + 二维码 ----------
  // 不能用 :last-of-type 定位「帮助」菜单：#menubar 的最后一个 div 子元素是
  // .menubar-status，所以 .menu:last-of-type 匹配不到任何菜单。用菜单内的独特按钮反查。
  await page.click('#menubar .menu:has(button[data-act="netPanel"]) .menu-title');
  await page.waitForTimeout(400);
  const menuBox = await page.evaluate(() => {
    const open = document.querySelector('#menubar .menu.open .menu-list');
    if (!open) return null;
    const r = open.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), win: window.innerWidth, items: open.querySelectorAll('button').length };
  });
  console.log('「帮助」菜单: ' + JSON.stringify(menuBox));
  if (!menuBox) problems.push('MWEB: 菜单打不开');
  else if (menuBox.right > menuBox.win + 1) problems.push('MWEB: 菜单下拉超出屏幕右侧 ' + (menuBox.right - menuBox.win) + 'px');

  await page.click('#menubar [data-act="netPanel"]');
  await page.waitForTimeout(2500);
  const qr = await page.evaluate(() => {
    const box = document.querySelector('#netModal .qr-box svg');
    const code = document.querySelector('#netModal .net-url code');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), url: code ? code.textContent.trim() : '' };
  });
  console.log('二维码元素: ' + JSON.stringify(qr));
  if (!qr) problems.push('MWEB: 手机访问弹窗里没有二维码');
  else {
    if (qr.w < 120) problems.push('MWEB: 二维码显示得太小（' + qr.w + 'px），手机不好扫');
    if (!/^http:\/\/\d/.test(qr.url)) problems.push('MWEB: 弹窗里没给出局域网地址 -> ' + qr.url);
    const shot = path.join(OUT, 'mobile-net-qr.png');
    await page.locator('#netModal .qr-box').screenshot({ path: shot });
    console.log('  二维码截图: ' + shot);
    // 有 jsQR 就真解码一次，确认屏幕上这个码扫得出来
    const decoderDir = process.env.QR_DECODER;
    if (decoderDir) {
      try {
        const jsQR = require(decoderDir);
        const { PNG } = require(process.env.PNG_DIR || decoderDir);
        const png = PNG.sync.read(fs.readFileSync(shot));
        const res = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
        const got = res ? res.data : null;
        console.log('  解码结果: ' + JSON.stringify(got) + ' | 期望: ' + JSON.stringify(qr.url));
        if (got !== qr.url) problems.push('QR: 页面上渲染出来的二维码扫不出正确地址 -> ' + JSON.stringify(got));
      } catch (err) {
        console.log('  解码跳过（' + err.message + '）');
      }
    } else {
      console.log('  解码跳过（未提供 QR_DECODER）');
    }
  }
  await page.screenshot({ path: path.join(OUT, 'mobile-net-modal.png'), fullPage: false });
  await page.click('#netClose');
  await page.waitForTimeout(400);

  for (const [k, n] of httpBad) problems.push(k + (n > 1 ? '  ×' + n : ''));
  console.log('');
  console.log('手机端问题数: ' + problems.length);
  problems.slice(0, 25).forEach((p) => console.log('  ' + p));
  await browser.close();
  if (problems.length) process.exitCode = 1;
})().catch((err) => { console.error('手机端验收脚本失败: ' + err.message); process.exit(1); });
