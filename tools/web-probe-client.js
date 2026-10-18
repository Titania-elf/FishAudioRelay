/* global CONTROL */
const statusElement = document.getElementById('status');
const resultElement = document.getElementById('result');
const ticket = location.pathname === '/bridge' ? location.hash.slice(1) : '';
history.replaceState(null, '', location.pathname);
let connected = false;
let pendingId = null;
let lastFinished = null;
let audioUrl = null;
const call = async (path, data, key = CONTROL) => {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Probe-Key': key }, body: JSON.stringify(data) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '本机请求失败。');
  return value;
};
const send = message => window.opener?.postMessage({ ...message, ticket }, 'https://fish.audio');
window.addEventListener('message', async event => {
  if (!ticket || event.origin !== 'https://fish.audio' || event.source !== window.opener || event.data?.ticket !== ticket) return;
  if (event.data.type === 'ready') connected = true;
  if (event.data.type === 'result' && event.data.id === pendingId) {
    try { await call('/api/result', { id: pendingId, result: event.data.result }, ticket); }
    catch (error) { resultElement.textContent = error.message; }
    pendingId = null;
  }
});
async function poll() {
  try {
    if (ticket) {
      if (!window.opener || window.opener.closed) throw new Error('Fish 标签页已关闭，请重新连接。');
      if (!connected) send({ type: 'hello' });
      else {
        const value = await call('/api/poll', {}, ticket);
        if (value.job) { pendingId = value.job.id; send({ type: 'job', job: value.job }); }
      }
    }
    const state = await (await fetch('/api/status')).json();
    statusElement.textContent = state.busy ? '正在验证，请保持两个窗口打开…' : state.connected ? '已连接到你的 Fish 标签页' : '等待连接 Fish 网页';
    document.getElementById('instructions').hidden = state.connected || Boolean(ticket);
    document.getElementById('connected').hidden = !state.connected;
    for (const id of ['balance', 'generate']) document.getElementById(id).disabled = state.busy;
    if (state.result?.finishedAt !== lastFinished) {
      lastFinished = state.result?.finishedAt;
      resultElement.textContent = state.result ? JSON.stringify(state.result, null, 2) : '';
      const player = document.getElementById('audio');
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = null; player.hidden = true;
      if (state.result?.audioBytes) {
        const response = await fetch('/api/audio', { headers: { 'X-Probe-Key': CONTROL } });
        if (response.ok) { audioUrl = URL.createObjectURL(await response.blob()); player.src = audioUrl; player.hidden = false; }
      }
    }
  } catch (error) { statusElement.textContent = error.message; }
  setTimeout(poll, 1000);
}
document.getElementById('bookmark').addEventListener('click', event => { event.preventDefault(); alert('请把这个按钮拖到书签栏，再到 Fish 页面点击保存的书签。'); });
for (const kind of ['balance', 'generate']) document.getElementById(kind).addEventListener('click', async () => {
  try { await call('/api/run', { kind }); }
  catch (error) { resultElement.textContent = error.message; }
});
poll();
