// 入口：装配 config / store / onebot / agent / http。
import { EventEmitter } from 'node:events';
import { loadConfig, PATHS } from './config.js';
import { initStore, closeStore } from './store.js';
import { OneBot } from './onebot.js';
import { Agent } from './agent.js';
import { createServer } from './server.js';
import { startWake } from './wake.js';
import { logger } from './log.js';

const log = logger('main');
const STARTED_AT = Date.now();

const cfg = loadConfig();
initStore();

const bus = new EventEmitter();
bus.setMaxListeners(50);

const onebot = new OneBot(cfg.onebot);
const agent = new Agent({ onebot, bus });

onebot.on('event', (ev) => {
  agent.onEvent(ev).catch((err) => log.error('onEvent 异常', err.message));
});

const server = createServer({ agent, onebot, bus, startedAt: STARTED_AT });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`端口 ${cfg.server.port} 已被占用——可能已经有一个实例在跑`);
    process.exit(2);
  }
  log.error('HTTP 服务错误', err.message);
});

server.listen(cfg.server.port, cfg.server.host, () => {
  log.info(`控制台: http://${cfg.server.host}:${cfg.server.port}`);
  log.info(`数据目录: ${PATHS.data}`);
  onebot.start();
  startWake({ agent, bus });
});

let closing = false;
function shutdown(sig) {
  if (closing) return;
  closing = true;
  log.info(`收到 ${sig}，正在退出…`);
  try {
    onebot.stop();
    server.close();
    closeStore();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => log.error('uncaughtException', err.stack || err.message));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', err?.stack || String(err)));

log.info(`${cfg.app.name} v${cfg.app.version} 启动，OneBot=${cfg.onebot.wsUrl}，人格=${cfg.persona.active || '（无）'}`);
