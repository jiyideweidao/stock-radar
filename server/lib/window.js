'use strict';
/**
 * 原生窗口桥接：把网页里的「最小化 / 最大化 / 关闭 / 置顶」按钮
 * 转成真正的 Windows 窗口操作。
 *
 * 实现方式：由本模块懒启动一个常驻的 PowerShell 代理进程
 * （desktop/window-agent.ps1），用 stdin/stdout 走「一行 JSON」协议，
 * 由代理调用 user32.dll 操作标题含「股民舆情与商品看板」的窗口。
 * 只允许白名单指令，不接受任意脚本。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const SCRIPT = path.join(__dirname, '..', '..', 'desktop', 'window-agent.ps1');
const ACTIONS = ['state', 'focus', 'minimize', 'maximize', 'restore', 'close', 'topmost-on', 'topmost-off', 'topmost-toggle'];
const REQUEST_TIMEOUT = 15000;

let agent = null;
let starting = null;
let pending = null;
let busy = false;
const queue = [];

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const winPs = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (IS_WIN && fs.existsSync(winPs)) return winPs; } catch (err) { /* ignore */ }
  return 'powershell.exe';
}

function scriptExists() {
  try { return fs.existsSync(SCRIPT); } catch (err) { return false; }
}

function capabilities() {
  return {
    platform: process.platform,
    supported: IS_WIN && scriptExists(),
    script: SCRIPT,
    powershell: powershellPath(),
    agentRunning: !!agent,
    busy: busy,
    queued: queue.length,
    actions: ACTIONS.slice()
  };
}

function attach(child) {
  child.stdout.setEncoding('utf8');
  child.stdin.setDefaultEncoding('utf8');
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '').trim();
      buffer = buffer.slice(idx + 1);
      if (line) deliver(line);
      idx = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  let errBuf = '';
  child.stderr.on('data', (chunk) => { errBuf = (errBuf + chunk).slice(-800); });
  child.on('error', (err) => {
    finishPending(new Error('窗口代理启动失败: ' + err.message));
    if (agent === child) agent = null;
  });
  child.on('exit', (code) => {
    finishPending(new Error('窗口代理已退出（code=' + code + '）' + (errBuf ? ' ' + errBuf.trim() : '')));
    if (agent === child) agent = null;
  });
  return child;
}

function deliver(line) {
  if (!pending) return;
  let obj;
  try { obj = JSON.parse(line); } catch (err) { return; }
  const current = pending;
  current.finish(null, obj);
}

function finishPending(err) {
  if (!pending) return;
  const current = pending;
  current.finish(err);
}

function startAgent() {
  if (agent) return Promise.resolve(agent);
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; starting = null; reject(err); } };
    let child;
    try {
      child = spawn(powershellPath(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) { fail(err); return; }
    attach(child);
    const timer = setTimeout(() => fail(new Error('窗口代理启动超时')), REQUEST_TIMEOUT);
    // 进程一旦 spawn 成功就认为代理可用：PowerShell 首次要编译 Add-Type（约 1-2 秒），
    // 期间写入 stdin 的指令会排队等待，不能等到有 stdout 输出才放行（那会死锁）。
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      starting = null;
      agent = child;
      resolve(child);
    });
  });
  return starting;
}

function send(child, action) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finishPending(new Error('窗口指令超时：' + action));
      try { child.kill(); } catch (err) { /* ignore */ }
    }, REQUEST_TIMEOUT);
    pending = {
      finish(err, value) {
        clearTimeout(timer);
        pending = null;
        if (err) reject(err); else resolve(value);
      }
    };
    child.stdin.write(action + '\n', (err) => { if (err) finishPending(err); });
  });
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const item = queue.shift();
  try {
    const child = await startAgent();
    item.resolve(await send(child, item.action));
  } catch (err) {
    item.reject(err);
  } finally {
    busy = false;
    setImmediate(pump);
  }
}

/** 下发一条窗口指令，返回代理的 JSON 结果。 */
function request(action) {
  const act = String(action === undefined || action === null ? '' : action).trim().toLowerCase();
  if (!ACTIONS.includes(act)) return Promise.reject(new Error('不支持的窗口指令：' + action));
  if (!IS_WIN) return Promise.reject(new Error('窗口控制仅支持 Windows'));
  if (!scriptExists()) return Promise.reject(new Error('缺少窗口代理脚本：' + SCRIPT));
  return new Promise((resolve, reject) => {
    queue.push({ action: act, resolve, reject });
    pump();
  });
}

/** 只读地查询窗口状态。 */
function state() { return request('state'); }

/** 预热代理进程，减少第一次点击按钮的等待。 */
function warmup() {
  startAgent().catch(() => {});
}

function shutdown() {
  const child = agent;
  if (!child) return;
  agent = null;
  // 先礼后兵：给代理一句 quit，再立刻终止它。
  // 不能只靠 setTimeout —— 本函数常在 process.exit() 前被调用，
  // unref 的定时器根本不会触发，会留下一个孤儿的 PowerShell 代理进程。
  try { child.stdin.write('quit\n'); } catch (err) { /* ignore */ }
  try { child.kill(); } catch (err) { /* ignore */ }
}

process.on('exit', shutdown);

module.exports = { request, state, warmup, shutdown, capabilities, ACTIONS };
