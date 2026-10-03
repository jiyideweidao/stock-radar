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
  // 研判要拉多只股票的行情/资金/舆情再跑规则引擎，给足 30 秒
  ['agents', '智能体研判', 30000],
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
    if (id === 'agents') {
      // 四个分析师各一张卡 + 多空两栏 + 交易员/风控各一张，缺一不可
      const analysts = await page.$$eval('#agentsAnalysts .agent-card', (els) => els.length);
      const debate = await page.$$eval('#agentsDebate .debate-col', (els) => els.length);
      const trCards = await page.$$eval('#agentsTraderRisk .agent-card', (els) => els.length);
      const gaps = await page.$$eval('#agentsGaps .gap-list span', (els) => els.length);
      const verdict = (await page.textContent('#agentsVerdict')).replace(/\s+/g, ' ').trim();
      const panel = (await page.textContent('#agentsIntegration')).replace(/\s+/g, ' ').trim();
      console.log('  智能体: 分析师 ' + analysts + ' 张 / 辩论 ' + debate + ' 栏 / 交易员+风控 ' + trCards + ' 张 / 数据缺口 ' + gaps);
      console.log('  研判结论: ' + verdict.slice(0, 90));
      if (analysts !== 4) errors.push('AGENTS: 分析师卡片应为 4 张，实际 ' + analysts);
      if (debate !== 2) errors.push('AGENTS: 多空辩论应为 2 栏，实际 ' + debate);
      if (trCards !== 2) errors.push('AGENTS: 交易员与风控卡片应为 2 张，实际 ' + trCards);
      if (/加载中|正在让四个分析师/.test(verdict)) errors.push('AGENTS: 研判一直停在加载态 -> ' + verdict.slice(0, 60));
      if (!/TradingAgents-CN/.test(panel)) errors.push('AGENTS: 缺少 TradingAgents-CN 接入面板');
      // 授权限制必须如实写在界面上，不能只写在 README 里
      if (!/禁止再分发|再分发/.test(panel)) errors.push('AGENTS: 接入面板没有说明「禁止再分发」的授权限制');
      if (/\.\.\.$/.test(verdict)) errors.push('AGENTS: 结论像是被截断了');
      await page.screenshot({ path: path.join(OUT, 'agents-detail.png'), fullPage: true });
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

  // ---------- 自选股增删改：界面上真的能加一只、再删掉 ----------
  // 策略：临时加一只再删掉，跑完自选股必须和开始前完全一致。
  await page.click('#tabs button[data-view="stocks"]');
  await page.waitForTimeout(2500);
  const wlBefore = (await page.$$('#stockTable tbody tr')).length;
  await page.fill('#wlInput', '招商南油');
  await page.click('#wlSearchBtn');
  await page.waitForTimeout(7000);
  const cards = await page.$$('#wlResults .wl-result');
  console.log('[自选股选股] 搜索「招商南油」命中 ' + cards.length + ' 条');
  if (!cards.length) {
    errors.push('WATCHLIST: 名称搜索没有结果（/api/stock/lookup 或东财 suggest 挂了）');
  } else {
    const code = await cards[0].getAttribute('data-code');
    await cards[0].$eval('.wl-add', (b) => b.click());
    await page.waitForTimeout(8000);
    const afterAdd = (await page.$$('#stockTable tbody tr')).length;
    const added = await page.$('#stockTable tbody tr[data-code="' + code + '"]');
    console.log('  加入 ' + code + '：行数 ' + wlBefore + ' -> ' + afterAdd + '，新行存在=' + Boolean(added));
    if (!added || afterAdd !== wlBefore + 1) errors.push('WATCHLIST: 点「加入自选」没生效（' + wlBefore + ' -> ' + afterAdd + '）');
    await page.screenshot({ path: path.join(OUT, 'stock-watchlist-add.png'), fullPage: true });

    // 删除是「点两次」的设计：第一次只变成确认态，第二次才真删
    const delSel = '#stockTable tbody tr[data-code="' + code + '"] .wl-ops button[data-op="del"]';
    await page.click(delSel);
    await page.waitForTimeout(300);
    const armed = (await page.textContent(delSel)).trim();
    if (armed !== '确认删除') errors.push('WATCHLIST: 删除按钮没有二次确认（当前「' + armed + '」）');
    await page.click(delSel);
    await page.waitForTimeout(8000);
    const afterDel = (await page.$$('#stockTable tbody tr')).length;
    const stillThere = await page.$('#stockTable tbody tr[data-code="' + code + '"]');
    console.log('  删除 ' + code + '：行数 ' + afterAdd + ' -> ' + afterDel + '，二次确认=' + armed);
    if (afterDel !== wlBefore) errors.push('WATCHLIST: 删除后自选股没回到原样（' + wlBefore + ' -> ' + afterDel + '）');
    if (stillThere) errors.push('WATCHLIST: 删除后那一行还在');
  }

  console.log('');
  console.log('控制台错误数: ' + errors.length);
  errors.slice(0, 20).forEach((e) => console.log('  ' + e));
  await browser.close();
})().catch((err) => { console.error('验收脚本失败: ' + err.message); process.exit(1); });
