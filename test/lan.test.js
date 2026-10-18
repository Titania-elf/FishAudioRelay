import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRelay } from '../relay.js';
import { isPrivateAddress, isPrivateOrigin, localIPv4Addresses } from '../network.js';
import { validateSettings } from '../store.js';

const fishKey = 'fish-test-secret-never-send-to-browser';
const relayKey = 'relay-test-secret-never-send-to-fish';
const referenceId = '1234567890abcdef1234567890abcdef';
const audioBytes = Uint8Array.from([0x49, 0x44, 0x33, 0, 255, 0x10, 0, 0x7f]);
const lanAddresses = localIPv4Addresses();
const noLan = lanAddresses.length === 0;

function memoryStore() {
  const config = {
    fishApiKey: fishKey,
    relayKey,
    model: 's2.1-pro',
    voices: [{ name: 'reader', referenceId }],
    defaultVoice: 'reader',
  };
  return {
    get: () => structuredClone(config),
    async update(value) {
      return structuredClone({ ...config, ...validateSettings(value) });
    },
  };
}

async function startRelay(t, { lan = false, extraOrigins = [] } = {}) {
  const calls = [];
  const store = memoryStore();
  const relay = await createRelay({
    store, lan, extraOrigins,
    logger: { info() {}, warn() {} },
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(audioBytes, { headers: { 'Content-Type': 'audio/mpeg' } });
    },
  });
  t.after(() => relay.close());
  relay.server.listen(0, lan ? '0.0.0.0' : '127.0.0.1');
  await once(relay.server, 'listening');
  const port = relay.server.address().port;
  return {
    calls,
    // Node keeps the caller's own network address on the connection, so these
    // requests really do look like a phone on the same network to the relay.
    local: `http://127.0.0.1:${port}`,
    lan: lanAddresses.length ? `http://${lanAddresses[0]}:${port}` : '',
    port,
  };
}

async function expectError(response, status) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.type, 'relay_error');
  return body;
}

function speech(base, headers = {}, body = { input: '手机朗读' }) {
  return fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relayKey}`, ...headers },
    body: JSON.stringify(body),
  });
}

test('address helpers accept a home network and refuse anything routable from outside', () => {
  for (const address of ['192.168.2.5', '10.0.0.9', '172.16.0.1', '172.31.255.254', '127.0.0.1', '::ffff:192.168.1.7']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '198.18.0.1', '203.0.113.9', 'not-an-address', undefined]) {
    assert.equal(isPrivateAddress(address), false, String(address));
  }
  for (const origin of ['http://192.168.2.5:8000', 'http://10.1.2.3:8000', 'http://127.0.0.1:8000']) {
    assert.equal(isPrivateOrigin(origin), true, origin);
  }
  for (const origin of ['https://192.168.2.5:8000', 'http://evil.example:8000', 'http://198.18.0.1:8000', 'null', '']) {
    assert.equal(isPrivateOrigin(origin), false, origin);
  }
  for (const address of lanAddresses) assert.equal(isPrivateAddress(address), true, address);
});

test('a tavern on the local network cannot reach the relay while local-network mode is off', async t => {
  const relay = await startRelay(t);
  const origin = `http://${lanAddresses[0] ?? '192.168.2.5'}:8000`;
  await expectError(await fetch(`${relay.local}/api/config`, { headers: { Origin: origin } }), 403);
  await expectError(await speech(relay.local, { Origin: origin }), 403);
  // The optional extra origin list is the only way in while the mode is off.
  assert.equal(relay.calls.length, 0);
});

test('extra origins from FISH_RELAY_ORIGINS are accepted on the speech route only', async t => {
  const relay = await startRelay(t, { extraOrigins: ['http://desktop.lan:8000'] });
  const response = await speech(relay.local, { Origin: 'http://desktop.lan:8000' });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(relay.calls.length, 1);
  await expectError(await fetch(`${relay.local}/api/config`, { headers: { Origin: 'http://desktop.lan:8000' } }), 403);
});

test('local-network mode lets a phone synthesize but keeps management on this computer', { skip: noLan }, async t => {
  const relay = await startRelay(t, { lan: true });
  const tavern = `http://${lanAddresses[0]}:8000`;

  const preflight = await fetch(`${relay.lan}/v1/audio/speech`, {
    method: 'OPTIONS',
    headers: {
      Origin: tavern,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), tavern);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');

  const response = await speech(relay.lan, { Origin: tavern });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), tavern);
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audioBytes);
  assert.equal(relay.calls.length, 1);

  const models = await fetch(`${relay.lan}/v1/models`, {
    headers: { Origin: tavern, Authorization: `Bearer ${relayKey}` },
  });
  assert.equal(models.status, 200);
  assert.equal(models.headers.get('access-control-allow-origin'), tavern);
  await models.arrayBuffer();

  for (const [route, init] of [
    ['/api/config', {}],
    ['/api/browser/status', {}],
    ['/api/browser/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
    ['/', {}],
    ['/health', {}],
  ]) {
    const blocked = await fetch(`${relay.lan}${route}`, { ...init, headers: { ...init.headers, Origin: tavern } });
    await expectError(blocked, 403);
    assert.equal(blocked.headers.get('access-control-allow-origin'), null, route);
  }

  // A page that is not on this network still cannot use the speech route.
  await expectError(await speech(relay.lan, { Origin: 'https://evil.example' }), 403);
  await expectError(await speech(relay.lan, { Origin: 'https://127.0.0.1:8000' }), 403);
  assert.equal(relay.calls.length, 1);

  // The relay KEY still guards generation from the phone.
  await expectError(await fetch(`${relay.lan}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: tavern, Authorization: 'Bearer wrong-key' },
    body: JSON.stringify({ input: '手机朗读' }),
  }), 401);
  assert.equal(relay.calls.length, 1);
});

test('local-network mode still serves the management page over loopback', { skip: noLan }, async t => {
  const relay = await startRelay(t, { lan: true });
  const config = await fetch(`${relay.local}/api/config`, { headers: { Origin: relay.local } });
  assert.equal(config.status, 200);
  const body = await config.json();
  assert.equal(body.endpoint, `${relay.local}/v1/audio/speech`);
  assert.equal(body.lanEndpoint, `${relay.lan}/v1/audio/speech`);
  assert.ok(!JSON.stringify(body).includes(fishKey));
});
