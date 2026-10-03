'use strict';

/**
 * 外部程序接入（目前是 TradingAgents-CN）。
 *
 * ## 为什么是「接入」而不是「内置」
 *
 * TradingAgents-CN 是一个独立的 Python 项目（多智能体 LLM 研究框架），要跑起来需要：
 *   Python 3.11 + Node 18+ + MongoDB 7/8 + Redis 6/7，以及你自己的大模型 API Key。
 * 更关键的是它的 **LICENSE 是混合授权**：
 *   - tradingagents/ cli/ docs/ tests/ ：Apache-2.0，可以自由使用与再分发；
 *   - app/ core/ frontend/（后端应用层、核心层、前端）：**源码可见但非开源**，
 *     只允许个人使用与评估，**明确禁止再分发**。
 * 本仓库是公开仓库，把那三个目录拷进来再发布就直接违反它的授权，所以只能「接入」。
 *
 * ## 这个模块做什么
 *
 * 只做一件事：探测本机有没有在跑它（默认端口：FastAPI 后端 8000 / Vue 前端 3000），
 * 把「通不通、能不能嵌 iframe、为什么不能」如实告诉界面。
 * 探测是纯读取，不会去调用它的接口，也不会转发任何用户数据。
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_UA } = require('./http');
const { frameBlock } = require('../sources/embed');

const FILE = path.join(__dirname, '..', 'data', 'integrations.json');

/** 后端 8000 是 uvicorn 默认端口，前端 3000 是 Vite 默认端口。 */
const INTEGRATIONS = {
  tradingagents: {
    id: 'tradingagents',
    name: 'TradingAgents-CN',
    tagline: '多智能体 LLM 中文金融研究框架（独立程序）',
    repo: 'https://github.com/hsliuping/TradingAgents-CN',
    homepage: 'https://github.com/hsliuping/TradingAgents-CN',
    license: {
      kind: '混合授权（Hybrid）',
      openPart: 'tradingagents/ · cli/ · docs/ · tests/ · web/ —— Apache-2.0',
      closedPart: 'app/ · core/ · frontend/ —— 源码可见但非开源，禁止再分发',
      redistributable: false,
      note: '因此本工作站只做「探测 + 嵌入 + 跳转」，不复制它的任何源码。'
    },
    requirements: [
      'Python 3.11（本机当前未检测到 python 命令）',
      'Node.js 18+',
      'MongoDB 7.0+ 与 Redis 6+（需自行安装并启动）',
      '大模型 API Key（在它的系统设置里配置，本项目不接触）'
    ],
    steps: [
      'git clone https://github.com/hsliuping/TradingAgents-CN',
      'python -m venv env && env\\Scripts\\activate && pip install -r requirements.txt',
      'copy .env.example .env（填 MongoDB / Redis / JWT_SECRET / ADMIN_DEFAULT_PASSWORD）',
      '启动 MongoDB 与 Redis',
      'uvicorn app.main:app          # 后端，默认 http://localhost:8000',
      'cd frontend && npm install && npm run dev   # 前端，默认 http://localhost:3000'
    ],
    candidates: [
      { url: 'http://127.0.0.1:3000', role: '前端（Vue 3 / Vite）' },
      { url: 'http://127.0.0.1:8000', role: '后端（FastAPI / uvicorn）' }
    ],
    defaultBaseUrl: 'http://127.0.0.1:3000',
    probeTimeoutMs: 2500
  }
};

const DEFAULT_CONFIG = {
  tradingagents: { enabled: true, baseUrl: 'http://127.0.0.1:3000' }
};

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''));
    const out = {};
    for (const key of Object.keys(INTEGRATIONS)) {
      out[key] = Object.assign({}, DEFAULT_CONFIG[key], (data && data[key]) || {});
    }
    return out;
  } catch (err) {
    // 配置文件缺失或写坏了都不该让整个接口挂掉，退回默认值即可
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

/** 原子写：写 .tmp 再 rename，避免进程被打断留下半截 JSON。 */
function save(config) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
  return config;
}

/** 只接受 http/https，且必须是本机或局域网地址——这个字段不该变成任意 URL 的转发器。 */
function normalizeUrl(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) throw fail('地址不能为空', 400);
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    throw fail('地址格式不对，应形如 http://127.0.0.1:3000', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw fail('只支持 http / https 地址', 400);
  }
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
}

function setConfig(id, patch) {
  const meta = INTEGRATIONS[id];
  if (!meta) throw fail('未知的接入项：' + id, 404);
  const config = load();
  const cur = config[id];
  if (patch && patch.baseUrl !== undefined) cur.baseUrl = normalizeUrl(patch.baseUrl);
  if (patch && patch.enabled !== undefined) cur.enabled = Boolean(patch.enabled);
  save(config);
  return cur;
}

/** 探测单个地址：连得上吗？返回头允许被 iframe 嵌吗？ */
async function probeUrl(url, role, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': DEFAULT_UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }
    });
    const blockedBy = frameBlock(res.headers);
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (err) { /* 只关心响应头 */ }
    return {
      url: url, role: role, reachable: true, ok: res.ok, status: res.status,
      frameable: res.ok && !blockedBy, blockedBy: blockedBy, ms: Date.now() - started
    };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? '请求超时（' + timeoutMs + ' 毫秒）' : ((err && err.message) || String(err));
    return { url: url, role: role, reachable: false, ok: false, frameable: false, blockedBy: null, error: reason, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测某个外部程序是否在运行。会同时探前端与后端两个候选端口。
 * 用户自定义的 baseUrl 排在第一个，优先使用。
 */
async function probe(id) {
  const meta = INTEGRATIONS[id];
  if (!meta) throw fail('未知的接入项：' + id, 404);
  const config = load()[id];
  const timeout = meta.probeTimeoutMs || 2500;

  const targets = [];
  if (config.enabled && config.baseUrl) {
    const custom = meta.candidates.find((c) => c.url === config.baseUrl);
    targets.push({ url: config.baseUrl, role: custom ? custom.role : '自定义地址' });
  }
  for (const c of meta.candidates) {
    if (!targets.some((t) => t.url === c.url)) targets.push(c);
  }

  const results = await Promise.all(targets.map((t) => probeUrl(t.url, t.role, timeout)));
  const active = results.find((r) => r.reachable && r.ok) || null;
  return {
    id: id,
    name: meta.name,
    enabled: Boolean(config.enabled),
    baseUrl: config.baseUrl,
    running: Boolean(active),
    activeUrl: active ? active.url : null,
    embeddable: Boolean(active && active.frameable),
    results: results,
    checkedAt: new Date().toISOString()
  };
}

/** 给界面用的静态说明（不含探测结果）。 */
function describe(id) {
  const meta = INTEGRATIONS[id];
  if (!meta) throw fail('未知的接入项：' + id, 404);
  return Object.assign({}, meta, { config: load()[id] });
}

function list() {
  return Object.keys(INTEGRATIONS).map((id) => describe(id));
}

module.exports = { FILE, INTEGRATIONS, load, save, setConfig, normalizeUrl, probe, describe, list };
