'use strict';
/** 前端验收：启动无头 Edge，逐页签截图并收集控制台错误。 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = path.join(__dirname, '..', 'screenshots');

// [页签 id, 名称, 等待毫秒]——选股建议要跑十几只股票的技术面体检，给足时间
const TABS = [
  ['overview', '总览', 5000],
  ['stocks', '自选股', 5000],
  ['embed', '大盘云图（金融界嵌入）', 14000],
  ['news', '舆情新闻', 10000],
  ['sources', '数据源浏览', 10000],
  ['screener', '选股器', 12000],
  ['advice', '选股建议', 60000],
  ['guba', '股吧', 12000],
  ['commodity', '棉花大宗商品', 10000],
  ['coal', '煤炭库存与进口', 10000],
  ['knowledge', '交易知识库', 8000]
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });

  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });

  for (const [id, label, waitMs] of TABS) {
    await page.click('#tabs button[data-view="' + id + '"]');
    await page.waitForTimeout(waitMs);
    await page.screenshot({ path: path.join(OUT, id + '.png'), fullPage: true });

    const probe = await page.evaluate(() => {
      const active = document.querySelector('.view.active');
      const rows = active ? active.querySelectorAll('table tbody tr').length : 0;
      const cards = active ? active.querySelectorAll('.card, .check, .news-list li').length : 0;
      return { rows, blocks: cards, text: active ? active.innerText.trim().length : 0 };
    });
    if (probe.blocks === 0 || probe.text < 40) console.log('  !! ' + id + ' 内容疑似为空: ' + JSON.stringify(probe));
    console.log('  -> ' + id + ' 表格行 ' + probe.rows + ' / 区块 ' + probe.blocks + ' / 文本 ' + probe.text);

    const canvases = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.view.active canvas')).map((c) => {
        const ctx = c.getContext('2d');
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4000) if (data[i] > 0) painted += 1;
        return { w: c.width, h: c.height, paintedSamples: painted };
      });
    });
    console.log('[' + id + '] ' + label + ' 截图完成 | canvas: ' + JSON.stringify(canvases));
    if (id === 'advice') {
      const cards = await page.$$('#adviceResults .advice-card');
      const meta = await page.textContent('#adviceMeta');
      console.log('  选股建议卡片数: ' + cards.length + ' | ' + (meta || '').trim().slice(0, 120));
      if (!cards.length) errors.push('EMPTY: 选股建议没有产出候选');
    }
    if (id === 'coal') {
      const rows = await page.$$eval('#importTable tbody tr, #coalTable tbody tr', (els) => els.length);
      console.log('  煤炭表格行数: ' + rows);
      if (!rows) errors.push('EMPTY: 煤炭台账没有数据行');
    }
    if (id === 'sources') {
      const items = await page.$$eval('#sourceFeed li', (els) => els.length);
      console.log('  源条目数: ' + items);
      if (items < 3) errors.push('EMPTY: 数据源浏览几乎没有条目 (' + items + ')');
    }
  }

  // 菜单栏：打开「页面」菜单并跳转一次，确认菜单可用
  await page.click('#menubar .menu:nth-child(1) .menu-title');
  await page.waitForTimeout(300);
  const menuOpen = await page.$$eval('#menubar .menu.open .menu-list button', (els) => els.length);
  console.log('菜单「页面」可见项: ' + menuOpen);
  if (!menuOpen) errors.push('MENU: 菜单没有展开');
  await page.click('#menubar [data-jump="coal"]');
  await page.waitForTimeout(1500);
  const afterJump = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
  console.log('菜单跳转后页签: ' + afterJump);
  if (afterJump !== 'view-coal') errors.push('MENU: 菜单跳转失败 -> ' + afterJump);

  // 程序外壳：窗口按钮 / 菜单栏「窗口」/ 状态栏 / 自检弹窗
  const winBtns = await page.$$eval('#winControls .win-btn', (els) => els.length);
  console.log('顶栏窗口按钮数: ' + winBtns);
  if (winBtns !== 4) errors.push('SHELL: 顶栏窗口按钮应为 4 个，实际 ' + winBtns);

  const sbService = (await page.textContent('#sbService')).trim();
  const sbSelf = (await page.textContent('#sbSelf')).trim();
  const sbMode = (await page.textContent('#sbMode')).trim();
  console.log('状态栏: ' + sbService + ' | ' + sbSelf + ' | ' + sbMode);
  if (!/服务正常/.test(sbService)) errors.push('SHELL: 状态栏没有报告服务正常 -> ' + sbService);
  if (!/自检：/.test(sbSelf)) errors.push('SHELL: 状态栏自检徽标异常 -> ' + sbSelf);

  await page.click('#menubar .menu:nth-child(4) .menu-title');
  await page.waitForTimeout(300);
  const winMenu = await page.$$eval('#menubar .menu.open .menu-list button', (els) => els.map((e) => e.textContent.trim()));
  console.log('菜单「窗口」可见项: ' + JSON.stringify(winMenu));
  if (winMenu.length < 6) errors.push('SHELL: 窗口菜单项过少 -> ' + winMenu.length);
  await page.click('#menubar [data-win="state"]');
  await page.waitForTimeout(2500);
  const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.innerText.trim()));
  console.log('窗口状态气泡: ' + JSON.stringify(toasts));
  if (!toasts.length) errors.push('SHELL: 点击窗口菜单没有给出反馈');
  if (toasts.length > 1) errors.push('SHELL: 同一次点击弹了 ' + toasts.length + ' 个气泡（重复绑定）');
  await page.screenshot({ path: path.join(OUT, 'shell-window.png'), fullPage: false });

  // 自检弹窗：从「帮助」菜单进入并跑一次快速自检
  await page.click('#menubar .menu:nth-child(5) .menu-title');
  await page.waitForTimeout(300);
  await page.click('#menubar [data-act="selfcheck"]');
  await page.waitForTimeout(5000);
  const scRows = await page.$$eval('.sc-row', (els) => els.length);
  const scSummary = (await page.textContent('.sc-summary')).replace(/\s+/g, ' ').trim();
  console.log('自检弹窗: ' + scRows + ' 行 | ' + scSummary);
  if (!scRows) errors.push('SHELL: 自检弹窗没有结果行');
  await page.screenshot({ path: path.join(OUT, 'shell-selfcheck.png'), fullPage: false });
  await page.click('#selfcheckClose');
  await page.waitForTimeout(400);

  await page.click('#tabs button[data-view="stocks"]');
  await page.waitForTimeout(1500);

  // 旧布局必须彻底清干净：自选股页不该再有「行情速览 / K线与舆情」，菜单里也不该再有「个股体检」
  const legacy = await page.evaluate(() => ({
    detail: !!document.querySelector('#stockDetail'),
    spot: !!document.querySelector('#stockSpot'),
    menuItem: !!document.querySelector('#menubar [data-jump="analysis"], #tabs button[data-view="analysis"]')
  }));
  console.log('旧面板残留检查: ' + JSON.stringify(legacy));
  if (legacy.detail || legacy.spot) errors.push('LAYOUT: 自选股页仍残留 #stockDetail / #stockSpot');
  if (legacy.menuItem) errors.push('LAYOUT: 菜单/页签里仍能看到「个股体检」入口');

  const row = await page.$('#stockTable tbody tr');
  if (row) {
    const code = await row.getAttribute('data-code');
    await row.click();
    await page.waitForTimeout(15000);
    const active = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    const title = (await page.textContent('#analysisTitle')).trim();
    const kline = await page.evaluate(() => {
      const c = document.querySelector('#klineChart');
      if (!c) return null;
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4000) if (data[i] > 0) painted += 1;
      return { w: c.width, h: c.height, paintedSamples: painted };
    });
    const kmeta = (await page.textContent('#klineMeta')).trim();
    console.log('[自选股->个股体检] ' + code + ' 页签=' + active + ' 标题=' + title);
    console.log('  日 K 线: ' + JSON.stringify(kline) + ' | ' + kmeta);
    if (active !== 'view-analysis') errors.push('NAV: 点自选股某一行没有打开「个股体检」 -> ' + active);
    if (!kline || kline.paintedSamples < 3) errors.push('EMPTY: 个股体检里的日 K 线没画出来 -> ' + JSON.stringify(kline));
    await page.screenshot({ path: path.join(OUT, 'stock-analysis.png'), fullPage: true });
  } else {
    errors.push('EMPTY: 自选股行情表没有数据行');
  }

  console.log('');
  console.log('控制台错误数: ' + errors.length);
  errors.slice(0, 20).forEach((e) => console.log('  ' + e));
  await browser.close();
})().catch((err) => { console.error('验收脚本失败: ' + err.message); process.exit(1); });
