// HTTP 服务：静态控制台 + JSON API + SSE 实时事件流。绑定 127.0.0.1。
import http from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { PATHS, loadConfig, saveConfig, setConfig, resolveProvider, secrets, saveSecrets, PROVIDER_PRESETS, providerPreset } from './config.js';
import * as store from './store.js';
import * as persona from './persona.js';
import * as mood from './mood.js';
import * as recall from './recall.js';
import * as wake from './wake.js';
import { logger } from './log.js';
import { cleanFact, dedupeFact } from './memory.js';
const log = logger('server');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

export function createServer({ agent, onebot, bus, startedAt }) {
  const sseClients = new Set();

  bus.on('agent', (payload) => broadcast('agent', payload));
  bus.on('onebot', (payload) => broadcast('onebot', payload));
  bus.on('log', (payload) => broadcast('log', payload));
  onebot.on('connected', () => broadcast('onebot', { type: 'connected', ...onebot.state }));
  onebot.on('disconnected', (d) => broadcast('onebot', { type: 'disconnected', ...d }));
  onebot.on('self', (d) => broadcast('onebot', { type: 'self', ...d }));

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  function ownerConv() {
    const q = loadConfig().access?.ownerQQ;
    if (q) return `private:${q}`;
    return store.listConvs()[0]?.convId || 'private:0';
  }

  /** 手填的「对象」→ 身份（QQ）：数字当 QQ，名字按别名反查，找不到就归到 unknown:名字 */
  function resolveSubjectInput(raw) {
    const s = String(raw || '').trim();
    if (/^\d{5,12}$/.test(s)) return { id: s, name: store.listPeople().find((p) => p.qq === s)?.name || s };
    if (!s || s === 'owner' || s === '对方') return { id: store.ownerQq(), name: s || 'owner' };
    const qq = store.resolvePersonByName(s);
    if (qq) return { id: qq, name: s };
    return { id: 'unknown:' + s, name: s };
  }

  /** 语音设置的白名单/范围校验，避免前端塞进来奇怪的值 */
  function ttsPatchFromBody(body = {}) {
    const cur = loadConfig().tts || {};
    const t = body.tts || {};
    const b = t.breeze || {};
    const out = {};
    if (t.provider !== undefined) out.provider = t.provider === 'breeze' ? 'breeze' : 'sapi';
    if (t.voice !== undefined) out.voice = String(t.voice || '').slice(0, 80);
    if (t.rate !== undefined) out.rate = Math.max(-10, Math.min(10, Number(t.rate) || 0));
    if (t.maxChars !== undefined) out.maxChars = Math.max(20, Math.min(500, Number(t.maxChars) || 200));
    if (t.enabled !== undefined) out.enabled = !!t.enabled;
    const bb = {};
    if (b.baseUrl !== undefined) bb.baseUrl = String(b.baseUrl || '').trim().slice(0, 200) || 'https://api.breeze.blue';
    if (b.voiceId !== undefined) bb.voiceId = String(b.voiceId || '').trim().slice(0, 120);
    if (b.modelId !== undefined) bb.modelId = String(b.modelId || '').trim().slice(0, 60) || 'breeze-tts-2';
    if (b.language !== undefined) bb.language = /^[a-z]{2}$/i.test(String(b.language)) ? String(b.language).toLowerCase() : 'zh';
    if (b.instructions !== undefined) bb.instructions = String(b.instructions || '').slice(0, 1000);
    if (b.speed !== undefined) bb.speed = Math.max(0.5, Math.min(2, Number(b.speed) || 1));
    if (b.guidance !== undefined) {
      const g = Number(b.guidance) || 0;
      bb.guidance = g >= 1 && g <= 10 ? g : 0;
    }
    if (b.outputFormat !== undefined) {
      const f = String(b.outputFormat || '');
      bb.outputFormat = /^(mp3|wav|flac|aac|opus|pcm)(_[0-9_]+)?$/.test(f) ? f : 'wav_24000';
    }
    if (b.padMs !== undefined) bb.padMs = Math.max(0, Math.min(2000, Number(b.padMs) || 0));
    if (Object.keys(bb).length) out.breeze = { ...(cur.breeze || {}), ...bb };
    return out;
  }

  function moodSafe(convId) {
    try {
      return mood.snapshot(convId);
    } catch {
      return null;
    }
  }

  function snapshot() {
    const cfg = loadConfig();
    let providerOk = false;
    let providerErr = '';
    try {
      const p = resolveProvider(cfg.llm.defaultProvider);
      providerOk = !!p.apiKey;
      if (!providerOk) providerErr = '缺少 api key';
    } catch (err) {
      providerErr = err.message;
    }
    return {
      app: cfg.app,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      port: cfg.server.port,
      onebot: onebot.state,
      llm: {
        provider: cfg.llm.defaultProvider,
        model: resolveSafeModel(cfg),
        keyReady: providerOk,
        keyError: providerErr,
      },
      persona: { active: persona.activePersonaName(), list: persona.listPersonas() },
      access: cfg.access,
      behavior: cfg.behavior,
      agent: agent.stats,
      usage: store.usageSummary(24),
      convs: store.listConvs().slice(0, 30),
      mood: moodSafe(ownerConv()),
      wake: {
        enabled: !!loadConfig().wake?.enabled,
        dryRun: loadConfig().wake?.dryRun !== false,
      },
      warnings: collectWarnings(cfg),
    };
  }

  function collectWarnings(cfg) {
    const out = [];
    const self = onebot.selfId;
    if (cfg.access.ownerQQ && self && String(cfg.access.ownerQQ) === String(self)) {
      out.push(`ownerQQ（${cfg.access.ownerQQ}）和机器人登录号是同一个号——多半填反了。「仅主人」模式下会变成谁都不理；请把 ownerQQ 改成你自己的私人号。`);
    }
    if (cfg.access.mode === 'owner' && !cfg.access.ownerQQ) {
      out.push('「仅主人」模式但 ownerQQ 未设置，现在谁都不会被回复。');
    }
    const allowN = (cfg.access.allow.private?.length || 0) + (cfg.access.allow.groups?.length || 0);
    if (cfg.access.mode !== 'owner' && !allowN && !cfg.access.allowAllWhenEmpty) {
      out.push('白名单为空且没开「放行全部」，现在谁都不会被回复。');
    }
    if (!onebot.connected) out.push('协议端未连接：QQ 登录层没起来，消息收不到也发不出。');
    return out;
  }

  function resolveSafeModel(cfg) {
    try {
      return resolveProvider(cfg.llm.defaultProvider).model;
    } catch {
      return '';
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const p = decodeURIComponent(url.pathname);

    try {
      /* ---------- SSE ---------- */
      if (p === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`event: hello\ndata: ${JSON.stringify(snapshot())}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* ignore */
          }
        }, 20000);
        req.on('close', () => {
          clearInterval(ping);
          sseClients.delete(res);
        });
        return;
      }

      /* ---------- API ---------- */
      if (p === '/api/state') return sendJson(res, 200, snapshot());

      /* ---------- 情绪 ---------- */
      if (p === '/api/mood' && req.method === 'GET') {
        const convId = url.searchParams.get('conv') || ownerConv();
        return sendJson(res, 200, { convId, current: moodSafe(convId), log: store.recentMoodLog(convId, 40) });
      }
      if (p === '/api/mood/reset' && req.method === 'POST') {
        const body = await readBody(req);
        const convId = body.convId || ownerConv();
        return sendJson(res, 200, { ok: true, current: mood.reset(convId) });
      }

      /* ---------- 主动搭话 ---------- */
      if (p === '/api/wake' && req.method === 'GET') return sendJson(res, 200, wake.status());

      if (p === '/api/wake/config' && req.method === 'POST') {
        const body = await readBody(req);
        saveConfig({ wake: body });
        log.info('主动搭话配置已更新');
        return sendJson(res, 200, { ok: true, status: wake.status() });
      }

      if (p === '/api/wake/dry' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.convId || wake.status().targets?.[0]?.convId || ownerConv();
        return sendJson(res, 200, { ok: true, convId: id, ...wake.drySpin(id) });
      }

      if (p === '/api/wake/send' && req.method === 'POST') {
        const body = await readBody(req);
        const id = body.convId || wake.status().targets?.[0]?.convId || ownerConv();
        const result = await wake.sendNow({ agent, bus, convId: id });
        return sendJson(res, 200, { ok: true, convId: id, result });
      }

      /* ---------- 记忆召回 ---------- */
      if (p === '/api/memory/recall' && req.method === 'GET') {
        const convId = url.searchParams.get('conv') || ownerConv();
        let dbBytes = 0;
        try {
          dbBytes = statSync(PATHS.db).size;
          const wal = PATHS.db + '-wal';
          if (existsSync(wal)) dbBytes += statSync(wal).size;
        } catch {
          /* 读不到就算了 */
        }
        return sendJson(res, 200, {
          convId,
          last: recall.lastRecall(convId),
          facts: store.listFacts({ limit: 60 }),
          stats: { ...store.factStats(), dbBytes },
        });
      }
      if (p === '/api/memory/recall' && req.method === 'POST') {
        const body = await readBody(req);
        const convId = body.convId || ownerConv();
        return sendJson(res, 200, recall.selectFacts({ convId, query: String(body.query || '') }));
      }

      if (p === '/api/config' && req.method === 'GET') {
        const cfg = loadConfig();
        const safe = JSON.parse(JSON.stringify(cfg));
        for (const prov of Object.values(safe.llm.providers || {})) {
          delete prov.apiKey;
          prov.hasKey = !!(prov.apiKeyRef && secrets()[prov.apiKeyRef]);
        }
        return sendJson(res, 200, safe);
      }

      if (p === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        saveConfig(body);
        log.info('配置已更新');
        return sendJson(res, 200, { ok: true });
      }

      /* ---------- 模型服务商 ---------- */
      if (p === '/api/llm/presets' && req.method === 'GET') {
        const cfg = loadConfig();
        const sec = secrets();
        const configured = {};
        for (const [id, prov] of Object.entries(cfg.llm.providers || {})) {
          configured[id] = {
            id,
            label: prov.label || id,
            baseUrl: prov.baseUrl || '',
            model: prov.defaultModel || (prov.models || [])[0] || '',
            models: prov.models || [],
            hasKey: !!(prov.apiKey || (prov.apiKeyRef && sec[prov.apiKeyRef]) || prov.noAuth),
            noAuth: !!prov.noAuth,
            contextWindow: prov.contextWindow || 0,
          };
        }
        return sendJson(res, 200, { presets: PROVIDER_PRESETS, defaultProvider: cfg.llm.defaultProvider, configured });
      }

      if (p === '/api/llm/provider' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.id || '').trim();
        if (!/^[a-z0-9_-]{2,32}$/i.test(id)) throw new Error('服务商 id 只能是字母、数字、下划线');
        const cfg = loadConfig();
        const cur = cfg.llm.providers?.[id] || {};
        const preset = providerPreset(id);
        const baseUrl = String(body.baseUrl ?? cur.baseUrl ?? preset?.baseUrl ?? '').trim().replace(/\/+$/, '');
        const model = String(body.model ?? cur.defaultModel ?? preset?.model ?? '').trim();
        if (!baseUrl) throw new Error('接口地址不能为空');
        if (!model) throw new Error('模型名不能为空');
        const models = Array.isArray(body.models) && body.models.length
          ? body.models.map((x) => String(x).trim()).filter(Boolean).slice(0, 30)
          : cur.models || preset?.models || [];
        const noAuth = body.noAuth != null ? !!body.noAuth : !!(cur.noAuth || preset?.noAuth);
        const next = {
          ...cur,
          label: String(body.label || cur.label || preset?.label || id),
          baseUrl,
          models: [...new Set([model, ...models])],
          defaultModel: model,
          apiKeyRef: cur.apiKeyRef || id,
          contextWindow: Number(body.contextWindow || cur.contextWindow || preset?.contextWindow || 128000),
          noAuth,
        };
        if (body.clearKey) saveSecrets({ [next.apiKeyRef]: null });
        else if (body.apiKey) saveSecrets({ [next.apiKeyRef]: String(body.apiKey).trim() });
        const patch = { llm: { defaultProvider: id, providers: { [id]: next } } };
        if (body.visionModel !== undefined) patch.llm.visionModel = String(body.visionModel || '');
        saveConfig(patch);
        const sec2 = secrets();
        const hasKey = !!(next.apiKeyRef && sec2[next.apiKeyRef]) || !!next.noAuth;
        log.info(`模型服务商已设置为 ${id}（${model} @ ${baseUrl}）key=${hasKey ? '有' : '无'}`);
        return sendJson(res, 200, { ok: true, id, hasKey, provider: { ...next, hasKey } });
      }

      if (p === '/api/llm/models' && req.method === 'POST') {
        const body = await readBody(req);
        const cfg = loadConfig();
        const id = String(body.id || cfg.llm.defaultProvider || '');
        let prov = null;
        try {
          prov = resolveProvider(id);
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: e.message });
        }
        const baseUrl = String(body.baseUrl || prov.baseUrl || '').replace(/\/+$/, '');
        const apiKey = body.apiKey ? String(body.apiKey).trim() : prov.apiKey;
        const noAuth = prov.noAuth;
        if (!baseUrl) return sendJson(res, 200, { ok: false, error: '接口地址为空' });
        if (!apiKey && !noAuth) return sendJson(res, 200, { ok: false, error: '还没有 API Key：可以先留空保存，填了 key 再点这里' });
        try {
          const r = await fetch(baseUrl + '/models', {
            headers: { accept: 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
            signal: AbortSignal.timeout(15000),
          });
          const txt = await r.text();
          let j = null;
          try { j = JSON.parse(txt); } catch {}
          if (!r.ok) return sendJson(res, 200, { ok: false, status: r.status, error: String(j?.error?.message || txt).slice(0, 200) });
          const raw = Array.isArray(j) ? j : j?.data || j?.models || [];
          const models = raw
            .map((m) => ({
              id: String(m?.id || m?.name || m?.model || m || ''),
              name: String(m?.name || ''),
              vision: Array.isArray(m?.input_modalities) ? m.input_modalities.includes('image') : undefined,
            }))
            .filter((m) => m.id)
            .slice(0, 200);
          return sendJson(res, 200, { ok: true, count: models.length, models });
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: e.message });
        }
      }

      if (p === '/api/llm/test' && req.method === 'POST') {
        const body = await readBody(req);
        const cfg = loadConfig();
        const id = String(body.id || cfg.llm.defaultProvider || '');
        let prov = null;
        try {
          prov = resolveProvider(id);
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: e.message });
        }
        const baseUrl = String(body.baseUrl || prov.baseUrl || '').replace(/\/+$/, '');
        const model = String(body.model || prov.model || '');
        const apiKey = body.apiKey ? String(body.apiKey).trim() : prov.apiKey;
        const noAuth = body.noAuth != null ? !!body.noAuth : prov.noAuth;
        if (!baseUrl) return sendJson(res, 200, { ok: false, error: '接口地址为空' });
        if (!model) return sendJson(res, 200, { ok: false, error: '模型名为空' });
        if (!apiKey && !noAuth) return sendJson(res, 200, { ok: false, error: '还没有填 API Key（可以留空，但那样连不上）' });
        const t0 = Date.now();
        try {
          const r = await fetch(baseUrl + '/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回复两个字：在的' }], max_tokens: 16, stream: false }),
            signal: AbortSignal.timeout(30000),
          });
          const txt = await r.text();
          let j = null;
          try { j = JSON.parse(txt); } catch {}
          if (!r.ok) {
            return sendJson(res, 200, { ok: false, status: r.status, ms: Date.now() - t0, error: String(j?.error?.message || txt).slice(0, 300) });
          }
          return sendJson(res, 200, {
            ok: true,
            ms: Date.now() - t0,
            model,
            text: String(j?.choices?.[0]?.message?.content || '').slice(0, 80),
          });
        } catch (e) {
          return sendJson(res, 200, { ok: false, ms: Date.now() - t0, error: e.message });
        }
      }

      if (p === '/api/config/set' && req.method === 'POST') {
        const { key, value } = await readBody(req);
        if (!key) throw new Error('缺少 key');
        setConfig(String(key), value);
        return sendJson(res, 200, { ok: true });
      }

      /* ---------- 人格 ---------- */
      if (p === '/api/personas' && req.method === 'GET') return sendJson(res, 200, { list: persona.listPersonas(), active: persona.activePersonaName() });

      if (p === '/api/persona' && req.method === 'GET') {
        const name = url.searchParams.get('name') || persona.activePersonaName();
        if (!name) return sendJson(res, 200, { name: '', text: '' });
        return sendJson(res, 200, persona.readPersona(name));
      }

      if (p === '/api/persona' && req.method === 'POST') {
        const { name, text, action, to } = await readBody(req);
        if (action === 'activate') return sendJson(res, 200, persona.setActivePersona(name || ''));
        if (action === 'delete') {
          persona.deletePersona(name);
          return sendJson(res, 200, { ok: true });
        }
        if (action === 'rename') {
          persona.renamePersona(name, to);
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 200, persona.writePersona(name, text));
      }

      if (p === '/api/persona/activate' && req.method === 'POST') {
        const { name } = await readBody(req);
        return sendJson(res, 200, persona.setActivePersona(name || ''));
      }

      /* ---------- 消息 / 记忆 ---------- */
      if (p === '/api/messages' && req.method === 'GET') {
        const convId = url.searchParams.get('conv') || 'private:0';
        const limit = Number(url.searchParams.get('limit') || 50);
        return sendJson(res, 200, { list: store.recentMessages(convId, limit) });
      }

      if (p === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        return sendJson(res, 200, { list: store.searchMessages(q, 50) });
      }

      if (p === '/api/facts' && req.method === 'GET') {
        return sendJson(res, 200, {
          list: store.listFacts({ limit: 2000 }),
          stats: store.factStats(),
          people: store.listPeople(),
          links: store.listPersonLinks('pending'),
        });
      }

      if (p === '/api/facts' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.action === 'delete') {
          store.deleteFact(body.id);
          return sendJson(res, 200, { ok: true });
        }
        if (body.action === 'update') {
          const out = store.updateFact(body.id, body);
          return sendJson(res, 200, { ok: true, ...out });
        }
        const sid = resolveSubjectInput(body.subjectId || body.subject);
        store.upsertFact({
          subjectId: sid.id,
          subject: sid.name,
          key: body.key,
          value: body.value,
          confidence: body.confidence ?? 0.9,
          source: 'manual',
          speakerQq: sid.id,
          convId: body.convId || null,
        });
        return sendJson(res, 200, { ok: true, subjectId: sid.id });
      }

      if (p === '/api/people' && req.method === 'GET') {
        return sendJson(res, 200, { list: store.listPeople(), links: store.listPersonLinks('pending') });
      }

      if (p === '/api/people/merge' && req.method === 'POST') {
        const { a, b } = await readBody(req);
        if (!a || !b) throw new Error('需要 a / b（两个 QQ 号）');
        const r = store.mergePeople(a, b);
        log.info(`合并身份：${a} → ${b}，证据 ${r.merged} 条`);
        return sendJson(res, 200, { ok: true, ...r });
      }

      if (p === '/api/people/link' && req.method === 'POST') {
        const { id, status } = await readBody(req);
        return sendJson(res, 200, { ok: true, n: store.setPersonLinkStatus(id, status) });
      }

      if (p === '/api/diary' && req.method === 'GET') {
        const convId = url.searchParams.get('conv') || 'private:0';
        return sendJson(res, 200, { list: store.listDiary(convId) });
      }

      if (p === '/api/facts/rename' && req.method === 'POST') {
        const { from, to } = await readBody(req);
        if (!from || !to) throw new Error('需要 from / to');
        const r = store.mergePeople(from, to);
        log.info(`记忆身份合并：${from} → ${to}，证据 ${r.merged} 条`);
        return sendJson(res, 200, { ok: true, ...r });
      }

      if (p === '/api/facts/delete-selected' && req.method === 'POST') {
        const { ids } = await readBody(req);
        if (!Array.isArray(ids) || !ids.length) throw new Error('需要 ids[]');
        const n = store.deleteFacts(ids);
        log.info(`批量删除记忆：选了 ${ids.length} 条，实际删掉 ${n} 条`);
        return sendJson(res, 200, { ok: true, deleted: n });
      }

      if (p === '/api/facts/rename-selected' && req.method === 'POST') {
        const { ids, to } = await readBody(req);
        if (!Array.isArray(ids) || !ids.length || !to) throw new Error('需要 ids[] / to');
        const target = resolveSubjectInput(to);
        const r = store.renameFacts(ids, target.id, target.name);
        log.info(`选中改到「${target.name}(${target.id})」：${ids.length} 条，改了 ${r.renamed}，合并 ${r.merged}，本来就是这个 ${r.skipped}`);
        return sendJson(res, 200, { ok: true, ...r, subjectId: target.id });
      }

      if (p === '/api/facts/export' && req.method === 'POST') {
        const out = {
          generatedAt: new Date().toISOString(),
          note: '这是人可读的导出。要改回数据库请用记忆页的批量改名/逐行编辑；直接改这个文件不会影响 memory.db。',
          facts: store.listFacts({ limit: 5000 }),
          people: store.listPeople(),
          diary: store.listDiary(ownerConv(), 200),
        };
        const file = path.join(PATHS.data, 'memory-export.json');
        await writeFile(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
        return sendJson(res, 200, { ok: true, path: file, facts: out.facts.length, diary: out.diary.length });
      }

      if (p === '/api/open-path' && req.method === 'POST') {
        const { which } = await readBody(req);
        const map = {
          data: PATHS.data,
          db: PATHS.db,
          logs: PATHS.logs,
          config: PATHS.configFile,
        };
        const target = map[which];
        if (!target) throw new Error('不认识的目标: ' + which);
        if (!existsSync(target)) throw new Error('路径不存在: ' + target);
        spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
        return sendJson(res, 200, { ok: true, path: target });
      }

      if (p === '/api/profiles' && req.method === 'GET') {
        const pr = await import('./profiles.js');
        return sendJson(res, 200, { list: pr.listProfiles(), current: loadConfig().access });
      }

      if (p === '/api/profiles/save' && req.method === 'POST') {
        const body = await readBody(req);
        const pr = await import('./profiles.js');
        return sendJson(res, 200, { ok: true, profile: pr.saveProfile(body.name, body.access) });
      }

      if (p === '/api/profiles/apply' && req.method === 'POST') {
        const body = await readBody(req);
        const pr = await import('./profiles.js');
        return sendJson(res, 200, { ok: true, access: pr.applyProfile(body.id) });
      }

      if (p === '/api/profiles/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const pr = await import('./profiles.js');
        return sendJson(res, 200, { ok: pr.deleteProfile(body.id) });
      }

      if (p === '/api/profiles/rename' && req.method === 'POST') {
        const body = await readBody(req);
        const pr = await import('./profiles.js');
        return sendJson(res, 200, { ok: true, profile: pr.renameProfile(body.id, body.name) });
      }

      if (p === '/api/billing' && req.method === 'GET') {
        const cfg2 = loadConfig();
        let billing = null;
        let err = '';
        try {
          const prov = resolveProvider(cfg2.llm.defaultProvider);
          if (!prov.apiKey) err = '没有 api key';
          else {
            const base = prov.baseUrl.replace(/\/v1$/, '');
            const r = await fetch(base + '/user/balance', {
              headers: { authorization: 'Bearer ' + prov.apiKey },
              signal: AbortSignal.timeout(8000),
            });
            if (r.ok) billing = await r.json();
            else err = 'HTTP ' + r.status;
          }
        } catch (e) {
          err = e.message;
        }
        let last = null;
        try {
          const db = store.getDb();
          last = db.prepare('SELECT prompt_tokens, completion_tokens, ts FROM usage ORDER BY id DESC LIMIT 1').get() || null;
        } catch {}
        const ctxWindow = (() => {
          try { return resolveProvider(cfg2.llm.defaultProvider).contextWindow || 128000; } catch { return 128000; }
        })();
        return sendJson(res, 200, { billing, err, last, contextWindow: ctxWindow });
      }

      if (p === '/api/memory/export' && req.method === 'GET') {
        const convParam = url.searchParams.get('conv') || '';
        const convs = convParam ? [convParam] : store.listConvs().map((c) => c.convId);
        const { getRollSummary } = await import('./memory.js');
        const out = { generatedAt: Date.now(), conversations: [] };
        for (const convId of convs) {
          const mark = Number(store.kvGet('export:lastId:' + convId, 0)) || 0;
          const msgs = store
            .messagesSince(convId, mark, 500)
            .filter((m) => m.text && !String(m.text).startsWith('['));
          out.conversations.push({
            convId,
            watermark: mark,
            lastId: msgs.length ? msgs[msgs.length - 1].id : mark,
            facts: store.listFacts({ limit: 500 }),
            diary: store.listDiary(convId, 10),
            roll: getRollSummary(convId),
            messageCount: msgs.length,
            messages: msgs.map((m) => ({ id: m.id, ts: m.ts, role: m.role, who: m.senderName || '', text: m.text })),
          });
        }
        return sendJson(res, 200, out);
      }

      if (p === '/api/memory/import' && req.method === 'POST') {
        const body = await readBody(req, 8 * 1024 * 1024);
        const convId = body.convId;
        if (!convId) throw new Error('需要 convId');
        const isPrivate = String(convId).startsWith('private:');
        let facts = 0;
        let rejected = 0;
        let merged = 0;
        for (const it of body.facts || []) {
          // 和日记整理走同一道门控：元信息 / 头像 / 程序自述 / 低置信度都拦下，同义 key 合并
          const clean = cleanFact(it, isPrivate);
          if (!clean) {
            rejected++;
            continue;
          }
          // 身份：优先用 who_qq，其次按名字反查，最后归到 unknown:
          let sid;
          const rawQq = String(it.who_qq || '').trim();
          if (/^\d{5,12}$/.test(rawQq)) sid = rawQq;
          else if (isPrivate) sid = store.ownerQq();
          else sid = store.resolvePersonBySender(convId, clean.subject) || store.resolvePersonByName(clean.subject) || 'unknown:' + clean.subject;
          const existing = store.listFacts({ subjectIds: [sid] }).map((x) => ({ ...x, subject: sid }));
          const keep = dedupeFact({ ...clean, subject: sid }, existing);
          if (!keep) {
            merged++;
            continue;
          }
          store.upsertFact({
            subjectId: sid,
            subject: clean.subject,
            key: keep.key,
            value: keep.value,
            confidence: keep.confidence,
            source: 'external',
            speakerQq: /^\d{5,12}$/.test(String(it.said_by || '')) ? String(it.said_by) : null,
            convId,
          });
          facts++;
        }
        let diaries = 0;
        for (const d of body.diary || []) {
          if (!d || !d.day || !d.summary) continue;
          store.upsertDiary({ convId, day: String(d.day).slice(0, 10), summary: String(d.summary).slice(0, 2000), mood: d.mood ? String(d.mood).slice(0, 20) : null });
          diaries++;
        }
        if (body.roll) {
          store.kvSet('roll:' + convId, {
            text: String(body.roll).slice(0, 1500),
            upToId: Number(body.markUpTo) || 0,
            updatedAt: Date.now(),
          });
        }
        if (body.markUpTo) store.kvSet('export:lastId:' + convId, Number(body.markUpTo));
        log.info(
          `外部记忆已导入 ${convId}：事实 ${facts}（拦下 ${rejected}，合并 ${merged}），日记 ${diaries}，摘要 ${body.roll ? '有' : '无'}`
        );
        return sendJson(res, 200, { ok: true, facts, rejected, merged, diaries, roll: !!body.roll });
      }

      if (p === '/api/slang' && req.method === 'GET') {
        const { readFileSync, existsSync } = await import('node:fs');
        const file = path.join(PATHS.data, 'slang.json');
        const list = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
        return sendJson(res, 200, { list: Array.isArray(list) ? list : [] });
      }

      if (p === '/api/slang' && req.method === 'POST') {
        const body = await readBody(req);
        const { readFileSync, existsSync, writeFileSync } = await import('node:fs');
        const file = path.join(PATHS.data, 'slang.json');
        let list = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
        if (!Array.isArray(list)) list = [];
        if (body.action === 'delete') {
          list = list.filter((x) => x.content !== body.content);
        } else {
          const item = {
            content: String(body.content || '').trim().slice(0, 40),
            meaning: String(body.meaning || '').trim().slice(0, 300),
            usage: String(body.usage || '').slice(0, 200),
            example: String(body.example || '').slice(0, 120),
            count: Number(body.count) || 0,
            updatedAt: Date.now(),
          };
          if (!item.content) throw new Error('词不能为空');
          const i = list.findIndex((x) => x.content === item.content);
          if (i >= 0) list[i] = { ...list[i], ...item };
          else list.unshift(item);
        }
        writeFileSync(file, JSON.stringify(list, null, 2) + '\n', 'utf8');
        return sendJson(res, 200, { ok: true, total: list.length });
      }

      if (p === '/api/theme' && req.method === 'GET') {
        return sendJson(res, 200, loadConfig().theme || {});
      }

      if (p === '/api/theme' && req.method === 'POST') {
        const body = await readBody(req, 16 * 1024 * 1024);
        const patch = {};
        if (typeof body.accent === 'string' && /^#[0-9a-f]{6}$/i.test(body.accent)) patch.accent = body.accent;
        if (typeof body.accent2 === 'string' && /^#[0-9a-f]{6}$/i.test(body.accent2)) patch.accent2 = body.accent2;
        if (typeof body.bgOpacity === 'number') patch.bgOpacity = Math.max(0, Math.min(1, body.bgOpacity));
        if (body.bgDataUrl === null) patch.bg = '';
        else if (typeof body.bgDataUrl === 'string' && body.bgDataUrl.startsWith('data:image/')) {
          const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/i.exec(body.bgDataUrl);
          if (!m) throw new Error('不支持的图片格式（png/jpg/webp/gif）');
          const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
          const buf = Buffer.from(m[2], 'base64');
          if (buf.length > 12 * 1024 * 1024) throw new Error('背景图太大（>12MB）');
          const { writeFileSync } = await import('node:fs');
          writeFileSync(path.join(PATHS.data, 'theme-bg.' + ext), buf);
          patch.bg = '/media/theme-bg.' + ext + '?v=' + Date.now();
        }
        setConfig('theme', { ...(loadConfig().theme || {}), ...patch });
        return sendJson(res, 200, { ok: true, theme: loadConfig().theme });
      }

      if (p === '/api/zone/drafts' && req.method === 'GET') {
        const z = await import('./zone.js');
        return sendJson(res, 200, { list: z.listDrafts(), uin: onebot.selfId || 0 });
      }

      if (p === '/api/zone/generate' && req.method === 'POST') {
        const body = await readBody(req);
        const z = await import('./zone.js');
        const d = await z.generateDraft({ convId: body.conv });
        return sendJson(res, 200, { ok: true, draft: d });
      }

      if (p === '/api/zone/update' && req.method === 'POST') {
        const body = await readBody(req);
        const z = await import('./zone.js');
        const patch = {};
        if (typeof body.text === 'string') patch.text = body.text.slice(0, 500);
        if (body.status) patch.status = body.status;
        return sendJson(res, 200, { ok: true, draft: z.updateDraft(body.id, patch) });
      }

      if (p === '/api/zone/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const z = await import('./zone.js');
        return sendJson(res, 200, { ok: z.deleteDraft(body.id) });
      }

      if (p === '/api/zone/publish' && req.method === 'POST') {
        const body = await readBody(req);
        const z = await import('./zone.js');
        const { spawn } = await import('node:child_process');
        const { writeFileSync } = await import('node:fs');
        const tmp = path.join(PATHS.data, '.clip.txt');
        const list = z.listDrafts();
        const draft = list.find((d) => d.id === body.id);
        if (!draft) throw new Error('草稿不存在');

        const text = body.text || draft.text;
        writeFileSync(tmp, text, 'utf8');
        // 塞进剪贴板（PowerShell 5.1 自带 Set-Clipboard）
        spawn('powershell.exe', ['-NoProfile', '-Command', `Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 '${tmp}')`], {
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
        }).unref();

        const url = z.publishUrl(onebot.selfId);
        spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();

        z.markPublished(body.id);
        log.info('说说已复制到剪贴板并打开空间发布页');
        return sendJson(res, 200, { ok: true, url, copied: text });
      }

      if (p === '/api/stickers' && req.method === 'GET') {
        const m = await import('./media.js');
        return sendJson(res, 200, { list: m.listStickers(), tags: m.stickerTags() });
      }

      if (p === '/api/stickers/import' && req.method === 'POST') {
        const m = await import('./media.js');
        const out = await m.importLegacy(path.join(PATHS.data, 'legacy-stickers.json'));
        return sendJson(res, 200, out);
      }

      if (p === '/api/stickers/scan' && req.method === 'POST') {
        const m = await import('./media.js');
        return sendJson(res, 200, m.scanDir());
      }

      if (p === '/api/stickers/review' && req.method === 'POST') {
        const body = await readBody(req);
        const m = await import('./media.js');
        const out = body.action === 'approve' ? m.approveSticker(body.id) : m.rejectSticker(body.id);
        return sendJson(res, 200, { ok: true, item: out });
      }

      if (p === '/api/stickers/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const m = await import('./media.js');
        return sendJson(res, 200, { ok: true, deleted: m.deleteStickers(body.ids || []) });
      }

      if (p === '/api/stickers/autotag' && req.method === 'POST') {
        const body = await readBody(req);
        const media = await import('./media.js');
        const llm = await import('./llm.js');
        const cfg = loadConfig();
        const prov = resolveProvider(cfg.llm.defaultProvider);
        const model = cfg.llm.visionModel || prov.model;
        const limit = Math.min(Number(body.limit) || 8, 20);
        const { readFileSync } = await import('node:fs');
        const todo = media.listStickers().filter((x) => x.exists && !x.desc).slice(0, limit);
        const done = [];
        for (const it of todo) {
          try {
            const buf = readFileSync(path.join(PATHS.stickers, it.file));
            let mime = 'image/png';
            if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
            else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
            const word = await llm.complete({
              provider: prov,
              model,
              maxTokens: 320,
              temperature: 0.3,
              messages: [
                { role: 'system', content: '你在给 QQ 表情包打心情标签。只输出 2~6 个字的情绪词，例如：无语、抱抱、得意、嫌弃。不要标点、不要解释。' },
                { role: 'user', content: [
                  { type: 'text', text: '这张表情包传达什么情绪？只答情绪词。' },
                  { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } },
                ] },
              ],
            });
            const clean = String(word).replace(/[\s"'。，,、]/g, '').slice(0, 8);
            if (clean) {
              media.setStickerMeta(it.id, { desc: clean, tags: [clean] });
              done.push({ id: it.id, desc: clean });
            }
          } catch (err) {
            log.warn('打标失败 ' + it.file + ': ' + err.message);
          }
        }
        return sendJson(res, 200, { ok: true, tagged: done.length, left: media.listStickers().filter((x) => !x.desc).length, done });
      }

      if (p === '/api/stickers/remark' && req.method === 'POST') {
        const body = await readBody(req);
        const m = await import('./media.js');
        const it = m.setStickerMeta(body.id, { desc: body.desc, tags: body.tags, note: body.note });
        return sendJson(res, 200, { ok: true, sticker: it });
      }

      if (p === '/api/send/sticker' && req.method === 'POST') {
        const body = await readBody(req);
        const m = await import('./media.js');
        const r = await m.sendSticker(onebot, body.conv, body.query);
        return sendJson(res, 200, { ok: true, sticker: r.sticker.desc || r.sticker.file });
      }

      if (p === '/api/send/voice' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.conv || !body.text) throw new Error('需要 conv 和 text');
        const tts = await import('./tts.js');
        const r = await tts.sendVoice(onebot, body.conv, body.text, { voice: body.voice, rate: body.rate });
        store.addMessage({
          convId: body.conv,
          role: 'assistant',
          text: '[语音] ' + r.text,
          kind: 'voice',
          meta: { messageId: r.messageId, file: r.file },
        });
        return sendJson(res, 200, { ok: true, file: r.file, bytes: r.bytes, messageId: r.messageId });
      }

      if (p === '/api/tts' && req.method === 'GET') {
        const t = loadConfig().tts || {};
        return sendJson(res, 200, {
          provider: t.provider || 'sapi',
          voice: t.voice || '',
          rate: t.rate ?? 0,
          maxChars: t.maxChars ?? 200,
          enabled: t.enabled !== false,
          breeze: t.breeze || {},
          hasKey: !!secrets().breezeApiKey,
        });
      }

      if (p === '/api/tts' && req.method === 'POST') {
        const body = await readBody(req);
        const patchTts = ttsPatchFromBody(body);
        if (Object.keys(patchTts).length) saveConfig({ tts: patchTts });
        if (body.clearKey) saveSecrets({ breezeApiKey: null });
        else if (body.apiKey && String(body.apiKey).trim()) saveSecrets({ breezeApiKey: String(body.apiKey).trim() });
        const t = loadConfig().tts || {};
        return sendJson(res, 200, { ok: true, hasKey: !!secrets().breezeApiKey, tts: t });
      }

      if (p === '/api/tts/voices' && req.method === 'POST') {
        const body = await readBody(req);
        const tts = await import('./tts.js');
        const list = await tts.listVoices({
          language: String(body.language || loadConfig().tts?.breeze?.language || 'zh'),
          gender: body.gender === null ? '' : String(body.gender || 'female'),
          search: String(body.search || ''),
          apiKey: body.apiKey ? String(body.apiKey).trim() : '',
        });
        return sendJson(res, 200, { ok: true, list });
      }

      if (p === '/api/tts/test' && req.method === 'POST') {
        const body = await readBody(req);
        const tts = await import('./tts.js');
        const r = await tts.synthesize(body.text || '你好呀，听得到吗？', {
          provider: body.provider,
          apiKey: body.apiKey ? String(body.apiKey).trim() : undefined,
          ...(body.breeze || {}),
        });
        const { readFileSync } = await import('node:fs');
        const buf = readFileSync(r.file);
        const mime =
          r.format === 'wav' ? 'audio/wav' : r.format === 'flac' ? 'audio/flac' : r.format === 'pcm' ? 'application/octet-stream' : 'audio/mpeg';
        return sendJson(res, 200, {
          ok: true,
          file: r.file,
          format: r.format,
          bytes: buf.length,
          dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
        });
      }

      if (p === '/api/test/tts' && req.method === 'POST') {
        const body = await readBody(req);
        const tts = await import('./tts.js');
        const r = await tts.synthesize(body.text || '你好，测试一下语音。', { voice: body.voice, rate: body.rate });
        return sendJson(res, 200, { ok: true, file: r.file, bytes: r.bytes });
      }

      if (p === '/api/send/image' && req.method === 'POST') {
        const body = await readBody(req);
        const m = await import('./media.js');
        const mid = await m.sendImage(onebot, body.conv, path.join(PATHS.images, body.file || ''));
        return sendJson(res, 200, { ok: true, messageId: mid });
      }

      if (p === '/api/diary/generate' && req.method === 'POST') {
        const { conv } = await readBody(req);
        const convId = conv || 'private:0';
        const { runDiary } = await import('./memory.js');
        const out = await runDiary(convId, bus, { force: true });
        return sendJson(res, 200, out);
      }

      /* ---------- 测试 ---------- */
      if (p === '/api/test/llm' && req.method === 'POST') {
        const cfg = loadConfig();
        const provider = resolveProvider(cfg.llm.defaultProvider);
        const { complete } = await import('./llm.js');
        const t0 = Date.now();
        const text = await complete({
          provider,
          model: provider.model,
          messages: [
            { role: 'system', content: '你是一个连通性测试助手。' },
            { role: 'user', content: '只回复四个字：链路正常' },
          ],
          maxTokens: 32,
        });
        return sendJson(res, 200, { ok: true, ms: Date.now() - t0, model: provider.model, text });
      }

      if (p === '/api/test/preview' && req.method === 'POST') {
        const { text, conv } = await readBody(req);
        if (!text) throw new Error('缺少 text');
        const out = await agent.preview(conv || `console:${Date.now()}`, text);
        return sendJson(res, 200, out);
      }

      if (p === '/api/test/reply-live' && req.method === 'POST') {
        const { conv, text } = await readBody(req);
        if (!conv || !text) throw new Error('需要 conv 和 text');
        store.addMessage({ convId: conv, role: 'user', senderId: 'console', senderName: '试聊', text });
        const out = await agent.reply(conv, { partnerName: '我', userText: text });
        return sendJson(res, 200, out);
      }

      if (p === '/api/test/onebot' && req.method === 'POST') {
        const info = await onebot.call('get_login_info', {}, { timeout: 8000 });
        return sendJson(res, 200, { ok: true, info });
      }

      if (p === '/api/send' && req.method === 'POST') {
        const { conv, text } = await readBody(req);
        const id = await onebot.send(conv, text);
        store.addMessage({ convId: conv, role: 'assistant', text, meta: { messageId: id, via: 'console' } });
        return sendJson(res, 200, { ok: true, messageId: id });
      }

      if (req.method === 'GET' && p.startsWith('/media/')) {
        const rel = p.slice('/media/'.length);
        const file = path.join(PATHS.data, rel);
        if (!file.startsWith(PATHS.data)) return sendJson(res, 403, { error: 'forbidden' });
        try {
          const data = await readFile(file);
          res.writeHead(200, {
            'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'public, max-age=3600',
          });
          return res.end(data);
        } catch {
          res.writeHead(404).end();
          return;
        }
      }

      /* ---------- 静态资源 ---------- */
      if (req.method === 'GET' || req.method === 'HEAD') {
        let rel = p === '/' ? '/index.html' : p;
        const file = path.join(PATHS.ui, rel);
        if (!file.startsWith(PATHS.ui)) return sendJson(res, 403, { error: 'forbidden' });
        let target = file;
        if (!existsSync(target)) {
          const alt = path.join(PATHS.ui, 'index.html');
          if (existsSync(alt) && !path.extname(p)) target = alt;
          else {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            return res.end('404');
          }
        }
        const st = await stat(target);
        if (!st.isFile()) {
          res.writeHead(404).end();
          return;
        }
        const data = await readFile(target);
        res.writeHead(200, {
          'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
          'content-length': data.length,
          'cache-control': 'no-store, must-revalidate',
        });
        return res.end(req.method === 'HEAD' ? undefined : data);
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      log.error(`${req.method} ${p} -> ${err.message}`);
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: err.message });
      else res.end();
    }
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* ignore */
    }
  });

  return server;
}
