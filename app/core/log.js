// 极简日志：控制台 + 按天滚动文件。零依赖。
import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';

const MAX_BYTES = 8 * 1024 * 1024;
if (!existsSync(PATHS.logs)) mkdirSync(PATHS.logs, { recursive: true });

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fileFor(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return path.join(PATHS.logs, `core-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

function write(level, scope, args) {
  const line = `${stamp()} [${level}] [${scope}] ${args
    .map((a) => (typeof a === 'string' ? a : safeJson(a)))
    .join(' ')}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  try {
    const f = fileFor();
    if (existsSync(f) && statSync(f).size > MAX_BYTES) renameSync(f, f + '.1');
    appendFileSync(f, line + '\n', 'utf8');
  } catch {
    /* 日志失败绝不能拖垮主流程 */
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function logger(scope) {
  return {
    info: (...a) => write('INFO', scope, a),
    warn: (...a) => write('WARN', scope, a),
    error: (...a) => write('ERROR', scope, a),
    debug: (...a) => {
      if (process.env.AIWO_DEBUG) write('DEBUG', scope, a);
    },
  };
}

export const log = logger('core');
