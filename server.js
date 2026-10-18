import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { createRelay } from './relay.js';
import { localIPv4Addresses } from './network.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.FISH_RELAY_PORT || 17863);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('FISH_RELAY_PORT 必须为 1024–65535 的端口。');
  process.exit(1);
}

// Opt-in local network mode: `Start-手机可用.bat` sets FISH_RELAY_LAN=1.
const lan = /^(1|true|yes|on)$/i.test(String(process.env.FISH_RELAY_LAN || ''));
const extraOrigins = String(process.env.FISH_RELAY_ORIGINS || '')
  .split(',').map(value => value.trim().replace(/\/+$/, '')).filter(Boolean);

// A relay started earlier may hold only 127.0.0.1, which does not stop this
// process from also binding 0.0.0.0 on the same port. Both would then answer,
// the management page would look healthy through loopback while the phone
// reached the newer process with no Fish pairing, and every request would come
// back 503. Refuse to start a second one instead.
async function alreadyRunning(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return (await response.json())?.service === 'fish-audio-relay';
  } catch { return false; }
}

if (await alreadyRunning(port)) {
  console.error(`端口 ${port} 上已经有一个中转在运行。请先关掉它的服务窗口（按 Ctrl+C，或直接关闭窗口），再启动这一个。`);
  process.exit(1);
}

try {
  const store = await openStore(path.join(directory, 'data'));
  const relay = await createRelay({ store, lan, extraOrigins });
  await new Promise((resolve, reject) => {
    relay.server.once('error', reject);
    relay.server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', resolve);
  });
  const addresses = lan ? localIPv4Addresses() : [];
  console.log('Fish Audio 私人中转已启动');
  console.log(`管理页面：http://127.0.0.1:${port}/`);
  console.log(`酒馆接口：http://127.0.0.1:${port}/v1/audio/speech`);
  if (!lan) {
    console.log('仅监听本机，手机酒馆无法访问。想在手机上使用，请改双击「Start-手机可用.bat」。');
  } else if (!addresses.length) {
    console.log('已开启局域网模式，但没有找到可用的局域网地址，请检查 Wi-Fi 或网线。');
  } else {
    for (const address of addresses) console.log(`手机酒馆中转地址：http://${address}:${port}`);
    console.log('手机需与本机连同一个 Wi-Fi；管理页面仍只允许在本机打开。');
  }
  console.log('关闭此窗口或按 Ctrl+C 即可停止。');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  console.error(error.code === 'EADDRINUSE'
    ? `端口 ${port} 已占用。若中转已运行，请直接打开管理页面；否则设置 FISH_RELAY_PORT 更换端口。`
    : `启动失败：${error.message}`);
  process.exit(1);
}
