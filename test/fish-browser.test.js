import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { connectFish } from '../public/fish-browser.js';
import { BRIDGE_VERSION, WEB_MODELS } from '../browser-bridge.js';

test('embedded bookmark advertises the current version and accepts every relay model before website verification', async () => {
  const origin = 'http://127.0.0.1:17863';
  const key = 'test-local-bridge-key';
  let listener, verificationChecks = 0;
  const sent = [], requests = [];
  const popup = { postMessage: (value, target) => { assert.equal(target, origin); sent.push(value); } };
  const context = vm.createContext({
    window: { open: () => popup, addEventListener: (_, fn) => { listener = fn; }, removeEventListener() {} },
    location: { origin: 'https://fish.audio' },
    localStorage: { getItem: name => ({ token: 'page-token', active_team_id: 'personal-team', active_workspace_id: 'personal-workspace' })[name] || null },
    document: { cookie: '' }, alert: () => assert.fail('Unexpected alert'),
    AbortController, setTimeout, clearTimeout,
    // No loaded verification asset: a supported request must reach SITE_CHANGED
    // rather than fail model validation. No paid generation is possible here.
    performance: { getEntriesByType: () => { verificationChecks++; return []; } },
    fetch: async (url, options) => {
      requests.push(url);
      assert.equal(options.method, undefined);
      assert.equal(options.headers.Authorization, 'Bearer page-token');
      assert.equal(options.headers['x-team-id'], 'personal-team');
      assert.equal(options.headers['x-workspace-id'], 'personal-workspace');
      const data = url.endsWith('/user/self') ? { _id: 'test-user' }
        : url.endsWith('/package') ? { type: 'plus', balance: 1000, total: 1000, extra_balance: 0 }
          : { credit: 0 };
      return { ok: true, json: async () => data };
    },
  });
  vm.runInContext(`(${connectFish.toString()})(${JSON.stringify(origin)}, ${JSON.stringify(key)})`, context);
  const message = data => listener({ source: popup, origin, data: { key, ...data } });
  await message({ type: 'hello', nonce: 'test-hello' });
  assert.equal(sent.at(-1).version, BRIDGE_VERSION);
  assert.equal(sent.at(-1).nonce, 'test-hello');
  for (const model of WEB_MODELS) {
    const before = verificationChecks;
    await message({ type: 'job', job: { id: model, kind: 'speech', model,
      referenceId: '1234567890abcdef1234567890abcdef', text: '[happy] 你好。', speed: 1.1 } });
    assert.equal(verificationChecks, before + 1, model);
    assert.equal(sent.at(-1).code, 'SITE_CHANGED', model);
  }
  for (const model of ['drama-3-preview', 'unknown-model']) {
    const before = verificationChecks;
    await message({ type: 'job', job: { id: model, kind: 'speech', model,
      referenceId: '1234567890abcdef1234567890abcdef', text: 'Test', speed: 1 } });
    assert.equal(verificationChecks, before);
    assert.equal(sent.at(-1).code, 'INVALID_REQUEST');
  }
  assert.ok(requests.every(url => !url.includes('/task') && !url.includes('/v1/tts')));
  assert.ok(!JSON.stringify(sent).includes('page-token'));
});
