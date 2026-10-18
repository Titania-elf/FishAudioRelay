import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { connectFromFish } from '../tools/fish-page-bridge.js';

function fishPage({ quota = 1000, team = null, workspace = null } = {}) {
  let listener;
  const sent = [];
  const requests = [];
  const popup = { postMessage: (value, origin) => sent.push({ value, origin }) };
  const localOrigin = 'http://127.0.0.1:17865';
  const token = 'test-private-login-token';
  const context = vm.createContext({
    window: { open: () => popup, addEventListener: (_, callback) => { listener = callback; }, removeEventListener() {} },
    location: { origin: 'https://fish.audio', href: 'https://fish.audio/app/text-to-speech' },
    localStorage: { getItem: key => ({ token, active_team_id: team, active_workspace_id: workspace })[key] ?? null },
    document: { cookie: '' },
    alert: () => assert.fail('Unexpected alert'),
    URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      // A voice permission response marks entry into the generation flow,
      // without invoking the site's browser verification module in this test.
      if (url.endsWith('/model/latest-used')) return { ok: false, status: 403, json: async () => ({}) };
      const data = url.endsWith('/user/self') ? { _id: 'our-account', email: 'private@example.com' }
        : url.endsWith('/package') ? { type: 'plus', balance: quota, total: 1000, stripe_subscription_id: 'private-billing-id' }
        : { credit: '0.125', privatePaymentField: 'private-payment-data' };
      return { ok: true, json: async () => data };
    },
  });
  vm.runInContext(`(${connectFromFish.toString()})(${JSON.stringify(localOrigin)}, 'ticket');`, context);
  return { sent, requests, token, popup, localOrigin,
    message: data => listener({ source: popup, origin: localOrigin, data: { ticket: 'ticket', ...data } }),
    raw: event => listener(event),
  };
}

test('browser bridge only accepts commands from the paired local window', async () => {
  const page = fishPage();
  const data = { type: 'job', ticket: 'ticket', job: { id: '1', kind: 'balance' } };
  await page.raw({ source: {}, origin: page.localOrigin, data });
  await page.raw({ source: page.popup, origin: 'https://unrelated.example', data });
  await page.raw({ source: page.popup, origin: page.localOrigin, data: { ...data, ticket: 'wrong' } });
  assert.equal(page.requests.length, 0);
  assert.equal(page.sent.length, 0);
});

test('balance diagnostics omit credentials, email and payment identifiers', async () => {
  const page = fishPage();
  await page.message({ type: 'job', job: { id: '1', kind: 'balance' } });
  assert.equal(page.requests.length, 3);
  assert.equal(page.sent[0].value.result.balance.package.balance, 1000);
  assert.equal(page.sent[0].value.result.balance.api.credit, '0.125');
  const payload = JSON.stringify(page.sent);
  for (const secret of [page.token, 'private@example.com', 'private-billing-id', 'private-payment-data', 'our-account']) assert.ok(!payload.includes(secret));
});

test('personal subscription with a selected team enters generation using that team and workspace', async () => {
  const page = fishPage({ team: 'personal-team', workspace: 'personal-workspace' });
  await page.message({ type: 'job', job: { id: '1', kind: 'generate', text: 'Hello' } });
  assert.equal(page.requests.at(-1).url, 'https://api.fish.audio/model/latest-used');
  for (const { options } of page.requests) {
    assert.equal(options.headers['x-team-id'], 'personal-team');
    assert.equal(options.headers['x-workspace-id'], 'personal-workspace');
  }
  assert.match(page.sent[0].value.result.error, /Fish HTTP 403/);
  assert.doesNotMatch(page.sent[0].value.result.error, /切换到个人空间/);
});

test('no subscription quota stops the test before any generation request', async () => {
  const page = fishPage({ quota: 0 });
  await page.message({ type: 'job', job: { id: '1', kind: 'generate', text: 'Hello' } });
  assert.equal(page.sent[0].value.result.ok, false);
  assert.match(page.sent[0].value.result.error, /未提交生成/);
  assert.ok(page.requests.every(request => !request.options.method));
  assert.ok(page.requests.every(request => !request.url.includes('/task') && !request.url.includes('/v1/tts')));
});
