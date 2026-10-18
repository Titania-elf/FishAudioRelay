// Runs only when the user clicks the connection bookmark on fish.audio.
// Credentials stay in the Fish page; only balance summaries/audio cross to localhost.
export function connectFromFish(localOrigin, ticket) {
  if (location.origin !== 'https://fish.audio') {
    alert('请先切换到已登录的 Fish Audio 网页，再点击这个书签。');
    return;
  }
  const previous = window.__fishLocalProbe;
  previous?.stop();
  const popup = window.open(localOrigin + '/bridge#' + ticket, 'fish-local-probe', 'popup,width=560,height=640');
  if (!popup) { alert('请允许此页面打开本机连接窗口，然后再次点击书签。'); return; }
  let busy = false;
  let stopped = false;
  let controller = null;
  const pick = (data, keys) => Object.fromEntries(keys.filter(key => data && Object.hasOwn(data, key)).map(key => [key, data[key]]));
  function headers() {
    const read = key => localStorage.getItem(key) ?? decodeURIComponent(document.cookie.split('; ').find(x => x.startsWith(key + '='))?.slice(key.length + 1) || '');
    const token = read('token');
    if (!token || token === 'null' || token === 'undefined') throw new Error('请先在这个 Fish 标签页中完成登录。');
    const result = { Authorization: /^Bearer\s+/i.test(token) ? token : 'Bearer ' + token };
    for (const [key, header] of [['active_team_id', 'x-team-id'], ['active_workspace_id', 'x-workspace-id']]) {
      const value = read(key);
      if (value) result[header] = value;
    }
    return result;
  }
  async function request(path, options = {}) {
    const response = await fetch('https://api.fish.audio' + path, {
      ...options, headers: { ...headers(), ...options.headers },
      cache: 'no-store', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) {
      const status = response.status;
      const data = await response.json().catch(() => null);
      const code = typeof data?.code === 'string' && /^[A-Za-z_]{1,80}$/.test(data.code) ? data.code : '';
      throw new Error(`Fish HTTP ${status}${code ? ' (' + code + ')' : ''}。${status === 401 ? '请重新登录。' : status === 403 ? '请在 Fish 网页检查权限或完成验证。' : status === 402 ? '该生成方式的可用额度不足。' : ''}`);
    }
    return response;
  }
  async function balances() {
    const user = await (await request('/user/self')).json();
    if (typeof user?._id !== 'string') throw new Error('无法识别已登录账号。');
    const id = encodeURIComponent(user._id);
    const [pkg, api] = await Promise.all([
      request('/wallet/' + id + '/package').then(r => r.json()),
      request('/wallet/' + id + '/api-credit').then(r => r.json()),
    ]);
    return {
      package: pick(pkg, ['type', 'balance', 'total', 'extra_balance', 'finished_at', 'subscription_status']),
      api: pick(api, ['credit', 'balance', 'total', 'credits', 'remaining', 'used']),
      teamSelected: Boolean(headers()['x-team-id']),
    };
  }
  async function generate(job) {
    if (typeof job.text !== 'string' || !job.text.trim() || [...job.text].length > 100) throw new Error('诊断文本限 100 字以内。');
    const before = await balances();
    // Stop before generation if the account has no visible subscription quota.
    // This prototype never switches to /v1/tts or tops up an account.
    if (!(Number(before.package.balance) > 0 || Number(before.package.extra_balance) > 0)) {
      return { ok: false, before, error: '未读到可用订阅额度，未提交生成。请先确认账号套餐。' };
    }
    // Personal subscriptions can use a team/workspace context too. Keep the
    // page's selected context on both balance reads and the generation request.
    let referenceId = job.referenceId || new URL(location.href).searchParams.get('modelId');
    if (!referenceId) {
      const recent = await (await request('/model/latest-used')).json();
      referenceId = Array.isArray(recent) ? recent[0]?._id : undefined;
    }
    if (!referenceId || !/^[a-fA-F0-9]{32}$/.test(referenceId)) throw new Error('请在 Fish 网页选择一个音色，并正常使用一次，再进行连接测试。');
    const assets = performance.getEntriesByType('resource').map(item => item.name);
    const source = assets.find(value => /^https:\/\/fish\.audio\/assets\/tool-history-[\w-]+\.js$/.test(value));
    if (!source) throw new Error('未找到当前页面的验证模块，请打开 Fish 的文字转语音页面后重新连接。');
    const module = await import(source);
    if (typeof module.L !== 'function') throw new Error('Fish 页面版本已变化，验证模块需要更新。');
    // Use the site's normal browser verification flow, without bypassing it.
    const recaptcha = await module.L('playground');
    const backend = 's2.1-pro';
    const parameters = { text: job.text, model_id: referenceId, format: 'mp3', latency: 'balanced', backend };
    let response;
    try {
      response = await request('/task', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'tts', stream: true, model: referenceId, parameters, recaptcha,
          format: 'mp3', backend, latency: 'balanced' }),
      });
    } catch (error) { return { ok: false, before, after: await balances(), error: error.message }; }
    const type = response.headers.get('content-type') || '';
    if (!/audio|octet-stream/i.test(type)) { await response.body?.cancel(); throw new Error('Fish 未返回音频数据。'); }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 4 * 1024 * 1024) throw new Error('诊断音频超过 4 MB 限制。');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!size) throw new Error('Fish 返回了空音频。');
    let binary = '';
    for (const chunk of chunks) {
      for (let offset = 0; offset < chunk.length; offset += 8192) binary += String.fromCharCode(...chunk.subarray(offset, offset + 8192));
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
    const after = await balances();
    return { ok: true, before, after, audioBase64: btoa(binary), audioBytes: size,
      backend, referenceId, taskId: response.headers.get('task-id') };
  }
  const listener = async event => {
    if (stopped || event.source !== popup || event.origin !== localOrigin || event.data?.ticket !== ticket) return;
    if (event.data.type === 'hello') {
      popup.postMessage({ type: 'ready', ticket }, localOrigin);
      return;
    }
    if (event.data.type !== 'job' || busy) return;
    const job = event.data.job;
    if (!job || !['balance', 'generate'].includes(job.kind)) return;
    busy = true;
    controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const result = job.kind === 'balance' ? { ok: true, balance: await balances() } : await generate(job);
      popup.postMessage({ type: 'result', ticket, id: job.id, result }, localOrigin);
    } catch (error) {
      popup.postMessage({ type: 'result', ticket, id: job.id, result: { ok: false, error: error.name === 'AbortError' ? '网页请求超时，请检查网络。' : error.message } }, localOrigin);
    } finally { clearTimeout(timer); busy = false; controller = null; }
  };
  window.addEventListener('message', listener);
  window.__fishLocalProbe = { stop() { stopped = true; controller?.abort(); window.removeEventListener('message', listener); } };
}
