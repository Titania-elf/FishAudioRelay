import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRelay } from '../relay.js';
import { createBrowserBridge, BRIDGE_VERSION, WEB_MODELS } from '../browser-bridge.js';

const referenceId = '1234567890abcdef1234567890abcdef';
const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0]), Buffer.alloc(100000, 1)]);
const before = { plan: 'plus', balance: 500, total: 1000, extraBalance: 0, apiCredit: 0 };
const after = { ...before, balance: 458 };
async function setup(t, options = {}) {
  const config = { provider: 'web', fishApiKey: 'api-key-that-must-not-be-used', relayKey: 'private-relay-test-key',
    model: 's2.1-pro', voices: [{ name: 'reader', referenceId }], defaultVoice: 'reader' };
  const logs = [];
  let apiCalls = 0;
  const relay = await createRelay({ store: { get: () => structuredClone(config) },
    fetchImpl: () => { apiCalls++; throw new Error('Unexpected API call'); },
    logger: { info: message => logs.push(message), warn: message => logs.push(message) }, ...options });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const settings = await (await fetch(base + '/api/config')).json();
  const key = decodeURIComponent(settings.browserBookmark).match(/"([a-f0-9]{64})"\);void 0;$/)[1];
  const clientId = randomUUID();
  const browser = (path, body = {}, headers = {}) => fetch(base + '/api/browser/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Browser-Key': key, ...headers },
    body: JSON.stringify({ clientId, ...body }),
  });
  const speech = (body = {}, signal, headers = {}) => fetch(base + '/v1/audio/speech', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.relayKey, ...headers },
    body: JSON.stringify({ input: '私有朗读文本', ...body }), signal,
  });
  const connect = () => browser('connect', { version: BRIDGE_VERSION });
  const next = async () => {
    const response = await browser('poll'); assert.equal(response.status, 200);
    return (await response.json()).command;
  };
  return { base, settings, key, clientId, browser, speech, connect, next, config, logs, apiCalls: () => apiCalls };
}

test('OpenAI speech goes through paired browser with configured voice/speed and preserves returned MP3', async t => {
  const relay = await setup(t); await relay.connect();
  const pending = relay.speech({ model: 'tts-1', speed: 1.2 });
  const command = await relay.next();
  assert.deepEqual({ ...command.job, id: undefined }, { id: undefined, kind: 'speech', text: '私有朗读文本', model: 's2.1-pro', referenceId, speed: 1.2 });
  const returned = await relay.browser('result', { id: command.job.id, ok: true, audioBase64: audio.toString('base64'),
    before: { ...before, token: 'never-publish' }, after });
  assert.equal(returned.status, 200);
  const response = await pending;
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  const status = await (await fetch(relay.base + '/api/browser/status')).json();
  assert.deepEqual(status.lastStats.before, before); assert.deepEqual(status.lastStats.after, after);
  assert.equal(relay.apiCalls(), 0);
  assert.ok(!JSON.stringify(relay.logs).includes('私有朗读文本'));
  assert.ok(!JSON.stringify(status).includes('never-publish'));
});

test('disconnected webpage and unsupported web requests fail without API fallback', async t => {
  const relay = await setup(t);
  assert.equal((await relay.speech()).status, 503);
  for (const body of [{ model: 'drama-3-preview' }, { input: 'x'.repeat(1001) }, { voice: 'missing' }, { speed: 4 },
    { voice: 'a'.repeat(31) }, { voice: 'g'.repeat(32) }, { voice: 'a'.repeat(33) }, { voice: 123 }]) {
    assert.ok([400, 413].includes((await relay.speech(body)).status));
  }
  relay.config.voices[0].referenceId = '';
  assert.equal((await relay.speech()).status, 400);
  assert.equal(relay.apiCalls(), 0);
});

test('ST-iPhonie browser preflight and raw voice ID speech preserve emotion, speed and audio', async t => {
  const relay = await setup(t); await relay.connect();
  for (const origin of ['http://127.0.0.1:8000', 'http://localhost:8000']) {
    const response = await fetch(relay.base + '/v1/audio/speech', { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
    } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-methods'), 'POST');
    assert.equal(response.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
  }
  const origin = 'http://localhost:8000';
  const rawVoice = 'ABCDEF1234567890ABCDEF1234567890';
  const text = '[happy] 你好，这是插件的语音测试。';
  const pending = relay.speech({ input: text, voice: rawVoice, model: 'drama-3', response_format: 'mp3', speed: 1.15 }, undefined, { Origin: origin });
  const command = await relay.next();
  assert.deepEqual({ ...command.job, id: undefined }, {
    id: undefined, kind: 'speech', text, referenceId: rawVoice.toLowerCase(), model: 'drama-3', speed: 1.15,
  });
  await relay.browser('result', { id: command.job.id, ok: true, audioBase64: audio.toString('base64') });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
  assert.equal(relay.apiCalls(), 0);
});

test('ST-iPhonie detects the OpenAI route with empty probes and receives readable errors without generation', async t => {
  const relay = await setup(t); await relay.connect();
  const origin = 'http://127.0.0.1:8000';
  const preflight = await fetch(relay.base + '/compat/v1/audio/speech', { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
  } });
  assert.equal(preflight.status, 204);
  const compat = await fetch(relay.base + '/compat/v1/audio/speech', { method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer ' + relay.config.relayKey,
  }, body: '{}' });
  assert.equal(compat.status, 404);
  assert.equal(compat.headers.get('access-control-allow-origin'), origin);
  const empty = await relay.speech({ input: undefined }, undefined, { Origin: origin });
  assert.equal(empty.status, 400);
  assert.equal(empty.headers.get('access-control-allow-origin'), origin);
  const wrongKey = await relay.speech({}, undefined, { Origin: origin, Authorization: 'Bearer wrong' });
  assert.equal(wrongKey.status, 401);
  assert.equal(wrongKey.headers.get('access-control-allow-origin'), origin);
  const status = await (await fetch(relay.base + '/api/browser/status')).json();
  assert.equal(status.queued, 0); assert.equal(status.generating, false);
  assert.equal(relay.logs.length, 0); assert.equal(relay.apiCalls(), 0);
});

test('CORS exposes model discovery only with a relay key and rejects unsupported preflight methods/headers', async t => {
  const relay = await setup(t), origin = 'http://localhost:8000';
  const preflight = await fetch(relay.base + '/v1/models', { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET');
  const denied = await fetch(relay.base + '/v1/models', { headers: { Origin: origin } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('access-control-allow-origin'), origin);
  const allowed = await fetch(relay.base + '/v1/models', { headers: { Origin: origin, Authorization: 'Bearer ' + relay.config.relayKey } });
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json()).data.map(item => item.id), WEB_MODELS);
  for (const headers of [
    { 'Access-Control-Request-Method': 'DELETE' },
    { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-Browser-Key' },
  ]) {
    const response = await fetch(relay.base + '/v1/audio/speech', { method: 'OPTIONS', headers: { Origin: origin, ...headers } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-methods'), null);
  }
});

test('other origins remain blocked and SillyTavern cannot access management, pairing or preview routes', async t => {
  const relay = await setup(t);
  for (const origin of ['https://unrelated.example', 'null', 'http://localhost:8001', 'http://localhost:8000.evil.example']) {
    const response = await relay.speech({}, undefined, { Origin: origin });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const preflight = await fetch(relay.base + '/v1/audio/speech', { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST',
    } });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  }
  for (const route of ['/', '/api/config', '/api/browser/status', '/api/browser/check', '/api/browser/connect',
    '/api/browser/poll', '/api/browser/result', '/api/browser/disconnect', '/api/preview', '/browser']) {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const response = await fetch(relay.base + route, { method, headers: {
        Origin: 'http://localhost:8000', 'X-CSRF-Token': relay.settings.csrfToken, 'X-Browser-Key': relay.key,
      } });
      assert.equal(response.status, 403, method + ' ' + route);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  }
});

test('browser routes reject wrong credentials, unrelated origins and stale sessions', async t => {
  const relay = await setup(t);
  assert.equal((await relay.browser('connect', { version: BRIDGE_VERSION }, { 'X-Browser-Key': 'wrong' })).status, 403);
  assert.equal((await relay.browser('connect', { version: BRIDGE_VERSION }, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await relay.browser('connect', { version: 0 })).status, 409);
  const oldBookmark = await relay.browser('connect', { version: 1 });
  assert.equal(oldBookmark.status, 409);
  assert.match((await oldBookmark.json()).error.message, /最新版连接书签/);
  await relay.connect();
  assert.equal((await relay.browser('poll', { clientId: randomUUID() })).status, 409);
  assert.equal((await relay.browser('result', { id: randomUUID(), ok: true })).status, 409);
});

test('FIFO queue only releases the next speech after the active browser result', async t => {
  const relay = await setup(t); await relay.connect();
  const first = relay.speech({ input: 'first' });
  const one = await relay.next();
  const second = relay.speech({ input: 'second' });
  const poll = relay.next();
  await relay.browser('result', { id: one.job.id, ok: true, audioBase64: audio.toString('base64') });
  const two = await poll;
  assert.equal(one.job.text, 'first'); assert.equal(two.job.text, 'second');
  assert.notEqual(one.job.id, two.job.id);
  await relay.browser('result', { id: two.job.id, ok: true, audioBase64: audio.toString('base64') });
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.equal(relay.apiCalls(), 0);
});

test('caller cancellation reaches Fish and the queue resumes after its cancellation result', async t => {
  const relay = await setup(t); await relay.connect();
  const abort = new AbortController();
  const first = relay.speech({}, abort.signal).catch(error => error);
  const one = await relay.next();
  abort.abort(); await first;
  const cancellation = await relay.next();
  assert.deepEqual(cancellation, { type: 'cancel', id: one.job.id });
  const second = relay.speech({ input: 'next' });
  await relay.browser('result', { id: one.job.id, ok: false, code: 'CANCELLED' });
  const two = await relay.next();
  assert.equal(two.job.text, 'next');
  await relay.browser('result', { id: two.job.id, ok: true, audioBase64: audio.toString('base64') });
  assert.equal((await second).status, 200);
});

test('lost browser rejects outstanding speech and never replays it on reconnect', async t => {
  const relay = await setup(t); await relay.connect();
  const pending = relay.speech(); const command = await relay.next();
  await relay.browser('disconnect'); assert.equal((await pending).status, 503);
  await relay.connect();
  assert.equal((await relay.browser('result', { id: command.job.id, ok: true, audioBase64: audio.toString('base64') })).status, 409);
  const status = await (await fetch(relay.base + '/api/browser/status')).json();
  assert.equal(status.queued, 0); assert.equal(status.generating, false);
});

test('upstream errors are sanitized; missing MP3 and expired login cannot become audio responses', async t => {
  const relay = await setup(t); await relay.connect();
  let pending = relay.speech(), command = await relay.next();
  await relay.browser('result', { id: command.job.id, ok: true, audioBase64: Buffer.from('not audio').toString('base64') });
  assert.equal((await pending).status, 502);
  pending = relay.speech(); command = await relay.next();
  await relay.browser('result', { id: command.job.id, ok: false, code: 'LOGIN_REQUIRED', error: 'private upstream body' });
  const response = await pending; assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes('private upstream body'));
  assert.equal((await relay.speech()).status, 503);
  assert.equal(relay.apiCalls(), 0);
});

test('already generated audio is returned but further requests stop if API credit falls', async t => {
  const relay = await setup(t); await relay.connect();
  const pending = relay.speech(), command = await relay.next();
  await relay.browser('result', { id: command.job.id, ok: true, audioBase64: audio.toString('base64'),
    before: { ...before, apiCredit: 1 }, after: { ...after, apiCredit: 0.99 } });
  assert.equal((await pending).status, 200);
  assert.equal((await relay.speech()).status, 503);
  const status = await (await fetch(relay.base + '/api/browser/status')).json();
  assert.match(status.lastError, /API 余额减少/);
});

test('bridge queue is bounded and silent client expiry rejects work', async () => {
  const bridge = createBrowserBridge({ relayKey: 'bounded-test', leaseMs: 30, pollMs: 10, maxPending: 1 });
  try {
    const client = randomUUID(); bridge.connect(client, BRIDGE_VERSION);
    const first = bridge.enqueue({ kind: 'balance' }).catch(error => error);
    await assert.rejects(bridge.enqueue({ kind: 'balance' }), error => error.status === 429);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal((await first).status, 503);
    assert.equal(bridge.status().connected, false);
  } finally { bridge.close(); }
});
