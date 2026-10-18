// This function is embedded in a bookmark and runs in the user's Fish tab.
// Login credentials never cross the postMessage bridge to localhost.
export function connectFish(localOrigin, key) {
  if (location.origin !== 'https://fish.audio') { alert('请切换到已登录的 Fish 文字转语音页面，再点击连接书签。'); return; }
  window.__fishLocalRelay?.stop();
  const popup = window.open(localOrigin + '/browser#' + key, 'fish-subscription-relay', 'popup,width=540,height=640');
  if (!popup) { alert('请允许 Fish 打开本机连接窗口，然后再点击书签。'); return; }
  let stopped = false, active = null;
  function fail(code) { throw Object.assign(new Error(code), { code }); }
  function auth() {
    const read = name => localStorage.getItem(name) ?? decodeURIComponent(document.cookie.split('; ').find(x => x.startsWith(name + '='))?.slice(name.length + 1) || '');
    const token = read('token');
    if (!token || token === 'null' || token === 'undefined') fail('LOGIN_REQUIRED');
    const headers = { Authorization: /^Bearer\s+/i.test(token) ? token : 'Bearer ' + token };
    for (const [name, header] of [['active_team_id', 'x-team-id'], ['active_workspace_id', 'x-workspace-id']]) {
      const value = read(name); if (value) headers[header] = value;
    }
    return headers;
  }
  async function perform(job, controller) {
    if (!['balance', 'speech'].includes(job.kind)) fail('INVALID_REQUEST');
    // Freeze the authenticated account/workspace for the entire request.
    const headers = auth();
    async function request(path, options = {}) {
      const response = await fetch('https://api.fish.audio' + path, { ...options,
        headers: { ...headers, ...options.headers }, cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        fail(({ 400: 'INVALID_REQUEST', 401: 'LOGIN_REQUIRED', 402: 'QUOTA_EXHAUSTED', 403: 'FISH_FORBIDDEN', 404: 'INVALID_REQUEST', 422: 'INVALID_REQUEST', 429: 'RATE_LIMITED' })[response.status] || 'UPSTREAM_ERROR');
      }
      return response;
    }
    const user = await (await request('/user/self')).json();
    if (typeof user?._id !== 'string') fail('LOGIN_REQUIRED');
    const wallet = '/wallet/' + encodeURIComponent(user._id);
    const numeric = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
    async function balances() {
      const [pkg, api] = await Promise.all([
        request(wallet + '/package').then(r => r.json()), request(wallet + '/api-credit').then(r => r.json()),
      ]);
      return { plan: pkg.type, balance: numeric(pkg.balance), total: numeric(pkg.total), extraBalance: numeric(pkg.extra_balance), apiCredit: numeric(api.credit) };
    }
    const before = await balances();
    if (job.kind === 'balance') return { ok: true, after: before };
    if (typeof job.text !== 'string' || !job.text.trim() || [...job.text].length > 1000
      || !/^[a-fA-F0-9]{32}$/.test(job.referenceId) || !['s2.1-pro', 'drama-3', 's2-pro', 's1'].includes(job.model)
      || typeof job.speed !== 'number' || !Number.isFinite(job.speed) || job.speed < 0.5 || job.speed > 2) fail('INVALID_REQUEST');
    if (!(before.balance > 0 || before.extraBalance > 0)) return { ok: false, code: 'QUOTA_EXHAUSTED', before };
    try {
      const source = performance.getEntriesByType('resource').map(item => item.name)
        .find(url => /^https:\/\/fish\.audio\/assets\/tool-history-[\w-]+\.js$/.test(url));
      if (!source) fail('SITE_CHANGED');
      const module = await import(source);
      if (typeof module.L !== 'function') fail('SITE_CHANGED');
      let recaptcha;
      try { recaptcha = await module.L('playground'); } catch { fail('VERIFICATION_REQUIRED'); }
      controller.signal.throwIfAborted();
      const prosody = { speed: job.speed };
      const response = await request('/task', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tts', stream: true, model: job.referenceId, backend: job.model,
          format: 'mp3', latency: 'balanced', prosody, recaptcha,
          parameters: { text: job.text, model_id: job.referenceId, backend: job.model, format: 'mp3', latency: 'balanced', prosody } }) });
      if (!/audio|octet-stream/i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); fail('EMPTY_AUDIO'); }
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length; if (size > 12 * 1024 * 1024) fail('AUDIO_TOO_LARGE');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!size) fail('EMPTY_AUDIO');
      let binary = '';
      for (const chunk of chunks) for (let offset = 0; offset < chunk.length; offset += 8192) binary += String.fromCharCode(...chunk.subarray(offset, offset + 8192));
      // A failed follow-up balance read must not discard paid-for audio.
      const after = await balances().catch(() => null);
      return { ok: true, audioBase64: btoa(binary), before, after };
    } catch (error) {
      return { ok: false, code: controller.signal.aborted ? 'CANCELLED' : error.code || 'UPSTREAM_ERROR', before };
    }
  }
  const listener = async event => {
    if (stopped || event.source !== popup || event.origin !== localOrigin || event.data?.key !== key) return;
    const message = event.data;
    const send = value => popup.postMessage({ ...value, key }, localOrigin);
    if (message.type === 'hello') {
      let loggedIn = true; try { auth(); } catch { loggedIn = false; }
      send({ type: 'ready', nonce: message.nonce, loggedIn, version: 2 }); return;
    }
    if (message.type === 'cancel') { if (active?.id === message.id) active.controller.abort(); return; }
    if (message.type !== 'job' || active || !message.job?.id) return;
    const controller = new AbortController();
    const run = { id: message.job.id, controller }; active = run;
    const timer = setTimeout(() => controller.abort(), 175000);
    let result;
    try { result = await perform(message.job, controller); }
    catch (error) { result = { ok: false, code: error.code || 'UPSTREAM_ERROR' }; }
    finally { clearTimeout(timer); if (active === run) active = null; }
    send({ type: 'result', id: run.id, ...result });
  };
  window.addEventListener('message', listener);
  window.__fishLocalRelay = { stop() { stopped = true; active?.controller.abort(); window.removeEventListener('message', listener); } };
}
