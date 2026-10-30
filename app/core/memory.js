// 记忆整理器：把聊天记录压缩成「她记住的那一天」+ 抽取长期事实。
// 触发：消息停止 3 分钟后自动跑一次（每个会话独立计时），也可由控制台手动触发。
import { loadConfig, resolveProvider, pickModel } from './config.js';
import { complete } from './llm.js';
import * as store from './store.js';
import { logger } from './log.js';

const log = logger('memory');
const IDLE_MS = 3 * 60 * 1000;
const timers = new Map();

export function localDay(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 消息停止 IDLE_MS 后自动整理；重复调用会重置计时 */
export function scheduleDiary(convId, bus) {
  const prev = timers.get(convId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(convId);
    runDiary(convId, bus).catch((err) => log.error('自动整理失败: ' + err.message));
  }, IDLE_MS);
  t.unref?.();
  timers.set(convId, t);
}

export function pendingCount() {
  return timers.size;
}

/* ---------------- 写入门控 ---------------- */

// key 明显是「在测试她 / 聊模型」这类元信息，不算关于这个人的事实
const META_KEY_RE = /(测试|调试|报错|bug|性能|提示词|人格卡|上下文|模型能力)/i;
// 头像/人设属于 UI 和人格卡，不该进「关于这个人」的记忆
const PERSONA_KEY_RE = /(头像|人设|人格|设定)/;
const BAD_WHO_RE = /^(控制台|console|试聊|系统|未知|我|他|她|ta)$/i;
const HAS_WORD_RE = /[A-Za-z0-9\u3400-\u9fff]/;
// config 没说的时候用这份兜底
const DEFAULT_JUNK_VALUE = ['条数限制', '消息会卡', '私聊会卡', '群消息会卡', '上下文上限', '上下文占用', '省token', 'token数', '限流'];

function junkValuePatterns() {
  const list = loadConfig().memory?.junkPatterns;
  return Array.isArray(list) && list.length ? list.map((x) => String(x)).filter(Boolean) : DEFAULT_JUNK_VALUE;
}

/** 去掉空格/标点/符号后再比，避免「称呼」和「称呼。」被当两条 */
export function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 一眼就是垃圾的事实：空值、纯标点/表情、元信息 key、头像/人设、程序自述 */
export function isJunkFact(key, value) {
  const k = String(key || '').trim();
  const v = String(value || '').trim();
  if (!k || !v) return true;
  if (!HAS_WORD_RE.test(v)) return true;
  if (META_KEY_RE.test(k)) return true;
  if (PERSONA_KEY_RE.test(k)) return true;
  const lower = v.toLowerCase();
  if (junkValuePatterns().some((p) => lower.includes(p.toLowerCase()))) return true;
  return false;
}

/** 单条事实清洗：不合法返回 null（宁可不记，也不记脏的） */
export function cleanFact(f, isPrivate) {
  if (!f || !f.key || !f.value) return null;
  const key = String(f.key).trim().slice(0, 20);
  const value = String(f.value).trim().slice(0, 200);
  if (!key || !value) return null;
  if (isJunkFact(key, value)) return null;
  const confidence = Math.max(0.3, Math.min(1, Number(f.confidence) || 0.7));
  if (confidence < 0.45) return null; // 标准档：太不确定的不入库
  const rawWho = String(f.who || '')
    .trim()
    .replace(/^[@＠]/, '')
    .slice(0, 20);
  // 私聊只有一个对方；群聊里的「控制台/我/他」不是名字，别记成人名
  const subject = isPrivate ? 'owner' : BAD_WHO_RE.test(rawWho) ? '对方' : rawWho || '对方';
  return { subject, key, value, confidence };
}

/**
 * 和已有事实比对：同一个 subject 下，key 只是换个说法（互相包含）就不新增，
 * 只在「新值更具体 / 置信度明显更高」时覆盖，并且沿用已有的 key，避免来回改名。
 * 一正一反（「玩王者」/「不玩王者」）不算同一条。
 */
const NEG_RE = /^[不没别无非]/;
export function dedupeFact(clean, existing) {
  const nk = normKey(clean.key);
  for (const e of existing) {
    if (e.subject !== clean.subject) continue;
    const ek = normKey(e.key);
    if (!ek || !nk) continue;
    if (ek === nk) return { ...clean, key: e.key };
    if (NEG_RE.test(nk) !== NEG_RE.test(ek)) continue; // 一正一反，别合并
    const shorter = ek.length <= nk.length ? ek : nk;
    if (shorter.length >= 2 && (ek.includes(nk) || nk.includes(ek))) {
      const richer = clean.value.length > String(e.value).length + 2 || clean.confidence > Number(e.confidence) + 0.1;
      return richer ? { ...clean, key: e.key } : null;
    }
  }
  return clean;
}

/** 这条事实是关于谁的：模型给的 QQ 优先，其次按名字反查发送者/别名，最后归到 unknown: */
function resolveSubjectId(f, clean, isPrivate, convId) {
  const raw = String(f.who_qq || '').trim();
  if (/^\d{5,12}$/.test(raw)) return raw;
  if (isPrivate) return store.ownerQq();
  const bySender = store.resolvePersonBySender(convId, clean.subject);
  if (bySender) return bySender;
  const byAlias = store.resolvePersonByName(clean.subject);
  if (byAlias) return byAlias;
  return 'unknown:' + clean.subject;
}

const DIGEST_SYSTEM = `你是「她」的记忆整理器。给你一段 QQ 聊天记录，你要把它压成她自己的长期记忆。

只输出 JSON，不要任何解释、不要 markdown 代码块。

格式：
{"summary":"...","mood":"...","highlights":["..."],"facts":[{"who":"...","who_qq":"...","said_by":"...","key":"...","value":"...","confidence":0.8}]}

要求：
- summary：用「我」的第一人称写，80~200 字，像日记。只写真正发生的事和感受，不要"用户说/对方表示"这种转述腔，不要总结升华。
- mood：2~4 个字的心情词（例如：有点累、挺开心、被逗笑）。
- highlights：最多 3 条，每条 10~20 字，是以后想起来会笑/会心疼的片段。
- facts：值得长期记住的事实。who = 关于谁的（写聊天记录里的昵称）；who_qq = 那个人的 QQ（照抄记录里方括号中的数字，不确定就留空）；said_by = 这句话是谁说的（也填 QQ，本人说自己的事就与 who_qq 相同）。key ≤ 8 字，value ≤ 30 字，confidence 0~1。群聊里务必分清是谁说的，不要把别人的事记在另一个人头上。
- 寒暄、表情、"在吗""哈哈"这类没有信息量的内容一律不要写进 facts。
- 如果这段对话没什么可记的，summary 可以短，facts 给空数组。`;

function parseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/**
 * 整理某个会话当天的对话。
 * @param {string} convId
 * @param {import('node:events').EventEmitter} [bus]
 * @param {{force?:boolean}} [opts]
 */
export async function runDiary(convId, bus, opts = {}) {
  const cfg = loadConfig();
  const day = localDay();
  // 控制台「试聊」不是真实关系，不进记忆（否则会把「控制台」记成一个人）
  if (String(convId).startsWith('console:')) {
    return { skipped: '试聊会话不写入记忆', convId, day };
  }
  const rows = store
    .recentMessages(convId, 200)
    .filter((m) => m.role !== 'system' && m.senderId !== 'console' && localDay(m.ts) === day && m.text);

  if (rows.length < 2) return { skipped: '今天还没有足够的对话', convId, day };

  const maxId = rows[rows.length - 1].id;
  const lastMark = Number(store.kvGet(`diary:lastId:${convId}`, 0)) || 0;
  if (!opts.force && maxId <= lastMark) {
    return { skipped: '今天的对话已经整理过了', convId, day };
  }

  const transcript = rows
    .map((m) => (m.role === 'user' ? `[${m.senderId || '?'}] ${m.senderName || '对方'}` : '我') + '：' + m.text)
    .join('\n')
    .slice(-6000);

  const provider = resolveProvider(cfg.llm.defaultProvider);
  const t0 = Date.now();
  let raw = '';
  try {
    raw = await complete({
      provider,
      model: pickModel() || provider.model,
      messages: [
        { role: 'system', content: DIGEST_SYSTEM },
        {
          role: 'user',
          content: `日期：${day}\n会话：${convId}\n\n聊天记录：\n${transcript}`,
        },
      ],
      temperature: 0.4,
      maxTokens: 900,
    });
  } catch (err) {
    log.error('摘要请求失败: ' + err.message);
    return { error: err.message };
  }

  const parsed = parseJson(raw);
  if (!parsed || !parsed.summary) {
    log.warn('摘要解析失败，原文前 120 字: ' + raw.slice(0, 120));
    return { error: '模型返回的不是合法 JSON' };
  }

  store.upsertDiary({
    convId,
    day,
    summary: String(parsed.summary).slice(0, 2000),
    mood: parsed.mood ? String(parsed.mood).slice(0, 20) : null,
    highlights: Array.isArray(parsed.highlights) ? parsed.highlights.slice(0, 5).map(String) : null,
  });

  store.setConvState(convId, { mood: parsed.mood ? String(parsed.mood).slice(0, 20) : null });

  const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
  const isPrivate = String(convId).startsWith('private:');
  let factCount = 0;
  let rejected = 0;
  let merged = 0;
  const seen = new Set();
  for (const f of facts.slice(0, 12)) {
    const clean = cleanFact(f, isPrivate);
    if (!clean) {
      rejected++;
      continue;
    }
    // 身份：优先用模型照抄的 QQ，其次按名字反查，最后归到 unknown:昵称
    const sid = resolveSubjectId(f, clean, isPrivate, convId);
    const subjectName = clean.subject;
    if (seen.has(sid + '|' + normKey(clean.key))) continue; // 同一轮里自己重复
    const existing = store.listFacts({ subjectIds: [sid] }).map((x) => ({ ...x, subject: sid }));
    const keep = dedupeFact({ ...clean, subject: sid }, existing);
    if (!keep) {
      merged++;
      continue;
    }
    seen.add(sid + '|' + normKey(keep.key));
    store.upsertFact({
      subjectId: sid,
      subject: subjectName,
      key: keep.key,
      value: keep.value,
      confidence: keep.confidence,
      source: `diary:${day}`,
      speakerQq: String(f.said_by || '').match(/^\d{5,12}$/) ? String(f.said_by) : null,
      convId,
    });
    factCount++;
  }

  store.kvSet(`diary:lastId:${convId}`, maxId);
  store.recordUsage({
    convId,
    provider: cfg.llm.defaultProvider,
    model: provider.model,
    promptTokens: Math.round(transcript.length / 2),
    completionTokens: Math.round(raw.length / 2),
    latencyMs: Date.now() - t0,
  });

  log.info(`日记已生成 ${convId} / ${day}：${parsed.summary.length} 字，新事实 ${factCount} 条（拦下 ${rejected}，合并 ${merged}），${Date.now() - t0}ms`);
  bus?.emit('agent', {
    type: 'diary',
    convId,
    day,
    summary: parsed.summary,
    mood: parsed.mood || '',
    facts: factCount,
  });

  return { ok: true, convId, day, summary: parsed.summary, mood: parsed.mood, highlights: parsed.highlights, facts: factCount };
}

/* ---------------- 滚动摘要 ---------------- */

export function getRollSummary(convId) {
  const v = store.kvGet('roll:' + convId, null);
  return v && v.text ? String(v.text) : '';
}

/**
 * 对话超过 rollAfter 条时，把最老的部分压成一段摘要；
 * 只保留最后 rollKeep 条原始消息。已有摘要会和新内容合并。
 */
export async function maybeRollSummary(convId, bus) {
  const cfg = loadConfig();
  const rollAfter = Number(cfg.memory?.rollAfter) || 40;
  const keep = Number(cfg.memory?.rollKeep) || 20;

  const rows = store.recentMessages(convId, 400).filter((m) => m.text && !String(m.text).startsWith('['));
  if (rows.length <= rollAfter) return { skipped: '对话还不够长' };

  const cut = rows.length - keep;
  const prev = store.kvGet('roll:' + convId, null) || { text: '', upToId: 0 };
  const fresh = rows.slice(0, cut).filter((m) => m.id > (Number(prev.upToId) || 0));
  if (!fresh.length) return { skipped: '没有新内容需要压缩' };

  const transcript = fresh
    .map((m) => (m.role === 'user' ? m.senderName || '对方' : '我') + '：' + m.text)
    .join('\n')
    .slice(-4500);

  const provider = resolveProvider(cfg.llm.defaultProvider);
  const model = pickModel() || provider.model;
  const t0 = Date.now();
  const out = await complete({
    provider,
    model,
    maxTokens: 900,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content:
          '把这段对话压成一段摘要，150 字以内。保留：谁说了什么关键的事、情绪变化、没聊完的话题、答应过的事。\n' +
          '不要评价、不要总结升华、不要写"用户说"这种转述腔，用第一人称"我/他"。只输出摘要正文。',
      },
      {
        role: 'user',
        content: (prev.text ? '【已有的摘要】\n' + prev.text + '\n\n' : '') + '【新对话】\n' + transcript,
      },
    ],
  });

  const text = String(out || '').trim().slice(0, 800);
  if (!text) return { error: '摘要为空' };

  const lastId = fresh[fresh.length - 1].id;
  store.kvSet('roll:' + convId, { text, upToId: lastId, updatedAt: Date.now() });
  store.recordUsage({
    convId,
    provider: cfg.llm.defaultProvider,
    model,
    promptTokens: Math.round(transcript.length / 2),
    completionTokens: Math.round(text.length / 2),
    latencyMs: Date.now() - t0,
  });
  log.info('滚动摘要已更新 ' + convId + '：' + text.length + ' 字，覆盖到 id=' + lastId);
  bus?.emit('agent', { type: 'roll', convId, chars: text.length });
  return { ok: true, text, covered: lastId };
}
