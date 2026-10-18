import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { translateSpeech } from '../relay.js';

// Read the installed plugin without modifying it. By default only empty
// connection probes are sent; --generate explicitly requests one short clip.
const pluginPath = process.argv[2];
if (!pluginPath) throw new Error('Usage: node tools/verify-iphonie.mjs <ST-iPhonie directory> [--model=drama-3] [--generate]');
const { buildRequest, Providers } = await import(pathToFileURL(path.join(pluginPath, 'core/providers.js')));
const { TTSParameters: P } = await import(pathToFileURL(path.join(pluginPath, 'core/parameters.js')));
const base = 'http://127.0.0.1:17863';
const origin = 'http://localhost:8000';
const settingsResponse = await fetch(base + '/api/config');
assert.equal(settingsResponse.status, 200);
const settings = await settingsResponse.json();
assert.equal(settings.provider, 'web', 'Expected the webpage subscription provider');
const referenceId = settings.voices.find(voice => voice.name === settings.defaultVoice)?.referenceId;
assert.match(referenceId || '', /^[a-f0-9]{32}$/i);
const trace = [];
// Node does not enforce browser CORS. Check the preflight and response headers
// explicitly, using the same requests that the plugin would send in a browser.
const providers = new Providers(async (url, init) => {
  assert.equal(new URL(url).origin, base, 'The plugin must only call the local relay');
  const method = init.method || 'GET';
  const headerNames = [...new Headers(init.headers).keys()];
  const preflight = await fetch(url, { method: 'OPTIONS', headers: {
    Origin: origin, 'Access-Control-Request-Method': method,
    'Access-Control-Request-Headers': headerNames.join(','),
  }, signal: init.signal });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-methods'), method);
  const allowedHeaders = preflight.headers.get('access-control-allow-headers').toLowerCase().split(',').map(value => value.trim());
  assert.ok(headerNames.every(header => allowedHeaders.includes(header)));
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  const headers = new Headers(init.headers); headers.set('Origin', origin);
  const response = await fetch(url, { ...init, headers });
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  trace.push({ method, path: new URL(url).pathname, status: response.status, cors: true });
  return response;
});
providers.setKey('fish', settings.relayKey);
const model = process.argv.find(arg => arg.startsWith('--model='))?.slice(8) || settings.model;
const connection = { model, params: { ...P.defaults('fish'), 'prosody.speed': 1.1 }, relay: base, relayApi: 'fish' };
const probe = await providers.probeFish(connection);
assert.equal(probe.detected, 'openai');
assert.equal(probe.compat.status, 404);
assert.equal(probe.speech.status, 400);
connection.relayApi = probe.detected;
const request = buildRequest('fish', connection, { voice: referenceId }, { text: '你好，这是插件语音测试。', emotion: 'happy' });
assert.equal(request.url, base + '/v1/audio/speech');
assert.equal(request.body.voice, referenceId);
assert.equal(request.body.speed, 1.1);
assert.equal(request.body.response_format, 'mp3');
assert.match(request.body.input, /^\[happy\]/);
assert.equal(request.viaTavern, undefined, 'OpenAI relay requests must not use the official API proxy');
assert.equal(request.body.model, model);
const translated = translateSpeech(request.body, settings);
assert.equal(translated.model, model);
assert.equal(translated.payload.reference_id, referenceId);
assert.equal(translated.payload.text, request.body.input);
let audio = null, stats = null;
if (process.argv.includes('--generate')) {
  const status = await (await fetch(base + '/api/browser/status')).json();
  assert.equal(status.connected, true, 'Reconnect the Fish popup before generating');
  assert.equal(status.generating, false); assert.equal(status.queued, 0);
  const blob = await providers.synthesize(request, new AbortController().signal);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(blob.type, 'audio/mpeg');
  assert.ok(bytes.length > 1000);
  assert.ok(bytes.some((value, i) => value === 0xff && (bytes[i + 1] & 0xe0) === 0xe0), 'Expected an MPEG frame');
  audio = { type: blob.type, bytes: bytes.length };
  stats = (await (await fetch(base + '/api/browser/status')).json()).lastStats;
}
console.log(JSON.stringify({ detected: probe.detected, trace,
  request: { model: request.body.model, rawVoiceId: true, speed: request.body.speed,
    emotionTag: true, utf8Bytes: Buffer.byteLength(request.body.input) },
  generated: Boolean(audio), audio, stats }, null, 2));
