// QQ 空间说说（半自动）：她写草稿 → 控制台审核 → 一键复制 + 打开空间发布页。
// 不做 cookie 自动发布（风控 + 掉登录），只做"她起草、你点头"。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PATHS, loadConfig, resolveProvider, pickModel } from './config.js';
import { complete, estimateTokens } from './llm.js';
import * as store from './store.js';
import { activePersonaText } from './persona.js';
import { logger } from './log.js';

const log = logger('zone');
const FILE = path.join(PATHS.data, 'zone.json');

function load() {
  try {
    if (!existsSync(FILE)) return { drafts: [] };
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!Array.isArray(j.drafts)) j.drafts = [];
    return j;
  } catch {
    return { drafts: [] };
  }
}

function save(z) {
  writeFileSync(FILE, JSON.stringify(z, null, 2) + '\n', 'utf8');
}

export function listDrafts() {
  return load().drafts.slice().sort((a, b) => b.createdAt - a.createdAt);
}

export function updateDraft(id, patch) {
  const z = load();
  const d = z.drafts.find((x) => x.id === id);
  if (!d) throw new Error('草稿不存在');
  Object.assign(d, patch, { updatedAt: Date.now() });
  save(z);
  return d;
}

export function deleteDraft(id) {
  const z = load();
  const n = z.drafts.length;
  z.drafts = z.drafts.filter((x) => x.id !== id);
  save(z);
  return n !== z.drafts.length;
}

const SYS = `你在替「她」写自己的 QQ 空间说说。

要求：
- 30~80 字，第一人称，像真人随手一发的碎碎念。
- 可以是：一句抱怨、一个念头、一件小事、一句只有特定的人看得懂的话。
- 不要总结今天、不要写成日记、不要"今天也是充实的一天"这种空话。
- 不要提 AI、模型、助手、用户。
- emoji 最多 1 个，也可以没有。不要话题标签。
- 只输出 JSON：{"text":"说说正文","mood":"心情词","imageHint":"如果有画面感，用一句话描述配图；没有就空字符串"}`;

/**
 * 让她写一条说说草稿。
 * @param {{convId?:string}} opts
 */
export async function generateDraft(opts = {}) {
  const cfg = loadConfig();
  const convId = opts.convId || (cfg.access?.ownerQQ ? `private:${cfg.access.ownerQQ}` : '');
  const persona = activePersonaText();
  const st = convId ? store.getConvState(convId) : null;
  const diary = convId ? store.listDiary(convId, 5) : [];
  const facts = convId ? store.listFacts({ subjectIds: [store.ownerQq()] }).slice(0, 15) : [];
  const recent = convId
    ? store
        .recentMessages(convId, 30)
        .filter((m) => m.text && !String(m.text).startsWith('['))
        .slice(-12)
    : [];

  const ctx = [];
  if (persona.text) ctx.push(`# 你是谁\n${persona.text.slice(0, 2500)}`);
  if (diary.length) {
    ctx.push(
      '# 最近记得的日子\n' +
        diary.map((d) => `${d.day}（${d.mood || '—'}）：${d.summary}`).join('\n')
    );
  }
  if (facts.length) {
    ctx.push('# 你记得的事\n' + facts.map((f) => `- ${f.key}：${f.value}`).join('\n'));
  }
  if (st?.mood) ctx.push(`# 此刻心情\n${st.mood}`);
  if (recent.length) {
    ctx.push(
      '# 刚才的聊天（别直接复述）\n' +
        recent.map((m) => `${m.role === 'user' ? m.senderName || '对方' : '我'}：${m.text}`).join('\n')
    );
  }

  const provider = resolveProvider(cfg.llm.defaultProvider);
  const t0 = Date.now();
  const raw = await complete({
    provider,
    model: pickModel() || provider.model,
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: ctx.join('\n\n') + '\n\n写一条说说。' },
    ],
    temperature: 1.1,
    maxTokens: 400,
  });

  let text = raw.trim();
  let mood = '';
  let imageHint = '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      text = String(j.text || text);
      mood = String(j.mood || '');
      imageHint = String(j.imageHint || '');
    } catch {
      /* 保留原文 */
    }
  }
  text = text.replace(/^```[\s\S]*?\n|```$/g, '').trim().slice(0, 300);
  if (!text) throw new Error('模型没有产出内容');

  const z = load();
  const draft = {
    id: `zd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    text,
    mood,
    imageHint,
    convId,
    status: 'draft',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    publishedAt: null,
  };
  z.drafts.unshift(draft);
  if (z.drafts.length > 200) z.drafts.length = 200;
  save(z);

  store.recordUsage({
    convId,
    provider: cfg.llm.defaultProvider,
    model: provider.model,
    promptTokens: estimateTokens(ctx.join('\n')),
    completionTokens: estimateTokens(raw),
    latencyMs: Date.now() - t0,
  });

  log.info(`说说草稿已生成（${text.length} 字，${Date.now() - t0}ms）`);
  return draft;
}

/** 标记为已发布（由控制台在"复制并打开空间"之后调用） */
export function markPublished(id) {
  return updateDraft(id, { status: 'published', publishedAt: Date.now() });
}

/** 空间发布页地址 */
export function publishUrl(uin) {
  return `https://user.qzone.qq.com/${uin || ''}/mood`;
}
