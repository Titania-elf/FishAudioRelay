import { openStore } from '../store.js';
import { WEB_MODELS } from '../browser-bridge.js';
import { fileURLToPath } from 'node:url';

// Run once after verifying a voice through the user's web subscription.
const referenceId = process.argv[2];
if (!/^[a-fA-F0-9]{32}$/.test(referenceId || '')) throw new Error('Provide the verified 32-character voice ID.');
const store = await openStore(fileURLToPath(new URL('../data/', import.meta.url)));
const current = store.get();
const voices = current.voices.map(voice => voice.name === current.defaultVoice && !voice.referenceId ? { ...voice, referenceId } : voice);
await store.update({ provider: 'web', model: WEB_MODELS.includes(current.model) ? current.model : 's2.1-pro', voices, defaultVoice: current.defaultVoice });
console.log(JSON.stringify({ provider: 'web', voices, defaultVoice: current.defaultVoice, configured: true }));
