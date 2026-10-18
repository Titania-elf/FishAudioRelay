import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { RequestError } from './store.js';
import { connectFish } from './public/fish-browser.js';

export const WEB_MAX_TEXT = 1000;
export const WEB_MODELS = ['s2.1-pro', 'drama-3', 's2-pro', 's1'];
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export const BRIDGE_BODY_LIMIT = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 16384;
export const BRIDGE_VERSION = 2;
const messages = {
  LOGIN_REQUIRED: [401, 'Fish 登录已过期，请在 Fish 网页重新登录后点击连接书签。'],
  QUOTA_EXHAUSTED: [402, 'Fish 订阅额度不足，请在 Fish 网页检查套餐。'],
  VERIFICATION_REQUIRED: [403, '请在 Fish 网页完成验证后再试。'],
  FISH_FORBIDDEN: [403, 'Fish 拒绝访问，请在网页检查账号和音色权限。'],
  INVALID_REQUEST: [400, 'Fish 拒绝生成参数，请检查音色、模型和文本长度。'],
  RATE_LIMITED: [429, 'Fish 当前请求过多，请稍后再试。'],
  SITE_CHANGED: [502, 'Fish 网页版本已变化，请刷新文字转语音页面并重新连接。'],
  EMPTY_AUDIO: [502, 'Fish 未返回有效 MP3 音频。'],
  AUDIO_TOO_LARGE: [413, '生成音频过大，请在酒馆中缩短朗读分段。'],
  CANCELLED: [499, '生成已取消。'],
  TIMEOUT: [504, '网页生成超时，请缩短文本后再试。'],
  UPSTREAM_ERROR: [502, '网页生成失败，请检查 Fish 页面和网络连接。'],
};
const disconnected = () => new RequestError(503, 'Fish 网页未连接。请在已登录的 Fish 标签页点击连接书签，并保持连接窗口打开。');
const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
function snapshot(value) {
  if (!value || typeof value !== 'object') return null;
  return { plan: typeof value.plan === 'string' && /^[\w-]{1,40}$/.test(value.plan) ? value.plan : '',
    balance: number(value.balance), total: number(value.total), extraBalance: number(value.extraBalance), apiCredit: number(value.apiCredit) };
}
function mp3(buffer) {
  // A real frame must be present, not only an ID3 prefix or provider error body.
  for (let i = 0; i < Math.min(buffer.length - 3, 65536); i++) {
    if (buffer[i] === 255 && (buffer[i + 1] & 224) === 224 && (buffer[i + 1] & 6) === 2
      && (buffer[i + 1] & 24) !== 8 && (buffer[i + 2] >> 4) > 0 && (buffer[i + 2] >> 4) < 15
      && ((buffer[i + 2] >> 2) & 3) !== 3) return true;
  }
  return false;
}

export function createBrowserBridge({ relayKey, leaseMs = 45000, pollMs = 20000, maxPending = 6 } = {}) {
  const key = createHmac('sha256', relayKey).update('fish-browser-bridge-v1').digest('hex');
  let session = null;
  let queue = [];
  let active = null;
  let waiter = null;
  let lastStats = null;
  let lastError = '';
  let disposed = false;
  const isOnline = () => Boolean(session?.ready && Date.now() - session.lastSeen < leaseMs);
  function release(item, error, result) {
    if (item.settled) return;
    item.settled = true;
    item.signal?.removeEventListener('abort', item.abort);
    if (error) item.reject(error); else item.resolve(result);
  }
  function wake() {
    if (!waiter) return;
    const command = next();
    if (command) waiter.finish({ command });
  }
  function failAll(error) {
    if (active) release(active, error);
    for (const item of queue) release(item, error);
    active = null; queue = [];
    waiter?.finish(null, error);
  }
  function expire() {
    if (session && Date.now() - session.lastSeen >= leaseMs) {
      lastError = 'Fish 连接已断开，请重新点击连接书签。';
      session = null; failAll(disconnected());
    }
  }
  const watchdog = setInterval(expire, Math.min(1000, leaseMs));
  watchdog.unref();
  function requireSession(id) {
    expire();
    if (!session || session.id !== id) throw new RequestError(409, '连接已被替换或过期，请重新点击连接书签。');
  }
  function next() {
    if (!isOnline()) return null;
    if (active) {
      if (active.cancelled && !active.cancelSent) {
        active.cancelSent = true;
        return { type: 'cancel', id: active.id };
      }
      return null;
    }
    active = queue.shift() || null;
    return active ? { type: 'job', job: { id: active.id, ...active.payload } } : null;
  }
  return {
    authorized(supplied) { return typeof supplied === 'string' && Buffer.byteLength(supplied) === key.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(key)); },
    bookmark(origin) { return 'javascript:' + encodeURIComponent(`(${connectFish.toString()})(${JSON.stringify(origin)},${JSON.stringify(key)});void 0;`); },
    status() {
      expire();
      return { connected: isOnline(), queued: queue.length, generating: Boolean(active), lastStats, lastError,
        maxTextLength: WEB_MAX_TEXT, version: BRIDGE_VERSION };
    },
    connect(id, version) {
      if (disposed) throw disconnected();
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new RequestError(400, '连接编号无效。');
      if (version !== BRIDGE_VERSION) throw new RequestError(409, '请从管理页重新保存最新版连接书签。');
      failAll(new RequestError(503, '网页连接已更换，请重新发送朗读请求。'));
      session = { id, ready: true, lastSeen: Date.now() };
      lastError = '';
      return { ok: true };
    },
    disconnect(id) {
      requireSession(id);
      session = null;
      failAll(disconnected());
    },
    poll(id, signal) {
      requireSession(id);
      session.lastSeen = Date.now();
      if (waiter) throw new RequestError(409, '请只保留一个连接窗口。');
      const command = next();
      if (command) return Promise.resolve({ command });
      return new Promise((resolve, reject) => {
        let timer;
        const abort = () => finish(null, new RequestError(499, '连接请求已取消。'));
        const finish = (value, error) => {
          if (waiter?.finish !== finish) return;
          clearTimeout(timer); signal?.removeEventListener('abort', abort); waiter = null;
          if (error) reject(error); else resolve(value);
        };
        waiter = { finish };
        timer = setTimeout(() => finish({ command: null }), pollMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
    enqueue(payload, signal) {
      expire();
      if (disposed || !isOnline()) return Promise.reject(disconnected());
      if (queue.length + Number(Boolean(active)) >= maxPending) return Promise.reject(new RequestError(429, '朗读队列已满，请减少酒馆并发请求。'));
      if (signal?.aborted) return Promise.reject(signal.reason || new RequestError(499, '生成已取消。'));
      return new Promise((resolve, reject) => {
        const item = { id: randomUUID(), payload, signal, resolve, reject, settled: false };
        item.abort = () => {
          release(item, signal.reason || new RequestError(499, '生成已取消。'));
          if (active === item) item.cancelled = true;
          else queue = queue.filter(other => other !== item);
          wake();
        };
        signal?.addEventListener('abort', item.abort, { once: true });
        queue.push(item); wake();
      });
    },
    complete(id, value) {
      requireSession(id);
      if (!active || value.id !== active.id) throw new RequestError(409, '这个朗读任务已过期。');
      const item = active;
      const before = snapshot(value.before), after = snapshot(value.after);
      if (before || after) lastStats = { before, after, at: new Date().toISOString() };
      let error = null, result;
      if (value.ok !== true) {
        const [status, message] = messages[value.code] || messages.UPSTREAM_ERROR;
        error = new RequestError(status, message); lastError = message;
      } else if (item.payload.kind === 'balance') {
        if (!after && !before) error = new RequestError(502, '未读取到套餐额度。');
        else result = { before, after };
      } else {
        const encoded = value.audioBase64;
        if (typeof encoded !== 'string' || encoded.length % 4 || encoded.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) error = new RequestError(502, '网页返回的音频格式无效。');
        else {
          const audio = Buffer.from(encoded, 'base64');
          if (!audio.length || audio.length > MAX_AUDIO_BYTES || !mp3(audio)) error = new RequestError(502, '网页未返回有效的 MP3 音频。');
          else result = { audio, before, after };
        }
      }
      active = null;
      if (error) lastError = error.message; else lastError = '';
      release(item, error, result);
      if (value.ok !== true && ['LOGIN_REQUIRED', 'VERIFICATION_REQUIRED', 'FISH_FORBIDDEN', 'SITE_CHANGED', 'QUOTA_EXHAUSTED'].includes(value.code)) {
        session.ready = false;
        failAll(error);
      }
      // Return already generated audio, but stop additional automatic requests
      // if the website unexpectedly consumed API credit.
      if (before?.apiCredit !== null && after?.apiCredit !== null && before && after && after.apiCredit < before.apiCredit) {
        lastError = '检测到 API 余额减少，已停止后续朗读。请检查 Fish 的计费记录。';
        session.ready = false;
        failAll(new RequestError(402, lastError));
      }
      wake();
      return { ok: true };
    },
    close() { disposed = true; clearInterval(watchdog); session = null; failAll(disconnected()); },
  };
}
