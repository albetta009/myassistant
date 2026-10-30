// 主动搭话：每 tick 掷一次本地骰子（0 token），掷中才让她走一轮模型。
// 命中线 = 基础 × 时机因子(刚聊过/冷太久) × 心情因子 + 连续没中的加成（有上限）
import { loadConfig, randomBetween } from './config.js';
import * as store from './store.js';
import * as mood from './mood.js';
import { logger } from './log.js';

const log = logger('wake');
const BASE_TICK_SEC = 15;
let timer = null;
let lastTickAt = 0;
let running = false;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, Number(v) || 0));
}

export function localDay(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cfgOf() {
  return loadConfig();
}

function stateOf(convId) {
  return store.kvGet('wake:' + convId, {}) || {};
}

function saveState(convId, patch) {
  const next = { ...stateOf(convId), ...patch };
  store.kvSet('wake:' + convId, next);
  return next;
}

/** 命中线（百分数）与它的构成，UI 也用它解释「为什么这次开口/没开口」 */
export function hitLineFor(convId, cfg = null) {
  const w = (cfg || cfgOf()).wake || {};
  const st = store.getConvState(convId) || {};
  const lastBot = st.lastBotAt || 0;
  const mins = lastBot ? (Date.now() - lastBot) / 60000 : Infinity;
  let factor = 1;
  let tag = '中间';
  if (mins < Number(w.nearMin ?? 20)) {
    factor = Number(w.nearFactor ?? 0.15);
    tag = `刚聊过 ${Math.round(mins)} 分钟`;
  } else if (mins > Number(w.farMin ?? 360)) {
    factor = Number(w.farFactor ?? 1.5);
    tag = `冷太久 ${Math.round(mins / 60)} 小时`;
  }
  const miss = Number(stateOf(convId).missStreak || 0);
  const bonus = Math.min(Number(w.missCap ?? 30), miss * Number(w.missBonus ?? 8));
  const moodFactor = mood.wakeFactor(convId);
  const base = Number(w.baseHit ?? 18) * factor * moodFactor;
  const hit = clamp(base + bonus, 0, 100);
  return {
    hit: Math.round(hit * 10) / 10,
    base: Math.round(Number(w.baseHit ?? 18) * 10) / 10,
    factor,
    tag,
    miss,
    bonus,
    moodFactor,
    minutesSinceBot: Number.isFinite(mins) ? Math.round(mins) : null,
  };
}

/** 允许的会话：配置了 targets 就只认它们；否则默认只认主人私聊 */
export function targets(cfg = null) {
  const c = cfg || cfgOf();
  const w = c.wake || {};
  const list = store.listConvs();
  const since = Date.now() - (Number(w.activeDays) || 7) * 86400000;
  const recent = list.filter((x) => Number(x.lastTs) >= since);
  const explicit = Array.isArray(w.targets) ? w.targets.filter(Boolean) : [];
  let out = explicit.length ? recent.filter((x) => explicit.includes(x.convId)) : [];
  if (!out.length && !explicit.length) {
    const owner = c.access && c.access.ownerQQ ? `private:${c.access.ownerQQ}` : '';
    if (owner) out = recent.filter((x) => x.convId === owner);
  }
  // 控制台会话发不出 QQ 消息，永远不当目标
  out = out.filter((x) => !String(x.convId).startsWith('console:'));
  if (!w.allowGroups) out = out.filter((x) => !String(x.convId).startsWith('group:'));
  return out;
}

function inQuiet(cfg) {
  const q = cfg.behavior?.quietHours;
  if (!q || !q.enabled) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const parse = (s, fallback) => {
    const [h, m] = String(s || fallback).split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const s = parse(q.start, '01:30');
  const e = parse(q.end, '09:00');
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** 现在该不该轮到这个会话：返回 null 表示可以掷骰 */
export function skipReason(convId, cfg, now = Date.now()) {
  const w = cfg.wake || {};
  const st = store.getConvState(convId) || {};
  if (inQuiet(cfg) && w.useQuietHours !== false) return '安静时段';
  if (st.sleepingUntil && st.sleepingUntil > now) return '主动过一轮，还在歇';
  const s = stateOf(convId);
  const lastAt = Number(s.lastAt || 0);
  const cooldown = Number(w.cooldownMin ?? 30) * 60000;
  if (lastAt && now - lastAt < cooldown) return '冷却中';
  if (s.day !== localDay(now)) {
    // 跨天：额度重置（不写库，掷骰时再落）
  } else if (Number(s.count || 0) >= Number(w.dailyCap ?? 3)) {
    return '今日主动额度用完了';
  }
  const lastBot = st.lastBotAt || 0;
  if (lastBot && now - lastBot < Number(w.minGapMin ?? 20) * 60000) return '刚说过话';
  return null;
}

function afterFire(convId, cfg, { dry }) {
  const w = cfg.wake || {};
  const s = stateOf(convId);
  const today = localDay();
  const count = (s.day === today ? Number(s.count || 0) : 0) + 1;
  const sleepMs = randomBetween([Number(w.sleepMinMin ?? 30) * 60000, Number(w.sleepMaxMin ?? 120) * 60000]);
  saveState(convId, { lastAt: Date.now(), missStreak: 0, day: today, count, dry });
  store.setConvState(convId, { sleepingUntil: Date.now() + sleepMs });
  return { count, sleepingUntil: Date.now() + sleepMs };
}

async function fire({ agent, bus, convId, cfg, hit, roll, dry, kind = 'tick' }) {
  const motive = String(cfg.wake?.motive || '好久没人跟我说话了，我该主动去打个招呼');
  if (dry) {
    afterFire(convId, cfg, { dry: true });
    store.insertWakeLog({
      convId,
      roll,
      hit,
      fired: true,
      dry: true,
      kind,
      detail: `试运行：掷出 ${roll.toFixed(1)} < 命中线 ${hit.toFixed(1)}，本来会开口`,
    });
    bus?.emit('wake', { convId, dry: true, hit, roll });
    log.info(`[试运行] ${convId} 掷出 ${roll.toFixed(1)} 命中 ${hit.toFixed(1)} → 本该开口`);
    return { dry: true };
  }
  try {
    const r = await agent.proactive(convId, motive);
    afterFire(convId, cfg, { dry: false });
    store.insertWakeLog({
      convId,
      roll,
      hit,
      fired: true,
      dry: false,
      kind,
      detail: r?.silent ? '掷中并唤醒了她，她选择不说' : '掷中并真的开口了',
    });
    bus?.emit('wake', { convId, dry: false, hit, roll, silent: !!r?.silent });
    log.info(`${convId} 掷出 ${roll.toFixed(1)} 命中 ${hit.toFixed(1)} → ${r?.silent ? '她选择不说' : '开口了'}`);
    return r;
  } catch (err) {
    store.insertWakeLog({ convId, roll, hit, fired: false, dry: false, kind, detail: '唤醒失败：' + err.message });
    log.warn('主动开口失败 ' + convId + ': ' + err.message);
    return { error: err.message };
  }
}

export async function tickOnce({ agent, bus, force = false } = {}) {
  const cfg = cfgOf();
  const w = cfg.wake || {};
  if (!w.enabled && !force) return [];
  const list = targets(cfg);
  const out = [];
  for (const c of list) {
    const convId = c.convId;
    if (!force) {
      const why = skipReason(convId, cfg);
      if (why) {
        out.push({ convId, skipped: why });
        continue;
      }
    }
    const line = hitLineFor(convId, cfg);
    const roll = Math.round(Math.random() * 1000) / 10;
    if (roll < line.hit) {
      const r = await fire({ agent, bus, convId, cfg, hit: line.hit, roll, dry: !!w.dryRun });
      out.push({ convId, fired: true, ...r });
    } else {
      const s = stateOf(convId);
      const day = localDay();
      saveState(convId, { missStreak: Number(s.missStreak || 0) + 1, day: s.day === day ? s.day : day, count: s.day === day ? Number(s.count || 0) : 0 });
      store.insertWakeLog({
        convId,
        roll,
        hit: line.hit,
        fired: false,
        dry: true,
        kind: 'tick',
        detail: `没中：掷出 ${roll.toFixed(1)}，命中线 ${line.hit}（${line.base} × ${line.factor} × 心情${line.moodFactor} + 连续没中 ${line.bonus}）`,
      });
      out.push({ convId, fired: false, roll, hit: line.hit });
    }
  }
  return out;
}

export function startWake({ agent, bus }) {
  if (timer) return;
  timer = setInterval(() => {
    const cfg = cfgOf();
    const tickSec = Math.max(BASE_TICK_SEC, Number(cfg.wake?.tickSec) || 60);
    if (Date.now() - lastTickAt < tickSec * 1000) return;
    lastTickAt = Date.now();
    if (running) return;
    running = true;
    tickOnce({ agent, bus })
      .catch((err) => log.warn('tick 失败: ' + err.message))
      .finally(() => {
        running = false;
      });
  }, BASE_TICK_SEC * 1000);
  timer.unref?.();
  log.info('主动搭话调度器已启动（默认关，去「调参 → 主动搭话」里打开）');
}

export function stopWake() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function status() {
  const cfg = cfgOf();
  const w = cfg.wake || {};
  const list = targets(cfg).map((c) => {
    const s = stateOf(c.convId);
    const st = store.getConvState(c.convId) || {};
    return {
      convId: c.convId,
      lastAt: s.lastAt || null,
      missStreak: Number(s.missStreak || 0),
      count: s.day === localDay() ? Number(s.count || 0) : 0,
      sleepingUntil: st.sleepingUntil || null,
      hit: hitLineFor(c.convId, cfg),
      skip: skipReason(c.convId, cfg),
    };
  });
  return {
    enabled: !!w.enabled,
    dryRun: w.dryRun !== false,
    tickSec: Number(w.tickSec) || 60,
    dailyCap: Number(w.dailyCap ?? 3),
    configured: Array.isArray(w.targets) ? w.targets : [],
    log: store.recentWakeLog(40),
    targets: list,
    allConvs: store.listConvs().filter((c) => !String(c.convId).startsWith('console:')).slice(0, 30).map((c) => c.convId),
  };
}

/** 手动：演练一次（掷骰 + 记账，不花模型、不真发） */
export function drySpin(convId) {
  const cfg = cfgOf();
  const line = hitLineFor(convId, cfg);
  const roll = Math.round(Math.random() * 1000) / 10;
  const hit = roll < line.hit;
  store.insertWakeLog({
    convId,
    roll,
    hit: line.hit,
    fired: hit,
    dry: true,
    kind: 'manual',
    detail: `手动演练：掷出 ${roll.toFixed(1)}，命中线 ${line.hit}（${line.base} × ${line.factor} × 心情${line.moodFactor} + 加成 ${line.bonus}）→ ${hit ? '会开口' : '不开口'}`,
  });
  if (hit) afterFire(convId, cfg, { dry: true });
  return { roll, hit: line.hit, fired: hit, line };
}

/** 手动：真发一次（跳过等待，仍然遵守试运行开关） */
export async function sendNow({ agent, bus, convId }) {
  const cfg = cfgOf();
  const line = hitLineFor(convId, cfg);
  const roll = Math.round(Math.random() * 1000) / 10;
  const dry = cfg.wake?.dryRun !== false;
  return fire({ agent, bus, convId, cfg, hit: line.hit, roll, dry, kind: 'manual' });
}
