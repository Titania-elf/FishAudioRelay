'use strict';
(() => {
  const state = document.getElementById('bridge-state');
  const detail = document.getElementById('bridge-detail');
  const retry = document.getElementById('bridge-retry');
  const suppliedKey = location.hash.slice(1);
  if (suppliedKey) sessionStorage.setItem('fish-browser-key', suppliedKey);
  const key = suppliedKey || sessionStorage.getItem('fish-browser-key');
  history.replaceState(null, '', location.pathname);
  const clientId = crypto.randomUUID();
  let running = false, connected = false, current = null, greeting = null;
  const send = message => window.opener?.postMessage({ ...message, key }, 'https://fish.audio');
  async function call(path, value) {
    const response = await fetch('/api/browser/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Browser-Key': key },
      body: JSON.stringify({ ...value, clientId }), signal: AbortSignal.timeout(35000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || '本机连接失败。');
    return body;
  }
  function hello() {
    if (!window.opener || window.opener.closed) return Promise.reject(new Error('Fish 标签页已关闭，请在 Fish 页面重新点击连接书签。'));
    return new Promise((resolve, reject) => {
      const nonce = crypto.randomUUID();
      const timer = setTimeout(() => { greeting = null; reject(new Error('Fish 标签页没有响应，请在该页面重新点击连接书签。')); }, 5000);
      greeting = { nonce, finish(value) { clearTimeout(timer); greeting = null; resolve(value); } };
      send({ type: 'hello', nonce });
    });
  }
  window.addEventListener('message', async event => {
    if (event.source !== window.opener || event.origin !== 'https://fish.audio' || event.data?.key !== key) return;
    const message = event.data;
    if (message.type === 'ready' && greeting?.nonce === message.nonce) greeting.finish(message);
    if (message.type === 'result' && message.id === current) {
      const { id, ok, code, audioBase64, before, after } = message;
      current = null;
      try {
        await call('result', { id, ok, code, audioBase64, before, after });
        state.textContent = ok ? '已连接，等待下一段朗读' : '本次生成未完成，请查看管理页提示';
        if (after) detail.textContent = `套餐：${after.plan || '—'} · 剩余额度：${after.balance ?? '—'}`;
      } catch (error) { state.textContent = error.message; }
    }
  });
  async function run() {
    if (running) return;
    if (!key || !/^[a-f0-9]{64}$/.test(key)) { state.textContent = '请从已登录的 Fish 页面点击管理页提供的连接书签。'; return; }
    running = true; retry.hidden = true;
    try {
      const greeting = await hello();
      if (!greeting.loggedIn) throw new Error('请先在 Fish 页面完成登录，再点击重新连接。');
      await call('connect', { version: greeting.version });
      connected = true;
      state.textContent = '已连接，可以在酒馆中朗读';
      while (running) {
        const ready = await hello();
        if (!ready.loggedIn) throw new Error('Fish 登录状态已失效，请重新登录后连接。');
        const value = await call('poll', {});
        if (value.command?.type === 'job') {
          current = value.command.job.id;
          state.textContent = value.command.job.kind === 'balance' ? '正在读取套餐额度…' : '正在生成酒馆语音…';
          send({ type: 'job', job: value.command.job });
        } else if (value.command?.type === 'cancel') send(value.command);
      }
    } catch (error) {
      state.textContent = error.message;
      if (current) send({ type: 'cancel', id: current });
      if (connected) await call('disconnect', {}).catch(() => {});
      connected = false; retry.hidden = false;
    } finally { running = false; }
  }
  retry.addEventListener('click', run);
  window.addEventListener('pagehide', () => {
    running = false;
    if (current) send({ type: 'cancel', id: current });
    if (connected) fetch('/api/browser/disconnect', { method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Browser-Key': key }, body: JSON.stringify({ clientId }) }).catch(() => {});
  });
  run();
})();
