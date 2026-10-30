// 人格卡：app/config/personas/*.md 一个角色一个文件（文件名=角色名）。
// 兼容旧 qq-bridge 的 roles/*.md 格式（纯 markdown，可选 〔二代〕 小节标记）。
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { PATHS, loadConfig, setConfig } from './config.js';
import { logger } from './log.js';
const log = logger('persona');

const RESERVED = new Set(['con', 'nul', 'aux', 'prn', 'com1', 'com2', 'com3', 'lpt1', 'lpt2']);

export function listPersonas() {
  if (!existsSync(PATHS.personas)) return [];
  const cfg = loadConfig();
  const max = Number(cfg.persona.maxInjectChars) || 6000;
  return readdirSync(PATHS.personas)
    .filter((f) => /\.md$/i.test(f) && !f.startsWith('_'))
    .map((f) => {
      const name = f.replace(/\.md$/i, '');
      const file = path.join(PATHS.personas, f);
      const text = readFileSync(file, 'utf8');
      return {
        name,
        chars: text.length,
        overLimit: text.length > max,
        title: (text.match(/^#\s*(?:角色卡[:：]\s*)?(.+)$/m) || [, name])[1].trim(),
        updatedAt: statMtime(file),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function statMtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function safeName(name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('角色名不能为空');
  if (n.length > 40) throw new Error('角色名太长（≤40 字）');
  if (/[\\/:*?"<>|\r\n]/.test(n)) throw new Error('角色名不能包含 \\ / : * ? " < > |');
  if (RESERVED.has(n.toLowerCase())) throw new Error('角色名与 Windows 保留名冲突');
  return n;
}

export function readPersona(name) {
  const n = safeName(name);
  const file = path.join(PATHS.personas, n + '.md');
  if (!existsSync(file)) throw new Error(`人格卡不存在: ${n}`);
  return { name: n, text: readFileSync(file, 'utf8') };
}

export function writePersona(name, text) {
  const n = safeName(name);
  const file = path.join(PATHS.personas, n + '.md');
  const tmp = file + '.tmp';
  writeFileSync(tmp, String(text ?? ''), 'utf8');
  renameSync(tmp, file);
  log.info(`人格卡已保存: ${n} (${String(text ?? '').length} 字)`);
  return readPersona(n);
}

export function deletePersona(name) {
  const n = safeName(name);
  const file = path.join(PATHS.personas, n + '.md');
  if (!existsSync(file)) throw new Error(`人格卡不存在: ${n}`);
  unlinkSync(file);
  if (loadConfig().persona.active === n) setConfig('persona.active', '');
}

export function renamePersona(from, to) {
  const a = safeName(from);
  const b = safeName(to);
  const src = path.join(PATHS.personas, a + '.md');
  const dst = path.join(PATHS.personas, b + '.md');
  if (!existsSync(src)) throw new Error(`人格卡不存在: ${a}`);
  if (existsSync(dst)) throw new Error(`已存在同名人格卡: ${b}`);
  renameSync(src, dst);
  if (loadConfig().persona.active === a) setConfig('persona.active', b);
}

export function activePersonaName() {
  const cfg = loadConfig();
  const name = cfg.persona.active || '';
  if (!name) return '';
  const file = path.join(PATHS.personas, name + '.md');
  return existsSync(file) ? name : '';
}

/** 拿到当前人格的注入文本（截断到上限） */
export function activePersonaText() {
  const name = activePersonaName();
  if (!name) return { name: '', text: '' };
  const { text } = readPersona(name);
  const max = Number(loadConfig().persona.maxInjectChars) || 6000;
  return { name, text: text.length > max ? text.slice(0, max) + '\n…（已截断）' : text };
}

export function setActivePersona(name) {
  if (name) safeName(name);
  setConfig('persona.active', name || '');
  log.info(`当前人格: ${name || '（无）'}`);
  return activePersonaText();
}

/** 从旧 qq-bridge roles 目录批量导入（只读旧目录，不改它） */
export function importLegacyRoles(legacyDir) {
  const imported = [];
  if (!existsSync(legacyDir)) throw new Error(`目录不存在: ${legacyDir}`);
  for (const f of readdirSync(legacyDir)) {
    if (!/\.md$/i.test(f) || f.toLowerCase() === 'readme.md') continue;
    const name = f.replace(/\.md$/i, '');
    const dst = path.join(PATHS.personas, name + '.md');
    if (existsSync(dst)) continue;
    writeFileSync(dst, readFileSync(path.join(legacyDir, f), 'utf8'), 'utf8');
    imported.push(name);
  }
  log.info(`导入 ${imported.length} 张人格卡`);
  return imported;
}
