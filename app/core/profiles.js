// 准入名单「方案」：把当前白/黑名单存成命名方案，按场景一键切换。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PATHS, loadConfig, setConfig } from './config.js';
import { logger } from './log.js';

const log = logger('profiles');
const FILE = path.join(PATHS.data, 'access-profiles.json');

function load() {
  try {
    if (!existsSync(FILE)) return { profiles: [] };
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!Array.isArray(j.profiles)) j.profiles = [];
    return j;
  } catch {
    return { profiles: [] };
  }
}

function save(z) {
  writeFileSync(FILE, JSON.stringify(z, null, 2) + '\n', 'utf8');
}

function snapshotAccess() {
  const a = loadConfig().access || {};
  return {
    mode: a.mode || 'public',
    ownerQQ: Number(a.ownerQQ) || 0,
    allow: {
      private: [...(a.allow?.private || [])],
      groups: [...(a.allow?.groups || [])],
    },
    deny: {
      private: [...(a.deny?.private || [])],
      groups: [...(a.deny?.groups || [])],
    },
    allowAllWhenEmpty: !!a.allowAllWhenEmpty,
  };
}

function normalizeAccess(a) {
  if (!a || typeof a !== 'object') return null;
  const arr = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n) && n !== 0) : []);
  return {
    mode: a.mode === 'owner' ? 'owner' : 'public',
    ownerQQ: Number(a.ownerQQ) || 0,
    allow: { private: arr(a.allow?.private), groups: arr(a.allow?.groups) },
    deny: { private: arr(a.deny?.private), groups: arr(a.deny?.groups) },
    allowAllWhenEmpty: !!a.allowAllWhenEmpty,
  };
}

export function listProfiles() {
  return load().profiles.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 把「当前生效的准入设置」存成一个命名方案；同名则覆盖 */
export function saveProfile(name, accessOverride) {
  const n = String(name || '').trim();
  if (!n) throw new Error('方案名不能为空');
  if (n.length > 30) throw new Error('方案名太长（≤30 字）');
  const z = load();
  const snap = normalizeAccess(accessOverride) || snapshotAccess();
  const exist = z.profiles.find((p) => p.name === n);
  if (exist) {
    exist.access = snap;
    exist.updatedAt = Date.now();
  } else {
    z.profiles.unshift({
      id: `ap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: n,
      access: snap,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  save(z);
  log.info(`方案已保存：${n}`);
  return z.profiles.find((p) => p.name === n);
}

export function applyProfile(id) {
  const z = load();
  const p = z.profiles.find((x) => x.id === id);
  if (!p) throw new Error('方案不存在');
  setConfig('access', p.access);
  log.info(`已切换到方案：${p.name}`);
  return loadConfig().access;
}

export function deleteProfile(id) {
  const z = load();
  const before = z.profiles.length;
  z.profiles = z.profiles.filter((x) => x.id !== id);
  save(z);
  return before !== z.profiles.length;
}

export function renameProfile(id, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('方案名不能为空');
  const z = load();
  const p = z.profiles.find((x) => x.id === id);
  if (!p) throw new Error('方案不存在');
  if (z.profiles.some((x) => x.id !== id && x.name === n)) throw new Error('已有同名方案');
  p.name = n;
  p.updatedAt = Date.now();
  save(z);
  return p;
}
