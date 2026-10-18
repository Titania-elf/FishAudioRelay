import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, MAX_TEXT_LENGTH, RequestError } from './store.js';
import { createBrowserBridge, WEB_MAX_TEXT, WEB_MODELS, BRIDGE_BODY_LIMIT } from './browser-bridge.js';
import { isLoopbackAddress, isPrivateAddress, isPrivateOrigin, localIPv4Addresses } from './network.js';

const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const FISH_URL = 'https://api.fish.audio/v1/tts';
const MAX_BODY_BYTES = 65536;
const TAVERN_ORIGINS = new Set(['http://127.0.0.1:8000', 'http://localhost:8000']);
// ST-iPhonie calls these routes directly from the browser. Management and
// browser-pairing routes must remain accessible only from the relay's own page.
const CORS_ROUTES = new Map([
  ['/v1/audio/speech', 'POST'],
  ['/compat/v1/audio/speech', 'POST'], // 404 lets the plugin detect OpenAI format.
  ['/v1/models', 'GET'],
]);

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request, limit = MAX_BODY_BYTES) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new RequestError(415, '请使用 Content-Type: application/json。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, '请求过大，请缩短文本。');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'JSON 格式不正确。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, '请求必须为 JSON 对象。');
  return body;
}

function constantEqual(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function translateSpeech(body, config) {
  const input = body.input;
  if (typeof input !== 'string' || !input.trim()) throw new RequestError(400, '朗读文本不能为空。');
  const maximum = config.provider === 'web' ? WEB_MAX_TEXT : MAX_TEXT_LENGTH;
  if ([...input].length > maximum) throw new RequestError(413, `单次文本不能超过 ${maximum} 个字符，请在酒馆分段朗读。`);
  if (body.response_format && body.response_format !== 'mp3') throw new RequestError(400, '酒馆中转仅支持 MP3 音频。');
  const voiceName = body.voice ?? config.defaultVoice;
  const voice = config.voices.find(item => item.name === voiceName)
    || (typeof voiceName === 'string' && /^[a-f0-9]{32}$/i.test(voiceName)
      ? { referenceId: voiceName.toLowerCase() } : null);
  if (!voice) throw new RequestError(400, '未找到音色，请填写 Fish 的 32 位音色 ID，或管理页已保存的音色别名。');
  const speed = body.speed ?? 1;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new RequestError(400, 'Fish Audio 的语速范围为 0.5–2，请调整酒馆 Speed。');
  }
  // tts-1/tts-1-hd are SillyTavern/OpenAI defaults, so use the saved Fish model.
  const model = body.model && !['tts-1', 'tts-1-hd'].includes(body.model) ? body.model : config.model;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(model)) {
    throw new RequestError(400, '模型名称无效。');
  }
  if (config.provider === 'web') {
    if (!voice.referenceId) throw new RequestError(400, '网页订阅模式需要固定音色，请先保存音色的 Reference ID。');
    if (!WEB_MODELS.includes(model)) throw new RequestError(400, `网页订阅模式目前支持 ${WEB_MODELS.join('、')}。`);
  }
  return { model, payload: { text: input, format: 'mp3',
    ...(voice.referenceId ? { reference_id: voice.referenceId } : {}), prosody: { speed } } };
}

function upstreamMessage(status) {
  if (status === 401) return 'Fish Audio 拒绝了 KEY，请检查本地设置中的 Fish API KEY。';
  if (status === 402) return 'Fish Audio 账户余额不足，请在 Fish Audio 检查 API 余额。';
  if (status === 403) return 'Fish Audio 拒绝访问，请检查账户、API 权限和音色访问权限。';
  if (status === 404) return 'Fish Audio 未找到音色或接口，请检查 Reference ID。';
  if (status === 429) return 'Fish Audio 请求过于频繁，请稍后重试或减少酒馆并行生成。';
  if (status === 400 || status === 422) return 'Fish Audio 拒绝生成参数，请检查模型、Reference ID、文本长度与语速。';
  return `Fish Audio 返回 HTTP ${status}，请稍后重试。`;
}

// `lan` opens the speech routes to a tavern page running on a phone in the same
// network. The management page and the Fish browser pairing stay on loopback
// either way, so a phone can read aloud but never see the relay KEY.
export async function createRelay({ store, fetchImpl = fetch, logger = console, timeoutMs = 120000, webTimeoutMs = 180000, lan = false, extraOrigins = [] } = {}) {
  if (!store) throw new Error('Missing configuration store');
  const csrfToken = randomBytes(32).toString('hex');
  const browser = createBrowserBridge({ relayKey: store.get().relayKey });
  const lanAddresses = lan ? localIPv4Addresses() : [];
  const tavernOrigins = new Set([...TAVERN_ORIGINS, ...extraOrigins]);
  const acceptsTavern = origin => tavernOrigins.has(origin) || (lan && isPrivateOrigin(origin));
  const staticAssets = new Map();
  for (const [route, file, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/browser', 'browser.html', 'text/html; charset=utf-8'],
    ['/browser.js', 'browser.js', 'text/javascript; charset=utf-8'],
  ]) {
    staticAssets.set(route, { body: await readFile(path.join(publicDirectory, file)), type });
  }
  let active = 0;
  let generationNumber = 0;
  const controllers = new Set();

  function publicConfig(request) {
    const config = store.get();
    return {
      provider: config.provider || 'api', browser: browser.status(),
      browserBookmark: browser.bookmark(`http://127.0.0.1:${request.socket.localPort}`),
      fishKeyConfigured: Boolean(config.fishApiKey), model: config.model,
      voices: config.voices, defaultVoice: config.defaultVoice, relayKey: config.relayKey,
      endpoint: `http://127.0.0.1:${request.socket.localPort}/v1/audio/speech`,
      lanEndpoint: lanAddresses.length ? `http://${lanAddresses[0]}:${request.socket.localPort}/v1/audio/speech` : '',
      maxTextLength: config.provider === 'web' ? WEB_MAX_TEXT : MAX_TEXT_LENGTH, csrfToken,
    };
  }

  async function generate(request, response, body) {
    const config = store.get();
    const { payload, model } = translateSpeech(body, config);
    const useWeb = config.provider === 'web';
    if (!useWeb && !config.fishApiKey) throw new RequestError(503, '尚未配置 Fish Audio KEY，请先在本机管理页保存。');
    if (!useWeb && active >= 2) throw new RequestError(429, '本机已有 2 个请求正在生成，请稍后重试。');
    active += 1;
    const id = ++generationNumber;
    const start = Date.now();
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, useWeb ? webTimeoutMs : timeoutMs);
    const disconnect = () => { if (!response.writableFinished) controller.abort(); };
    response.on('close', disconnect);
    try {
      if (useWeb) {
        const result = await browser.enqueue({ kind: 'speech', text: payload.text, referenceId: payload.reference_id,
          model, speed: payload.prosody.speed }, controller.signal);
        response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': result.audio.length });
        response.end(result.audio);
        logger.info(`[TTS ${id}] 完成，${Date.now() - start} ms`);
        return;
      }
      const upstream = await fetchImpl(FISH_URL, {
        method: 'POST', headers: {
          'Content-Type': 'application/json', Authorization: `Bearer ${config.fishApiKey}`, model,
        }, body: JSON.stringify(payload), signal: controller.signal,
        redirect: 'error',
      });
      if (!upstream.ok) {
        // Do not forward provider error bodies: they may echo request text or keys.
        await upstream.body?.cancel();
        const status = [400, 401, 402, 403, 404, 422, 429].includes(upstream.status) ? upstream.status : 502;
        throw new RequestError(status, upstreamMessage(upstream.status));
      }
      if (!upstream.body) throw new RequestError(502, 'Fish Audio 未返回音频。');
      const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!['audio/mpeg', 'audio/mp3', 'application/octet-stream', 'binary/octet-stream', ''].includes(contentType)) {
        await upstream.body.cancel();
        throw new RequestError(502, 'Fish Audio 返回了非 MP3 数据。');
      }
      // Delay response headers until there is actual audio, so an empty upstream
      // response or an early network failure can still return a useful JSON error.
      const reader = upstream.body.getReader();
      let first;
      do { first = await reader.read(); } while (!first.done && !first.value?.byteLength);
      if (first.done) throw new RequestError(502, 'Fish Audio 返回了空音频。');
      const chunks = async function* () {
        try {
          yield Buffer.from(first.value);
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            yield Buffer.from(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      };
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      await pipeline(Readable.from(chunks()), response);
      logger.info(`[TTS ${id}] 完成，${Date.now() - start} ms`);
    } catch (error) {
      logger.warn(`[TTS ${id}] ${timedOut ? '超时' : '生成失败'}，${Date.now() - start} ms`);
      if (error instanceof RequestError) throw error;
      throw new RequestError(timedOut ? 504 : 502, timedOut
        ? `Fish Audio 生成超过 ${Math.round((useWeb ? webTimeoutMs : timeoutMs) / 1000)} 秒，请缩短文本后重试。`
        : '连接 Fish Audio 失败或生成中断，请检查这台电脑的网络连接。');
    } finally {
      clearTimeout(timer);
      response.off('close', disconnect);
      controllers.delete(controller);
      active -= 1;
    }
  }

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const remote = request.socket.remoteAddress;
      const fromLocal = isLoopbackAddress(remote);
      if (!fromLocal && !(lan && isPrivateAddress(remote))) throw new RequestError(403, '此中转仅允许本机访问。');
      const port = request.socket.localPort;
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      for (const address of lanAddresses) allowedHosts.add(`${address}:${port}`);
      if (!allowedHosts.has(request.headers.host?.toLowerCase())) throw new RequestError(403, '无效的本机 Host。');
      const origins = new Set([...allowedHosts].map(host => `http://${host}`));
      const route = new URL(request.url, 'http://127.0.0.1').pathname;
      const origin = request.headers.origin;
      const corsMethod = CORS_ROUTES.get(route);
      // A phone gets the speech routes and nothing else: no configuration, no
      // preview, and no Fish browser pairing.
      if (!fromLocal && !corsMethod) throw new RequestError(403, '管理接口仅允许在这台电脑上打开；手机请只使用语音接口。');
      if (origin && !origins.has(origin) && !(corsMethod && acceptsTavern(origin))) {
        throw new RequestError(403, lan
          ? '此网页地址未获准访问语音接口。请在本机管理页操作，或用本机 IP 打开酒馆后再调用。'
          : '此网页地址未获准访问该接口。请从本机管理页操作，或从 localhost:8000 / 127.0.0.1:8000 的酒馆调用语音接口。');
      }
      if (corsMethod) response.setHeader('Vary', 'Origin');
      if (origin && corsMethod) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        if (request.method === 'OPTIONS') {
          const headers = (request.headers['access-control-request-headers'] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
          if (request.headers['access-control-request-method'] !== corsMethod
            || headers.some(header => !['authorization', 'content-type'].includes(header))) {
            throw new RequestError(403, '跨域请求的方法或请求头不受支持。');
          }
          response.writeHead(204, {
            'Access-Control-Allow-Methods': corsMethod,
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '600',
          });
          response.end();
          return;
        }
      }
      if (request.method === 'GET' && staticAssets.has(route)) {
        const asset = staticAssets.get(route);
        response.writeHead(200, { 'Content-Type': asset.type });
        response.end(asset.body);
        return;
      }
      if (request.method === 'GET' && route === '/health') {
        json(response, 200, { ok: true, service: 'fish-audio-relay' });
        return;
      }
      if (request.method === 'GET' && route === '/api/config') {
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, '请从本机管理页面访问。');
        json(response, 200, publicConfig(request));
        return;
      }
      if (request.method === 'GET' && route === '/api/browser/status') {
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, '请从本机管理页面访问。');
        json(response, 200, browser.status()); return;
      }
      if (request.method === 'POST' && ['/api/browser/connect', '/api/browser/poll', '/api/browser/result', '/api/browser/disconnect'].includes(route)) {
        if (!browser.authorized(request.headers['x-browser-key'])) throw new RequestError(403, '浏览器连接凭据无效，请从管理页重新连接。');
        const value = await readJson(request, route === '/api/browser/result' ? BRIDGE_BODY_LIMIT : MAX_BODY_BYTES);
        if (route === '/api/browser/connect') json(response, 200, browser.connect(value.clientId, value.version));
        else if (route === '/api/browser/result') json(response, 200, browser.complete(value.clientId, value));
        else if (route === '/api/browser/disconnect') { browser.disconnect(value.clientId); json(response, 200, { ok: true }); }
        else {
          const abort = new AbortController();
          const closed = () => abort.abort();
          response.on('close', closed);
          try { json(response, 200, await browser.poll(value.clientId, abort.signal)); }
          finally { response.off('close', closed); }
        }
        return;
      }
      if (request.method === 'POST' && route === '/api/browser/check') {
        if (!constantEqual(request.headers['x-csrf-token'], csrfToken)) throw new RequestError(403, '管理页面会话已过期，请刷新页面。');
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 30000);
        const closed = () => abort.abort();
        response.on('close', closed);
        try { json(response, 200, await browser.enqueue({ kind: 'balance' }, abort.signal)); }
        finally { clearTimeout(timer); response.off('close', closed); }
        return;
      }
      if (request.method === 'POST' && ['/api/config', '/api/preview'].includes(route)) {
        if (!constantEqual(request.headers['x-csrf-token'], csrfToken)) throw new RequestError(403, '管理页面会话已过期，请刷新页面。');
        const body = await readJson(request);
        if (route === '/api/config') {
          await store.update(body);
          json(response, 200, publicConfig(request));
        } else await generate(request, response, body);
        return;
      }
      if (request.method === 'POST' && route === '/v1/audio/speech') {
        const authorization = request.headers.authorization;
        const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        if (!constantEqual(token, store.get().relayKey)) throw new RequestError(401, '中转 KEY 无效，请在酒馆 API Key 中填写管理页显示的中转专用 KEY。');
        await generate(request, response, await readJson(request));
        return;
      }
      if (request.method === 'GET' && route === '/v1/models') {
        const token = request.headers.authorization?.slice(7);
        if (!request.headers.authorization?.startsWith('Bearer ') || !constantEqual(token, store.get().relayKey)) throw new RequestError(401, '中转 KEY 无效。');
        const config = store.get();
        const models = config.provider === 'web' ? WEB_MODELS : [config.model || DEFAULT_MODEL];
        json(response, 200, { object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'fish-audio-relay' })) });
        return;
      }
      throw new RequestError(404, '接口不存在。');
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof RequestError ? error.status : 500;
      if (status === 500) logger.warn('本机请求失败，请检查配置文件是否可写。');
      json(response, status, { error: { message: error instanceof RequestError ? error.message : '本机服务处理失败，请查看服务窗口。', type: 'relay_error' } });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return {
    server,
    async close() {
      browser.close();
      for (const controller of controllers) controller.abort();
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
