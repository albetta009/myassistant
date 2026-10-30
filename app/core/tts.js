// 语音合成：provider 可插拔（sapi 本机离线 / edge 在线微软音色 / 以后加云厂商）
import { execFile } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { PATHS, loadConfig, secrets } from './config.js';
import { logger } from './log.js';

const log = logger('tts');
if (!existsSync(PATHS.voice)) mkdirSync(PATHS.voice, { recursive: true });

/**
 * 自己发 HTTPS 请求，不用 fetch：
 * undici 的「连接超时」固定 10s，而这台机器到 Cloudflare 有时要 9~10s，会偶发 ECONNECT_TIMEOUT；
 * 这里强制 IPv4 + 可配超时，稳一些。
 */
function requestOnce({ url, method = 'GET', headers = {}, body = null, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method,
        family: 4,
        timeout: timeoutMs,
        headers: { 'user-agent': 'MYAssistant/0.1', ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, buf: Buffer.concat(chunks) }));
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 这台机器到 Cloudflare 是间歇性的（有时 3s、有时 20s 超时），所以带重试 */
async function requestBuf({ retries = 2, ...opts }) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await requestOnce(opts);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function runFile(exe, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message} ${stderr || ''}`.trim()));
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** 本机 SAPI：完全离线，中文女声 Microsoft Huihui Desktop */
async function sapi(text, outFile, opts = {}) {
  const tmp = path.join(PATHS.voice, `.txt_${Date.now()}.txt`);
  writeFileSync(tmp, text, 'utf8');
  const ps = path.join(PATHS.root, 'tools', 'sapi-tts.ps1');
  try {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ps,
      '-TextFile',
      tmp,
      '-OutFile',
      outFile,
      '-Rate',
      String(opts.rate ?? 0),
    ];
    if (opts.voice) args.push('-VoiceName', opts.voice);
    await runFile('powershell.exe', args);
  } finally {
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  if (!existsSync(outFile)) throw new Error('SAPI 没有产出文件');
  return { file: outFile, format: 'wav' };
}

/** 在 WAV 结尾补一段静音：QQ 转 silk 时经常把最后一个字削掉，留白能兜住 */
export function padWav(buf, padMs) {
  if (!padMs || buf.length < 44) return buf;
  if (buf.slice(0, 4).toString() !== 'RIFF' || buf.slice(8, 12).toString() !== 'WAVE') return buf;
  let off = 12;
  let dataOff = -1;
  let dataSize = 0;
  let sampleRate = 24000;
  let channels = 1;
  let bits = 16;
  while (off + 8 <= buf.length) {
    const id = buf.slice(off, off + 4).toString('ascii');
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10) || 1;
      sampleRate = buf.readUInt32LE(off + 12) || 24000;
      bits = buf.readUInt16LE(off + 22) || 16;
    } else if (id === 'data') {
      dataOff = off + 8;
      dataSize = size;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) return buf;
  const padBytes = Math.round((Number(padMs) / 1000) * sampleRate * channels * (bits / 8));
  if (padBytes <= 0) return buf;
  const out = Buffer.concat([buf.slice(0, dataOff + dataSize), Buffer.alloc(padBytes), buf.slice(dataOff + dataSize)]);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(dataSize + padBytes, dataOff - 4);
  return out;
}

/**
 * Breeze Blue 在线 TTS：POST /v1/text-to-speech/{voice_id}，xi-api-key 认证，返回二进制音频
 * 文档：https://docs.breezeblue.ai/api-reference/text-to-speech/convert-text-to-speech
 */
async function breeze(text, outFile, o = {}) {
  const key = String(o.apiKey || secrets().breezeApiKey || '').trim();
  if (!key) throw new Error('没填 Breeze API Key（设置 → 语音）');
  const voiceId = String(o.voiceId || '').trim();
  if (!voiceId) throw new Error('没选 Breeze 音色（voice_id）');
  const base = String(o.baseUrl || 'https://api.breeze.blue').replace(/\/+$/, '');
  const fmt = String(o.outputFormat || 'mp3');
  const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(fmt)}&delivery=sync`;

  const body = { text, model_id: String(o.modelId || 'breeze-tts-2') };
  if (o.language) body.language_code = String(o.language);
  if (o.instructions) body.instructions = String(o.instructions).slice(0, 1000);
  const vs = {};
  if (Number(o.speed) && Number(o.speed) !== 1) vs.speed = Number(o.speed);
  const g = Number(o.guidance);
  if (g >= 1 && g <= 10) vs.guidance_scale = g;
  if (Object.keys(vs).length) body.voice_settings = vs;

  const r = await requestBuf({
    url,
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 120000,
    retries: 2,
  });
  if (r.status < 200 || r.status >= 300) {
    const txt = r.buf.toString('utf8');
    throw new Error(`Breeze TTS ${r.status}：${(txt || '').slice(0, 200)}`);
  }
  if (!r.buf.length) throw new Error('Breeze 返回了空音频');
  const outBuf = fmt.startsWith('wav') ? padWav(r.buf, Number(o.padMs ?? 300)) : r.buf;
  writeFileSync(outFile, outBuf);
  return { file: outFile, format: fmt.split('_')[0] };
}

/** 列出账号可用的 Breeze 音色（给设置页选音色用；apiKey 可临时覆盖，方便先试后存） */
export async function listVoices({ language = 'zh', gender = 'female', search = '', pageSize = 50, apiKey = '', baseUrl = '' } = {}) {
  const key = String(apiKey || secrets().breezeApiKey || '').trim();
  if (!key) throw new Error('没填 Breeze API Key（设置 → 语音）');
  const cfg = loadConfig();
  const base = String(baseUrl || cfg.tts?.breeze?.baseUrl || 'https://api.breeze.blue').replace(/\/+$/, '');
  const qs = new URLSearchParams();
  if (language) qs.set('language_code', language);
  if (gender) qs.append('gender', gender);
  if (search) qs.set('search', search);
  qs.set('page_size', String(pageSize));
  const r = await requestBuf({ url: `${base}/v1/voices?${qs.toString()}`, headers: { 'xi-api-key': key } });
  const txt = r.buf.toString('utf8');
  let j = null;
  try {
    j = JSON.parse(txt);
  } catch {
    throw new Error('Breeze 音色列表返回的不是 JSON：' + txt.slice(0, 120));
  }
  if (r.status < 200 || r.status >= 300) throw new Error(`Breeze ${r.status}：${(j?.detail || j?.error || txt).slice(0, 200)}`);
  return (j.voices || []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    lang: v.language_code,
    gender: v.gender,
    accent: v.accent || '',
    preview: v.preview_url || '',
  }));
}

/**
 * 合成一段语音。
 * @returns {Promise<{file:string, format:string}>}
 */
export async function synthesize(text, opts = {}) {
  const cfg = loadConfig();
  const t = String(text || '').trim();
  if (!t) throw new Error('语音文本为空');
  const maxChars = Number(cfg.tts?.maxChars) || 200;
  const clipped = t.length > maxChars ? t.slice(0, maxChars) : t;

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const provider = String(opts.provider || cfg.tts?.provider || 'sapi');

  if (provider === 'edge') {
    // 保留位：Edge 的 Sec-MS-GEC 签名目前拿不到，先直接报错，避免静默失败
    throw new Error('edge TTS 当前不可用（GEC 签名失败），请改用 provider=sapi 或 breeze');
  }

  if (provider === 'breeze') {
    const b = { ...(cfg.tts?.breeze || {}), ...opts };
    const fmt = String(b.outputFormat || 'mp3');
    const ext = fmt.startsWith('wav') ? 'wav' : fmt.startsWith('flac') ? 'flac' : fmt.startsWith('pcm') ? 'pcm' : 'mp3';
    const out = path.join(PATHS.voice, `v_${stamp}.${ext}`);
    const r = await breeze(clipped, out, { ...b, outputFormat: fmt });
    const size = statSync(out).size;
    log.info(`语音合成 ${clipped.length} 字 → ${path.basename(out)} (${Math.round(size / 1024)} KB, breeze/${b.voiceId})`);
    return { ...r, bytes: size, text: clipped };
  }

  const out = path.join(PATHS.voice, `v_${stamp}.wav`);
  const r = await sapi(clipped, out, { voice: opts.voice || cfg.tts?.voice, rate: opts.rate ?? cfg.tts?.rate });
  const size = statSync(out).size;
  log.info(`语音合成 ${clipped.length} 字 → ${path.basename(out)} (${Math.round(size / 1024)} KB, sapi)`);
  return { ...r, bytes: size, text: clipped };
}

/** 发给 QQ（OneBot record 段）。协议端会自己转 silk。 */
export async function sendVoice(onebot, conv, text, opts = {}) {
  const v = await synthesize(text, opts);
  const abs = v.file.replace(/\\/g, '/');
  let messageId;
  try {
    messageId = await onebot.send(conv, [{ type: 'record', data: { file: 'file://' + abs } }]);
  } catch (err) {
    log.warn('record 发送失败，改 base64: ' + err.message);
    const b64 = (await import('node:fs')).readFileSync(v.file).toString('base64');
    messageId = await onebot.send(conv, [{ type: 'record', data: { file: 'base64://' + b64 } }]);
  }
  log.info(`语音已发送 → ${conv} (messageId=${messageId})`);
  return { messageId, ...v };
}

/** 清理超过 3 天的语音缓存 */
export function gcVoice(maxAgeMs = 3 * 24 * 3600 * 1000) {
  try {
    const now = Date.now();
    for (const f of readdirSync(PATHS.voice)) {
      const fp = path.join(PATHS.voice, f);
      try {
        if (now - statSync(fp).mtimeMs > maxAgeMs) {
          const { unlinkSync } = require('node:fs');
          unlinkSync(fp);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
