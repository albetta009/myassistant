// 召回：不再把全部 facts 塞进提示词，而是按「证据 / 鲜活度 / 重要度 / 刚用过」打分取 top-k，
// 并把「谁进了、谁没进、为什么没进」记下来给控制台看。
import { loadConfig } from './config.js';
import * as store from './store.js';

const CJK = /[\u3400-\u9fff]/;

/** 分词：英文/数字词 + 中文二元组（不引 jieba，够用且零依赖） */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
  for (const seg of s.replace(/[^\u3400-\u9fff]+/g, ' ').split(/\s+/)) {
    if (!seg) continue;
    const chars = [...seg];
    if (chars.length === 1) out.add(chars[0]);
    for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

function daysAgo(ts) {
  if (!ts) return Infinity;
  return Math.max(0, (Date.now() - Number(ts)) / 86400000);
}

function config() {
  const m = loadConfig().memory || {};
  return {
    enabled: true,
    topK: 6,
    maxChars: 800,
    halfLifeDays: 30,
    weights: { evidence: 0.5, vitality: 0.26, importance: 0.16, usage: 0.08 },
    ...(m.recall || {}),
  };
}

/**
 * 给这个会话挑几条「值得想起来的」事实。
 * @returns {{picked:Array, dropped:Array, telemetry:object, block:string}}
 */
export function selectFacts({ convId, query = '', limitChars = null }) {
  const t0 = performance.now();
  const cfg = config();
  // 记忆是全局的：优先取「当前会话里最近说话的人」+ 主人 + pinned
  let speakers = [];
  try {
    speakers = store
      .recentMessages(convId, 8)
      .map((m) => (m.role === 'user' ? String(m.senderId || '') : ''))
      .filter(Boolean);
  } catch {
    speakers = [];
  }
  const subjectIds = [...new Set([...speakers, store.ownerQq()])];
  const factsAll = [...store.listFacts({ subjectIds }), ...store.listPinnedFacts(10)];
  const seenId = new Set();
  const deduped = factsAll.filter((f) => (seenId.has(f.id) ? false : (seenId.add(f.id), true)));
  factsAll.length = 0;
  factsAll.push(...deduped);
  const lastSpeaker = speakers.length ? speakers[speakers.length - 1] : '';
  if (!cfg.enabled) {
    const picked = factsAll.slice(0, 40);
    return {
      picked,
      dropped: [],
      telemetry: { ts: Date.now(), convId, query, mode: 'full', ms: Math.round((performance.now() - t0) * 10) / 10, total: factsAll.length, picked: picked.length },
      block: factsAll.length ? formatBlock(picked) : '',
    };
  }

  const alive = factsAll; // 每行都是「当前值」；prevValue 只用来提示它被更新过
  const history = factsAll.filter((f) => f.prevValue);

  // 以「活着的 facts」为语料算 IDF：越少见的词越有证据价值
  const docs = alive.map((f) => {
    const text = `${f.subject || ''} ${f.key || ''} ${f.value || ''}`;
    return { f, toks: tokenize(text) };
  });
  const N = Math.max(1, docs.length);
  const df = new Map();
  for (const d of docs) for (const t of d.toks) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));
  const qToks = tokenize(query);
  let qMass = 0;
  for (const t of qToks) qMass += idf(t);

  const scored = docs.map(({ f, toks }) => {
    let hit = 0;
    const matched = [];
    for (const t of qToks) {
      if (toks.has(t)) {
        hit += idf(t);
        matched.push(t);
      }
    }
    let evidence = qMass > 0 ? Math.min(1, hit / qMass) : 0;
    if (query && String(query).toLowerCase().includes(String(f.key || '').toLowerCase())) evidence = Math.min(1, evidence + 0.15);
    // 正在说话的人，相关记忆更容易被想起来
    if (lastSpeaker && String(f.subjectId) === lastSpeaker) evidence = Math.min(1, evidence + 0.1);
    const vitality = Math.pow(0.5, daysAgo(f.updatedAt) / Math.max(1, Number(cfg.halfLifeDays) || 30));
    const importance = (Math.min(1, Number(f.confidence || 0.6)) + (f.pinned ? 0.2 : 0)) / 1.2;
    const usage = f.lastUsedAt ? Math.exp(-daysAgo(f.lastUsedAt) / 7) : 0;
    const w = cfg.weights || {};
    const score =
      (Number(w.evidence) || 0.5) * evidence +
      (Number(w.vitality) || 0.26) * vitality +
      (Number(w.importance) || 0.16) * importance +
      (Number(w.usage) || 0.08) * usage;
    return { f, evidence, vitality, importance, usage, score: Math.round(score * 1000) / 1000, matched: matched.slice(0, 6) };
  });

  // 固定（pinned）的先给，最多 3 条；其余按分数
  scored.sort((a, b) => (b.f.pinned ? 1 : 0) - (a.f.pinned ? 1 : 0) || b.score - a.score);

  const maxChars = Number(limitChars || cfg.maxChars) || 800;
  const topK = Math.max(1, Number(cfg.topK) || 6);
  const picked = [];
  const dropped = [];
  let chars = 0;
  let pinnedUsed = 0;
  for (const s of scored) {
    const lineLen = String(s.f.key || '').length + String(s.f.value || '').length + 8;
    if (s.f.pinned) {
      if (pinnedUsed >= 3) {
        dropped.push({ ...brief(s), why: '固定的记忆最多带 3 条' });
        continue;
      }
      if (chars + lineLen > maxChars) {
        dropped.push({ ...brief(s), why: `超过 ${maxChars} 字预算` });
        continue;
      }
      pinnedUsed++;
      chars += lineLen;
      picked.push({ ...s, f: s.f });
      continue;
    }
    if (picked.length >= topK) {
      dropped.push({ ...brief(s), why: `只取前 ${topK} 条` });
      continue;
    }
    if (chars + lineLen > maxChars) {
      dropped.push({ ...brief(s), why: `超过 ${maxChars} 字预算` });
      continue;
    }
    // 有具体问题时，只挑真的沾边的；一条都不沾就不硬塞（省 token，也更像人想不起来）
    if (qMass > 0 && s.evidence < 0.01) {
      dropped.push({ ...brief(s), why: '和这句话没什么关系' });
      continue;
    }
    chars += lineLen;
    picked.push({ ...s, f: s.f });
  }
  for (const f of history) {
    dropped.push({
      key: f.key,
      subject: f.subject,
      value: f.value,
      score: null,
      evidence: 0,
      why: `这条更新过：旧值「${f.prevValue}」已被「${f.value}」取代`,
    });
  }

  const telemetry = {
    ts: Date.now(),
    convId,
    query,
    mode: 'scored',
    ms: Math.round((performance.now() - t0) * 10) / 10,
    total: alive.length,
    picked: picked.length,
    chars,
    topK,
    maxChars,
    pickedRows: picked.map(brief),
    droppedRows: dropped.slice(0, 12),
  };
  try {
    store.kvSet('recall:last:' + convId, telemetry);
    store.touchFacts(picked.map((p) => p.f.id));
  } catch {
    /* 记账失败不影响回复 */
  }
  return { picked: picked.map((p) => p.f), dropped, telemetry, block: formatBlock(picked.map((p) => p.f)) };
}

function brief(s) {
  return {
    key: s.f.key,
    subject: s.f.subject,
    value: s.f.value,
    score: s.score,
    evidence: Math.round(s.evidence * 100) / 100,
    vitality: Math.round(s.vitality * 100) / 100,
  };
}

function fmtDay(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatBlock(facts) {
  if (!facts || !facts.length) return '';
  return facts
    .map((f) => {
      const who = f.subject === 'owner' || f.subject === 'peer' || !f.subject ? '对方' : f.subject;
      return `- [${fmtDay(f.updatedAt)}] ${who}：${f.key} = ${f.value}`;
    })
    .join('\n');
}

export function lastRecall(convId) {
  return store.kvGet('recall:last:' + convId, null);
}
