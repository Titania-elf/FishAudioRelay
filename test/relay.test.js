import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createRelay } from '../relay.js';
import { MAX_TEXT_LENGTH, validateSettings } from '../store.js';

const fishKey = 'fish-test-secret-never-send-to-browser';
const relayKey = 'relay-test-secret-never-send-to-fish';
const referenceId = '1234567890abcdef1234567890abcdef';
const audioBytes = Uint8Array.from([0x49, 0x44, 0x33, 0, 255, 0x10, 0, 0x7f]);

function memoryStore(overrides = {}) {
  let config = {
    fishApiKey: fishKey,
    relayKey,
    model: 's2.1-pro',
    voices: [{ name: 'reader', referenceId }, { name: 'default', referenceId: '' }],
    defaultVoice: 'reader',
    ...overrides,
  };
  const updates = [];
  return {
    updates,
    get: () => structuredClone(config),
    async update(value) {
      updates.push(structuredClone(value));
      config = { ...config, ...validateSettings(value), fishApiKey: value.fishApiKey || config.fishApiKey };
      return structuredClone(config);
    },
  };
}

async function startRelay(t, { upstream, config, timeoutMs } = {}) {
  const calls = [];
  const logs = [];
  const store = memoryStore(config);
  const relay = await createRelay({
    store,
    timeoutMs,
    logger: { info: message => logs.push(message), warn: message => logs.push(message) },
    fetchImpl: async (...args) => {
      calls.push(args);
      return upstream ? upstream(...args) : new Response(audioBytes, { headers: { 'Content-Type': 'audio/mpeg' } });
    },
  });
  t.after(() => relay.close());
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  return {
    base, calls, logs, store,
    request: (route, init) => fetch(`${base}${route}`, init),
    speech: (body = { input: 'Hello' }, headers = {}) => fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relayKey}`, ...headers },
      body: JSON.stringify(body),
    }),
  };
}

async function expectError(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /^application\/json\b/);
  const body = await response.json();
  assert.equal(body.error.type, 'relay_error');
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
  return body;
}

test('OpenAI speech request reaches the real Fish endpoint with mapped headers/body and identical MP3 bytes', async t => {
  const relay = await startRelay(t);
  const input = '朗读：A & B\nsecond line';
  const response = await relay.speech({
    model: 's2-pro', input, voice: 'reader', response_format: 'mp3', speed: 1.25,
    unknownClientField: 'must not reach Fish',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audioBytes);
  assert.equal(relay.calls.length, 1);
  const [url, init] = relay.calls[0];
  assert.equal(url, 'https://api.fish.audio/v1/tts');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${fishKey}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.model, 's2-pro');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(init.body), {
    text: input, format: 'mp3', reference_id: referenceId, prosody: { speed: 1.25 },
  });
  assert.ok(!JSON.stringify(init.headers).includes(relayKey));
});

test('OpenAI default models and omitted settings use the saved Fish model/default voice', async t => {
  const relay = await startRelay(t);
  for (const model of [undefined, 'tts-1', 'tts-1-hd']) {
    const response = await relay.speech({ input: 'Default model', model });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    const [, init] = relay.calls.at(-1);
    assert.equal(init.headers.model, 's2.1-pro');
    assert.deepEqual(JSON.parse(init.body), {
      text: 'Default model', format: 'mp3', reference_id: referenceId, prosody: { speed: 1 },
    });
  }
  const response = await relay.speech({ input: 'Voice without reference', voice: 'default' });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(Object.hasOwn(JSON.parse(relay.calls.at(-1)[1].body), 'reference_id'), false);
});

test('unknown voice, unsupported formats, bad text/model and invalid speeds are rejected before Fish', async t => {
  const relay = await startRelay(t);
  const cases = [
    [{ input: 'Text', voice: 'alloy' }, 400],
    [{ input: 'Text', voice: 7 }, 400],
    [{ input: 'Text', response_format: 'wav' }, 400],
    [{ input: 'Text', response_format: 'opus' }, 400],
    [{ input: '' }, 400],
    [{ input: ' \n\t' }, 400],
    [{ input: 42 }, 400],
    [{ input: ['text'] }, 400],
    [{}, 400],
    [{ input: 'Text', model: 'bad model' }, 400],
    [{ input: 'Text', model: 'a'.repeat(81) }, 400],
    [{ input: 'Text', speed: 0.49 }, 400],
    [{ input: 'Text', speed: 2.01 }, 400],
    [{ input: 'Text', speed: '1' }, 400],
    [{ input: 'Text', speed: false }, 400],
  ];
  for (const [body, status] of cases) {
    await expectError(await relay.speech(body), status);
  }
  assert.equal(relay.calls.length, 0);
});

test('speed 0.5 and 2 are accepted exactly at the Fish boundaries', async t => {
  const relay = await startRelay(t);
  for (const speed of [0.5, 2]) {
    const response = await relay.speech({ input: 'Boundary', speed });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(JSON.parse(relay.calls.at(-1)[1].body).prosody.speed, speed);
  }
});

test('text limit counts Unicode characters and rejects over-limit input without contacting Fish', async t => {
  const relay = await startRelay(t);
  const input = '😀'.repeat(MAX_TEXT_LENGTH);
  const response = await relay.speech({ input });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(JSON.parse(relay.calls[0][1].body).text, input);
  await expectError(await relay.speech({ input: `${input}字` }), 413);
  assert.equal(relay.calls.length, 1);
});

test('JSON/content-type/body size errors produce local errors', async t => {
  const relay = await startRelay(t);
  const send = (body, contentType = 'application/json') => relay.request('/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${relayKey}`, 'Content-Type': contentType }, body,
  });
  await expectError(await send('{bad json'), 400);
  await expectError(await send('[]'), 400);
  await expectError(await send('null'), 400);
  await expectError(await send('"string"'), 400);
  await expectError(await send('{"input":"Text"}', 'text/plain'), 415);
  await expectError(await send(JSON.stringify({ input: 'x'.repeat(66000) })), 413);
  assert.equal(relay.calls.length, 0);
});

test('relay KEY is checked before parsing request bodies or making any upstream calls', async t => {
  const relay = await startRelay(t);
  for (const authorization of [undefined, 'Bearer wrong', `Basic ${relayKey}`, `bearer ${relayKey}`, `Bearer ${fishKey}`]) {
    const headers = { 'Content-Type': 'text/plain' };
    if (authorization) headers.Authorization = authorization;
    await expectError(await relay.request('/v1/audio/speech', { method: 'POST', headers, body: '{invalid json' }), 401);
    await expectError(await relay.request('/v1/models', { headers }), 401);
  }
  assert.equal(relay.calls.length, 0);
  const response = await relay.request('/v1/models', { headers: { Authorization: `Bearer ${relayKey}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { object: 'list', data: [{ id: 's2.1-pro', object: 'model', owned_by: 'fish-audio-relay' }] });
});

test('public config and browser assets expose relay setup but never the Fish API KEY', async t => {
  const relay = await startRelay(t);
  const response = await relay.request('/api/config');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.fishKeyConfigured, true);
  assert.equal(body.relayKey, relayKey);
  assert.equal(body.endpoint, `${relay.base}/v1/audio/speech`);
  assert.equal(body.maxTextLength, MAX_TEXT_LENGTH);
  assert.match(body.csrfToken, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(body, 'fishApiKey'), false);
  assert.ok(!JSON.stringify(body).includes(fishKey));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const route of ['/', '/app.js', '/style.css']) {
    const asset = await relay.request(route);
    assert.equal(asset.status, 200);
    assert.ok(!(await asset.text()).includes(fishKey));
    assert.equal(asset.headers.get('x-frame-options'), 'DENY');
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('Host and cross-origin requests cannot reach configuration or generation', async t => {
  const relay = await startRelay(t);
  // Node fetch may normalize/ignore a caller-supplied Host header. Send these
  // cases over raw HTTP so the test actually exercises an invalid wire Host.
  const rawRequest = (route, headers, body) => new Promise((resolve, reject) => {
    const request = httpRequest(relay.base + route, { method: body ? 'POST' : 'GET', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.on('error', reject);
    request.end(body);
  });
  for (const headers of [
    { Host: 'evil.example' },
    { Host: `127.0.0.1:${new URL(relay.base).port}.evil.example` },
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
    { Origin: `https://127.0.0.1:${new URL(relay.base).port}` },
  ]) {
    const response = headers.Host ? await rawRequest('/api/config', headers) : await relay.request('/api/config', { headers });
    await expectError(response, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    await expectError(headers.Host ? await rawRequest('/v1/audio/speech', { ...headers, 'Content-Type': 'application/json', Authorization: `Bearer ${relayKey}` }, JSON.stringify({ input: 'Must not synthesize' }))
      : await relay.speech({ input: 'Must not synthesize' }, headers), 403);
  }
  await expectError(await relay.request('/api/config', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403);
  assert.equal(relay.calls.length, 0);
  assert.equal(relay.store.updates.length, 0);
  const sameOrigin = await relay.request('/api/config', { headers: { Origin: relay.base } });
  assert.equal(sameOrigin.status, 200);
  await sameOrigin.arrayBuffer();
});

test('management writes/preview require the current CSRF token, while valid local saves hide new Fish KEY', async t => {
  const relay = await startRelay(t);
  const initial = await (await relay.request('/api/config')).json();
  const settings = { model: 's2-pro', voices: [{ name: 'default', referenceId: '' }], defaultVoice: 'default', fishApiKey: 'replacement-test-fish-secret' };
  for (const route of ['/api/config', '/api/preview']) {
    for (const token of [undefined, 'wrong-token']) {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-CSRF-Token'] = token;
      await expectError(await relay.request(route, { method: 'POST', headers, body: JSON.stringify(settings) }), 403);
    }
  }
  assert.equal(relay.store.updates.length, 0);
  assert.equal(relay.calls.length, 0);
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': initial.csrfToken, Origin: relay.base };
  const saved = await relay.request('/api/config', { method: 'POST', headers, body: JSON.stringify(settings) });
  assert.equal(saved.status, 200);
  const publicSettings = await saved.json();
  assert.equal(publicSettings.model, 's2-pro');
  assert.equal(publicSettings.fishKeyConfigured, true);
  assert.ok(!JSON.stringify(publicSettings).includes(settings.fishApiKey));
  assert.equal(relay.store.updates.length, 1);
  const preview = await relay.request('/api/preview', { method: 'POST', headers, body: JSON.stringify({ input: 'Local preview' }) });
  assert.equal(preview.status, 200);
  assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), audioBytes);
  assert.equal(relay.calls.at(-1)[1].headers.Authorization, `Bearer ${settings.fishApiKey}`);
});

test('missing Fish KEY fails locally with an actionable service-unavailable response', async t => {
  const relay = await startRelay(t, { config: { fishApiKey: '' } });
  await expectError(await relay.speech(), 503);
  assert.equal(relay.calls.length, 0);
  const config = await (await relay.request('/api/config')).json();
  assert.equal(config.fishKeyConfigured, false);
});

test('Fish 401/429 and other upstream failures preserve useful status without leaking provider bodies/secrets', async t => {
  for (const [upstreamStatus, relayStatus] of [[401, 401], [429, 429], [500, 502]]) {
    await t.test(`upstream HTTP ${upstreamStatus}`, async t => {
      const providerError = `${fishKey} ${relayKey} private-user-text provider diagnostic`;
      const relay = await startRelay(t, {
        upstream: async () => new Response(providerError, { status: upstreamStatus, headers: { 'Content-Type': 'application/json' } }),
      });
      const body = await expectError(await relay.speech({ input: 'private-user-text' }), relayStatus);
      const exposed = JSON.stringify(body) + relay.logs.join('\n');
      for (const secret of [fishKey, relayKey, 'private-user-text', 'provider diagnostic']) assert.ok(!exposed.includes(secret));
      assert.equal(relay.calls.length, 1);
    });
  }
});

test('non-audio, empty audio and absent upstream bodies return JSON 502 before audio headers', async t => {
  const cases = [
    ['JSON disguised as successful result', () => new Response('{"error":"no audio"}', { headers: { 'Content-Type': 'application/json' } })],
    ['empty MP3', () => new Response(new Uint8Array(), { headers: { 'Content-Type': 'audio/mpeg' } })],
    ['no body', () => new Response(null, { headers: { 'Content-Type': 'audio/mpeg' } })],
  ];
  for (const [name, upstream] of cases) {
    await t.test(name, async t => {
      const relay = await startRelay(t, { upstream });
      await expectError(await relay.speech(), 502);
    });
  }
});

test('upstream timeout aborts the request and returns JSON 504; the relay can generate again', async t => {
  let attempts = 0;
  let observedSignal;
  const relay = await startRelay(t, {
    timeoutMs: 30,
    upstream: async (_url, { signal }) => {
      if (++attempts > 1) return new Response(audioBytes, { headers: { 'Content-Type': 'audio/mpeg' } });
      observedSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    },
  });
  await expectError(await relay.speech(), 504);
  assert.equal(observedSignal.aborted, true);
  const response = await relay.speech();
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audioBytes);
});
