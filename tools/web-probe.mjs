import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connectFromFish } from './fish-page-bridge.js';

const port = 17865;
const origin = `http://127.0.0.1:${port}`;
const ticket = randomBytes(32).toString('hex');
const control = randomBytes(32).toString('hex');
const bookmark = 'javascript:' + encodeURIComponent(`(${connectFromFish.toString()})(${JSON.stringify(origin)},${JSON.stringify(ticket)});void 0;`);
let lastSeen = 0;
let job = null;
let result = null;
let audio = null;
let nextId = 0;
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fish 订阅连接测试</title><link rel="stylesheet" href="/style.css"><main><p class="eyebrow">FISH AUDIO · 本机验证</p><h1>使用已登录的 Chrome</h1><p id="status">等待连接 Fish 网页</p><section id="instructions"><ol><li>按 Ctrl+Shift+B 显示 Chrome 书签栏。</li><li>把下面的“连接 Fish 订阅”拖到书签栏。</li><li>切换到你已登录的 Fish 文字转语音页面，点击刚保存的书签。</li></ol><p><a id="bookmark" class="button" href="${bookmark}">连接 Fish 订阅</a></p><p class="muted">请拖动到书签栏，不是在本页点击。若弹窗被拦截，请允许 Fish 打开本机连接窗口。</p><p><a href="https://fish.audio/app/text-to-speech" target="_blank" rel="noreferrer">打开 Fish 文字转语音页面 ↗</a></p></section><section id="connected" hidden><p>保持 Fish 标签页和本机连接窗口打开。登录凭据留在 Fish 页面。</p><button id="balance">读取套餐额度</button><button id="generate">生成一句测试</button><p class="muted">测试使用 S2.1 Pro 生成一句短音频，并比较订阅与 API 余额。未读到订阅额度时不会提交生成。</p></section><pre id="result"></pre><audio id="audio" controls hidden></audio></main><script src="/client.js"></script></html>`;

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 6 * 1024 * 1024) throw new Error('请求过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'");
  try {
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site' && !['/', '/bridge', '/style.css', '/client.js'].includes(request.url)) {
      json(response, 403, { error: '仅供本机管理页面使用。' }); return;
    }
    if (request.method === 'GET' && ['/', '/bridge'].includes(request.url)) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return;
    }
    if (request.method === 'GET' && request.url === '/style.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end('body{background:#11151b;color:#eef2f7;font:16px/1.7 system-ui;margin:0}main{max-width:720px;margin:48px auto;padding:0 28px}h1{font-size:30px}.eyebrow,.muted{color:#a9b6c7}section{background:#1c2430;padding:24px;border-radius:16px;margin:24px 0}a{color:#95d3ff}.button,button{display:inline-block;background:#9de5ce;color:#102b23;border:0;border-radius:8px;padding:10px 18px;font:inherit;cursor:pointer;text-decoration:none;margin:5px}pre{white-space:pre-wrap;word-break:break-word;font:14px/1.65 monospace}audio{width:100%}[hidden]{display:none!important}'); return;
    }
    if (request.method === 'GET' && request.url === '/client.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(`const CONTROL=${JSON.stringify(control)};\n` + await readFile(new URL('./web-probe-client.js', import.meta.url), 'utf8')); return;
    }
    if (request.method === 'GET' && request.url === '/api/status') {
      json(response, 200, { connected: Date.now() - lastSeen < 15000, busy: Boolean(job), result }); return;
    }
    const isBridge = ['/api/poll', '/api/result'].includes(request.url);
    if (!same(request.headers['x-probe-key'], isBridge ? ticket : control)) { json(response, 403, { error: '连接已过期，请从管理页重新连接。' }); return; }
    if (request.method === 'POST' && request.url === '/api/poll') {
      lastSeen = Date.now();
      if (job && Date.now() - job.created > 130000) { result = { ok: false, error: '网页执行超时，请重新连接。' }; job = null; }
      const next = job && !job.sent ? { id: job.id, kind: job.kind, text: job.text, referenceId: job.referenceId } : null;
      if (next) job.sent = true;
      json(response, 200, { job: next }); return;
    }
    if (request.method === 'POST' && request.url === '/api/result') {
      const value = await body(request);
      if (!job || value.id !== job.id || !value.result || typeof value.result !== 'object') { json(response, 409, { error: '任务已过期。' }); return; }
      const { audioBase64, ...summary } = value.result;
      audio = typeof audioBase64 === 'string' ? Buffer.from(audioBase64, 'base64') : null;
      result = { ...summary, finishedAt: new Date().toISOString() };
      job = null;
      json(response, 200, { ok: true }); return;
    }
    if (request.method === 'POST' && request.url === '/api/run') {
      if (Date.now() - lastSeen >= 15000) { json(response, 409, { error: '请先从 Fish 标签页点击连接书签。' }); return; }
      if (job) { json(response, 409, { error: '已有测试正在执行。' }); return; }
      const value = await body(request);
      if (!['balance', 'generate'].includes(value.kind)) { json(response, 400, { error: '无效操作。' }); return; }
      job = { id: String(++nextId), kind: value.kind, text: '你好，这是订阅语音连接测试。', created: Date.now(), sent: false };
      result = null; audio = null;
      json(response, 202, { id: job.id }); return;
    }
    if (request.method === 'GET' && request.url === '/api/audio' && audio) {
      response.writeHead(200, { 'Content-Type': 'audio/mpeg' }); response.end(audio); return;
    }
    json(response, 404, { error: '未找到。' });
  } catch { json(response, 400, { error: '请求处理失败。' }); }
});
server.requestTimeout = 15000;
server.listen(port, '127.0.0.1', () => console.log(`Fish 订阅测试：${origin}/`));
