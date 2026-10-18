import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../store.js';

test('Windows DPAPI persists encrypted credentials and restores settings after restart', { skip: process.platform !== 'win32' }, async t => {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(temporaryRoot, 'fish-audio-relay-test-'));
  const resolvedDirectory = await realpath(directory);
  assert.equal(path.dirname(resolvedDirectory).toLowerCase(), temporaryRoot.toLowerCase());
  assert.match(path.basename(resolvedDirectory), /^fish-audio-relay-test-/);
  t.after(async () => {
    // Only remove the exact mkdtemp directory after verifying its parent and prefix.
    const finalDirectory = await realpath(directory);
    assert.equal(finalDirectory, resolvedDirectory);
    assert.equal(path.dirname(finalDirectory).toLowerCase(), temporaryRoot.toLowerCase());
    assert.match(path.basename(finalDirectory), /^fish-audio-relay-test-/);
    await rm(finalDirectory, { recursive: true });
  });

  const store = await openStore(directory);
  const initial = store.get();
  assert.equal(initial.provider, 'web');
  assert.match(initial.relayKey, /^fish-relay-[a-f0-9]{64}$/);
  const fishApiKey = 'DPAPI-test-fish-plain-secret-should-never-appear-on-disk';
  const settings = {
    provider: 'web',
    model: 's2-pro',
    voices: [{ name: 'my-reader', referenceId: 'abcdefabcdefabcdefabcdefabcdefab' }],
    defaultVoice: 'my-reader',
    fishApiKey,
  };
  await store.update(settings);
  const persistedText = await readFile(path.join(directory, 'config.json'), 'utf8');
  const persisted = JSON.parse(persistedText);
  assert.ok(!persistedText.includes(fishApiKey));
  assert.ok(!persistedText.includes(initial.relayKey));
  assert.ok(!persistedText.includes(Buffer.from(fishApiKey).toString('base64')));
  assert.ok(!persistedText.includes(Buffer.from(initial.relayKey).toString('base64')));
  assert.equal(Object.hasOwn(persisted, 'fishApiKey'), false);
  assert.equal(Object.hasOwn(persisted, 'relayKey'), false);
  assert.ok(persisted.fishKeyProtected.length > 0);
  assert.ok(persisted.relayKeyProtected.length > 0);
  assert.deepEqual(await readdir(directory), ['config.json']);

  const restarted = await openStore(directory);
  assert.deepEqual(restarted.get(), { ...settings, relayKey: initial.relayKey });
  const snapshot = restarted.get();
  snapshot.voices[0].name = 'mutated-client-copy';
  snapshot.fishApiKey = 'mutated-client-copy';
  assert.equal(restarted.get().voices[0].name, 'my-reader');
  assert.equal(restarted.get().fishApiKey, fishApiKey);

  await restarted.update({ ...settings, model: 's2.1-pro', fishApiKey: '' });
  const restartedAgain = await openStore(directory);
  assert.equal(restartedAgain.get().fishApiKey, fishApiKey);
  assert.equal(restartedAgain.get().relayKey, initial.relayKey);
  assert.equal(restartedAgain.get().model, 's2.1-pro');
});
