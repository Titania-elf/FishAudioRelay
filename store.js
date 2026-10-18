import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MODEL = 's2.1-pro';
export const MAX_TEXT_LENGTH = 10000;

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, '配置必须为 JSON 对象。');
  }
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(model)) {
    throw new RequestError(400, '请输入有效模型名称，例如 s2.1-pro。');
  }
  if (!Array.isArray(value.voices) || value.voices.length < 1 || value.voices.length > 50) {
    throw new RequestError(400, '请配置 1–50 个音色。');
  }
  const names = new Set();
  const voices = value.voices.map(item => {
    if (!item || typeof item.name !== 'string' || typeof item.referenceId !== 'string') {
      throw new RequestError(400, '音色必须有名称和 referenceId。');
    }
    const name = item.name.trim();
    const referenceId = item.referenceId.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || names.has(name)) {
      throw new RequestError(400, '音色名称须唯一，只能使用字母、数字、下划线和连字符。');
    }
    if (referenceId && !/^[a-fA-F0-9]{32}$/.test(referenceId)) {
      throw new RequestError(400, 'Reference ID 应是 Fish 音色页面的 32 位十六进制 ID；也可以留空。');
    }
    names.add(name);
    return { name, referenceId };
  });
  if (typeof value.defaultVoice !== 'string' || !names.has(value.defaultVoice)) {
    throw new RequestError(400, '默认音色须从已配置的音色中选择。');
  }
  const provider = value.provider ?? 'api';
  if (!['web', 'api'].includes(provider)) throw new RequestError(400, '请选择网页订阅或 API 接入方式。');
  return { model, voices, defaultVoice: value.defaultVoice, provider };
}

// DPAPI binds these secrets to this Windows account. Plaintext is passed only
// through stdin, never as process arguments or in the saved JSON configuration.
async function dpapi(value, protect) {
  if (!value) return '';
  if (process.platform !== 'win32') throw new Error('此版本的密钥存储需要 Windows DPAPI。');
  const operation = protect ? 'Protect' : 'Unprotect';
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$outputBytes = [Security.Cryptography.ProtectedData]::${operation}($inputBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($outputBytes))`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const input = protect ? Buffer.from(value, 'utf8').toString('base64') : value;
  const result = await new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 15000, maxBuffer: 65536 }, (error, stdout) => {
        if (error) reject(new Error('Windows 密钥加密/解密失败，请使用保存配置时的 Windows 账号运行。'));
        else resolve(stdout.trim());
      });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  return protect ? result : Buffer.from(result, 'base64').toString('utf8');
}

export async function openStore(directory) {
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'config.json');
  let current;
  try {
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    const settings = validateSettings(saved);
    if (saved.version !== 1 || !saved.relayKeyProtected) throw new Error('不支持的配置格式。');
    const [fishApiKey, relayKey] = await Promise.all([
      dpapi(saved.fishKeyProtected, false), dpapi(saved.relayKeyProtected, false),
    ]);
    current = { ...settings, fishApiKey, relayKey };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    current = {
      provider: 'web',
      model: DEFAULT_MODEL, voices: [{ name: 'default', referenceId: '' }],
      defaultVoice: 'default', fishApiKey: '', relayKey: `fish-relay-${randomBytes(32).toString('hex')}`,
    };
    await persist(current);
  }

  async function persist(config) {
    const [fishKeyProtected, relayKeyProtected] = await Promise.all([
      dpapi(config.fishApiKey, true), dpapi(config.relayKey, true),
    ]);
    const saved = { version: 1, provider: config.provider, model: config.model, voices: config.voices,
      defaultVoice: config.defaultVoice, fishKeyProtected, relayKeyProtected };
    const temporary = path.join(directory, `config-${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  let pending = Promise.resolve();
  return {
    get: () => structuredClone(current),
    update(value) {
      const settings = validateSettings(value);
      let suppliedKey = value.fishApiKey;
      if (suppliedKey !== undefined && typeof suppliedKey !== 'string') {
        throw new RequestError(400, 'Fish API KEY 必须为字符串。');
      }
      suppliedKey = suppliedKey?.trim();
      if (suppliedKey && (suppliedKey.length > 4096 || /\s|[^\x21-\x7e]/.test(suppliedKey))) {
        throw new RequestError(400, 'Fish API KEY 格式无效，请不要包含空格或换行。');
      }
      const save = pending.then(async () => {
        const next = { ...current, ...settings, provider: value.provider ?? current.provider, fishApiKey: suppliedKey || current.fishApiKey };
        await persist(next);
        current = next;
        return structuredClone(current);
      });
      pending = save.catch(() => {});
      return save;
    },
  };
}
