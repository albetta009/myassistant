// 情绪引擎：每轮本地判涨跌（不花钱），抽样请模型复核；半衰期向基线回落；
// 置信度低只记账不进嘴；同一次变化只播报一次。
import { loadConfig, resolveProvider, pickModel } from './config.js';
import { complete } from './llm.js';
import * as store from './store.js';
import { logger } from './log.js';

const log = logger('mood');

export const EMOTIONS = ['开心', '甜蜜', '委屈', '心疼'];

const PRAISE = /(喜欢你|爱你|想你|抱抱|亲亲|宝宝|乖|可爱|好看|漂亮|厉害|真棒|辛苦|谢谢|晚安|早安|想我)/;
const NEG = /(滚|烦人|闭嘴|讨厌|生气了|不理你|别烦|丑|蠢|傻|笨蛋|无语)/;
const SAD = /(难过|哭了|想哭|加班|好累|累死|困死|生病|发烧|头疼|疼|压力|失眠|吵架|分手)/;
const FUN = /(哈哈|笑死|好耶|开心|太好了|牛啊|草|乐死)/;
const CONSENT = /(你心情|你的心情|心情怎么样|开心吗|难过吗|你还生气|你还好吗)/;

const MOOD_WINDOW_MS = 6 * 3600 * 1000;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(v) || 0));
}

function round1(v) {
  return Math.round(Number(v) * 10) / 10;
}

export function moodLabel(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return '平静';
  if (s >= 82) return '很好';
  if (s >= 66) return '不错';
  if (s >= 50) return '一般';
  if (s >= 34) return '有点低落';
  return '难过';
}

function config() {
  const cfg = loadConfig();
  return cfg.mood || {};
}

function emptyMoods() {
  const o = {};
  for (const e of EMOTIONS) o[e] = 0;
  return o;
}

/** 半衰期回落：心情向基线、情绪向 0 衰减（读时现算，不写库也能算对） */
function decayed(st, cfg, now = Date.now()) {
  const base = Number(cfg.baseline ?? 68);
  const score = st?.moodScore == null ? base : Number(st.moodScore);
  const at = st?.moodUpdated || now;
  const mins = Math.max(0, (now - at) / 60000);
  const k = Math.pow(0.5, mins / Math.max(1, Number(cfg.halfLifeMin) || 180));
  const ke = Math.pow(0.5, mins / Math.max(1, Number(cfg.emotionHalfLifeMin) || 90));
  const moods = { ...emptyMoods(), ...(st?.moods || {}) };
  for (const e of EMOTIONS) moods[e] = Number(moods[e] || 0) * ke;
  return { score: base + (score - base) * k, moods, minutesAway: mins };
}

/* ---------------- 本地启发式 ---------------- */

function heuristic(userText, botText) {
  const u = String(userText || '');
  const out = { delta: 0, moods: emptyMoods(), reason: '', cue: false };
  if (PRAISE.test(u)) {
    out.delta += 4;
    out.moods['开心'] += 3;
    out.moods['甜蜜'] += 5;
    out.reason = '他夸我了，心里甜甜的';
    out.cue = true;
  }
  if (FUN.test(u)) {
    out.delta += 2;
    out.moods['开心'] += 4;
    if (!out.reason) out.reason = '跟他聊得挺开心';
  }
  if (SAD.test(u)) {
    out.delta -= 3;
    out.moods['心疼'] += 6;
    out.reason = '他好像不太好，我有点心疼';
    out.cue = true;
  }
  if (NEG.test(u)) {
    out.delta -= 5;
    out.moods['委屈'] += 6;
    out.reason = '他刚才那话说得我有点委屈';
    out.cue = true;
  }
  if (CONSENT.test(u)) {
    out.cue = true;
    if (!out.reason) out.reason = '他在问我现在心情怎么样';
  }
  // 「她」自己的回复也会带情绪：撒娇/软话往上走一点点
  if (/[呜嗯哼]/.test(String(botText || '')) && out.delta === 0 && Math.random() < 0.15) {
    out.delta += 1;
    out.moods['甜蜜'] += 1;
  }
  out.delta = clamp(out.delta, -9, 9);
  for (const e of EMOTIONS) out.moods[e] = clamp(out.moods[e], -12, 12);
  return out;
}

/* ---------------- 模型复核 ---------------- */

const JUDGE_SYSTEM = `你在判断 QQ 聊天里「她」这一轮之后的心情变化。她是真人，不是客服。
只输出 JSON，不要解释、不要代码块：
{"delta": 数字, "moods": {"开心": 数字, "甜蜜": 数字, "委屈": 数字, "心疼": 数字}, "reason": "不超过20字的第一人称", "confidence": 0到100}

规则：
- 变化要小：日常闲聊 delta 在 -3~+3；明显被夸、被凶、被撒娇才到 ±8。
- 心情下降只能因为她心疼、委屈、担心，不许因为「对方惹她生气」。
- reason 用第一人称、口语，像心里嘀咕一句，不要写成分析。
- 拿不准就把 confidence 写低（30 以下）。`;

async function judgeWithModel({ convId, userText, botText, before, cfg, partnerName }) {
  const c = loadConfig();
  const provider = resolveProvider(c.llm.defaultProvider);
  const model = String(cfg.model || '').trim() || pickModel() || provider.model;
  const prompt =
    `对方（${partnerName || '他'}）说：${String(userText || '').slice(0, 400)}\n` +
    `她回：${String(botText || '').slice(0, 400)}\n` +
    `她此刻的心情值：${Math.round(before.score)}/100（基线 ${cfg.baseline}），情绪：` +
    EMOTIONS.map((e) => `${e}${Math.round(before.moods[e] || 0)}`).join(' ');

  const out = await Promise.race([
    complete({
      provider,
      model,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      maxTokens: 700,
      allowReasoningFallback: true,
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('心情判断超时')), 25000)),
  ]);

  const s = String(out || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('心情判断不是 JSON：' + s.slice(0, 120));
  const j = JSON.parse(s.slice(a, b + 1));
  const moods = emptyMoods();
  for (const e of EMOTIONS) moods[e] = clamp(j.moods?.[e] ?? 0, -12, 12);
  return {
    delta: clamp(j.delta ?? 0, -12, 12),
    moods,
    reason: String(j.reason || '').slice(0, 30),
    confidence: clamp(j.confidence ?? 50, 0, 100),
  };
}

/* ---------------- 对外 ---------------- */

export function snapshot(convId) {
  const cfg = config();
  const st = store.getConvState(convId);
  const base = Number(cfg.baseline ?? 68);
  const has = st && st.moodScore != null;
  const d = decayed(has ? st : null, cfg);
  const score = has ? d.score : base;
  return {
    convId,
    score: round1(score),
    label: moodLabel(score),
    moods: Object.fromEntries(EMOTIONS.map((e) => [e, round1(d.moods[e] || 0)])),
    reason: st?.moodReason || '',
    confidence: st?.moodConf ?? null,
    updatedAt: st?.moodUpdated || null,
    note: st?.moodNote || '',
    enabled: !!cfg.enabled,
    baseline: base,
    floor: Number(cfg.floor ?? 15),
  };
}

/** 生成提示词里那一段（会消费掉「待播报」的那句，同一次变化只说一次） */
export function promptBlock(convId) {
  const cfg = config();
  if (!cfg.enabled || cfg.inject === 'off') return '';
  const st = store.getConvState(convId);
  if (!st || st.moodScore == null) return '';
  const s = snapshot(convId);
  const parts = [
    `- 你此刻的心情：${s.label}（${s.score.toFixed(0)}/100）` +
      EMOTIONS.filter((e) => Math.abs(s.moods[e] || 0) >= 8)
        .map((e) => `｜${e} ${Math.round(s.moods[e])}`)
        .join(''),
  ];
  if (cfg.inject === 'event') {
    const note = takeNote(convId);
    if (note) parts.push(`- 刚才心里那一下：${note}`);
  }
  if (st.mood) parts.push(`- 今天的心情词：${st.mood}`);
  parts.push('- 心情只影响你说话的语气，不要主动汇报数值、不要说"我现在的情绪是"。');
  return '\n# 你现在的心情\n' + parts.join('\n');
}

/** 取走待播报的那句话（取一次就清掉） */
export function takeNote(convId) {
  const st = store.getConvState(convId);
  if (!st || !st.moodNote) return '';
  if (st.moodUpdated && Date.now() - st.moodUpdated > MOOD_WINDOW_MS) {
    store.setConvState(convId, { moodNote: '' });
    return '';
  }
  const note = st.moodNote;
  store.setConvState(convId, { moodNote: '', moodNoteAt: Date.now() });
  return note;
}

/** 一轮对话之后调用：本地判 → 抽样复核 → 落库 + 记账 */
export async function afterTurn({ convId, userText = '', botText = '', partnerName = '' }) {
  const cfg = config();
  if (!cfg.enabled) return { skipped: 'disabled' };
  const st = store.getConvState(convId);
  const before = decayed(st, cfg);
  const h = heuristic(userText, botText);
  const turns = (Number(store.kvGet('mood:turns:' + convId, 0)) || 0) + 1;
  let model = null;
  let need = cfg.judgeOnCue !== false ? h.cue : false;
  if (!need && Number(cfg.judgeEvery) > 0 && turns % Number(cfg.judgeEvery) === 0) need = true;

  if (need) {
    try {
      model = await judgeWithModel({ convId, userText, botText, before, cfg, partnerName });
    } catch (err) {
      log.warn('心情复核没跑成，只用本地判断: ' + err.message);
    }
  }

  const gate = Number(cfg.confidenceGate ?? 55);
  const conf = model ? model.confidence : 60;
  let delta = h.delta + (model ? model.delta : 0);
  if (model && conf < gate) delta = delta * 0.5; // 没底：只轻轻动，且不播报
  // 本地判断和模型判断会叠加，收在一次最多 ±8，跟设计里「明显被夸被凶才到 8」对齐
  delta = clamp(delta, -8, 8);

  const moods = { ...before.moods };
  for (const e of EMOTIONS) moods[e] = clamp((moods[e] || 0) + h.moods[e] + (model ? model.moods[e] : 0), 0, 100);

  // 规矩：心情下降只能因为心疼/委屈。反过来，心里在疼的时候整体心情不该往上走
  if ((moods['心疼'] || 0) >= 8 || (moods['委屈'] || 0) >= 8) delta = Math.min(delta, -1);
  delta = clamp(delta, -8, 8);

  const score = clamp(before.score + delta, Number(cfg.floor ?? 15), 100);
  const reason = (model?.reason || h.reason || '').slice(0, Number(cfg.maxNoteChars) || 60);
  const speakable = model ? conf >= gate : true;
  const note = speakable && Math.abs(delta) >= 2 ? reason : '';

  store.setConvState(convId, {
    moodScore: round1(score),
    moods,
    moodReason: reason,
    moodConf: conf,
    moodUpdated: Date.now(),
    moodNote: note || '',
  });
  store.kvSet('mood:turns:' + convId, need ? 0 : turns);
  store.insertMoodLog({
    convId,
    delta: round1(delta),
    score: round1(score),
    moods,
    reason,
    confidence: conf,
    source: model ? 'model' : 'heuristic',
  });
  if (Math.abs(delta) >= 2) log.info(`心情 ${convId}: ${delta > 0 ? '+' : ''}${delta.toFixed(1)} → ${score.toFixed(0)}（${reason || '—'}）`);
  return { delta: round1(delta), score: round1(score), reason, confidence: conf, note };
}

export function reset(convId) {
  const cfg = config();
  store.setConvState(convId, {
    moodScore: Number(cfg.baseline ?? 68),
    moods: emptyMoods(),
    moodReason: '',
    moodConf: null,
    moodUpdated: Date.now(),
    moodNote: '',
  });
  store.insertMoodLog({ convId, delta: 0, score: Number(cfg.baseline ?? 68), moods: emptyMoods(), reason: '重置到基线', confidence: 100, source: 'reset' });
  return snapshot(convId);
}

/** 心情对「主动开口」的乘数：0.6~1.2 */
export function wakeFactor(convId) {
  const cfg = config();
  if (!cfg.influenceWake) return 1;
  const s = snapshot(convId);
  const t = clamp((s.score - 30) / 60, 0, 1); // 30 分以下最不想说话
  return round1(0.6 + t * 0.6);
}
