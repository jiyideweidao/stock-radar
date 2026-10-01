'use strict';

/**
 * 极简 TTL 缓存 + 在途请求去重。
 * 设计要点：
 *  - 上游抓取失败时优先返回上一次成功的数据（前端据 stale 标记降级展示）；
 *  - 同一 key 的并发请求只打一次上游，避免被财经站点限流。
 */
const store = new Map();

function cached(key, ttlMs, producer, options) {
  const now = Date.now();
  const hit = store.get(key);

  if (hit && hit.pending) return hit.pending;
  if (hit && now - hit.at < ttlMs) return Promise.resolve(hit.value);

  const prev = hit ? hit.value : undefined;
  // 看门狗：一次抓取最多允许跑 deadlineMs。上游卡住时这里会先超时，
  // 保证 pending 一定会结算，不会让这个 key 永久占坑、把整个页面拖死。
  const deadlineMs = (options && options.deadlineMs) || 90000;

  const pending = (async () => {
    let timer = null;
    try {
      const value = await Promise.race([
        Promise.resolve().then(producer),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('上游抓取超过 ' + Math.round(deadlineMs / 1000) + ' 秒仍未返回，已放弃本次抓取')), deadlineMs);
        })
      ]);
      store.set(key, { at: Date.now(), value, stale: false });
      return value;
    } catch (err) {
      if (prev !== undefined) {
        store.set(key, { at: now, value: prev, stale: true, error: String(err.message || err) });
        return prev;
      }
      store.delete(key);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();

  store.set(key, { pending, startedAt: now });
  return pending;
}

function cacheInfo() {
  const out = [];
  for (const [key, entry] of store) {
    out.push({
      key,
      pending: Boolean(entry.pending),
      ageMs: entry.at ? Date.now() - entry.at : null,
      pendingMs: entry.startedAt ? Date.now() - entry.startedAt : null,
      stale: Boolean(entry.stale)
    });
  }
  return out;
}

module.exports = { cached, cacheInfo };
