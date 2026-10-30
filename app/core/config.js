// 配置层：读取 config.json + secrets.json，深合并默认值，支持运行时保存。
// 零依赖：只用 node:fs / node:path。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PATHS = {
  root: ROOT,
  app: path.join(ROOT, 'app'),
  core: path.join(ROOT, 'app', 'core'),
  ui: path.join(ROOT, 'app', 'ui'),
  configDir: path.join(ROOT, 'app', 'config'),
  configFile: path.join(ROOT, 'app', 'config', 'config.json'),
  secretsFile: path.join(ROOT, 'app', 'config', 'secrets.json'),
  personas: path.join(ROOT, 'app', 'config', 'personas'),
  prompts: path.join(ROOT, 'app', 'config', 'prompts'),
  data: path.join(ROOT, 'app', 'data'),
  db: path.join(ROOT, 'app', 'data', 'memory.db'),
  stickers: path.join(ROOT, 'app', 'data', 'stickers'),
  images: path.join(ROOT, 'app', 'data', 'images'),
  voice: path.join(ROOT, 'app', 'data', 'voice'),
  logs: path.join(ROOT, 'logs'),
};

// 只有这些目录允许被自动创建
for (const p of [PATHS.data, PATHS.stickers, PATHS.images, PATHS.voice, PATHS.logs, PATHS.personas]) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

const DEFAULTS = {
  app: { name: 'AI我', version: '0.1.0' },
  server: { host: '127.0.0.1', port: 3110 },
  onebot: {
    kind: 'napcat',
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',
    reconnectMinMs: 1000,
    reconnectMaxMs: 30000,
  },
  llm: {
    defaultProvider: 'deepseek',
    historyTurns: 24,
    maxTokens: 1024,
    temperature: 1.1,
    providers: {},
    visionModel: 'deepseek-flash',
    proEnabled: false,
    heavyModel: 'deepseek-v4-pro',
    visionMaxImages: 2,
    visionMaxBytes: 3145728,
  },
  persona: { active: '', maxInjectChars: 6000 },
  prompt: { rules: '' },
  theme: { accent: '#6EE7B7', accent2: '#818CF8', bg: '', bgOpacity: 0.18 },
  access: {
    ownerQQ: 0,
    mode: 'owner',
    allow: { private: [], groups: [] },
    deny: { private: [], groups: [] },
    allowAllWhenEmpty: false,
  },
  behavior: {
    readDelayMs: [600, 2200],
    typingMsPerChar: 55,
    typingMaxMs: 6000,
    sendGapMs: [800, 2600],
    maxSendPerMinute: 8,
    maxSendPerHour: 60,
    quietHours: { enabled: false, start: '01:30', end: '09:00' },
    splitMaxChars: 32,
    replyProbability: 0.85,
    imageAttentionSec: 180,
    groupBatchQuietMs: 1500,
    groupBatchMaxWaitMs: 8000,
    groupMinGapMs: 4000,
  },
  memory: {
    enabled: true,
    fts: true,
    diaryHour: 4,
    rollAfter: 40,
    rollKeep: 20,
    // 事实门控：命中这些片段的 value 不当作「关于人的记忆」（多是程序自述/别的人设）
    // 想加就改 config.json 的 memory.junkPatterns，改完 1 秒内生效
    junkPatterns: ['条数限制', '消息会卡', '私聊会卡', '群消息会卡', '上下文上限', '上下文占用', '省token', 'token数', '限流'],
    // 召回：facts 不再全量塞，按「证据 / 鲜活度 / 重要度 / 刚用过」打分取 top-k
    recall: {
      enabled: true,
      topK: 6,
      maxChars: 800,
      halfLifeDays: 30,
      weights: { evidence: 0.5, vitality: 0.26, importance: 0.16, usage: 0.08 },
    },
  },
  // 情绪：每轮本地判 + 抽样请模型复核；半衰期回落；置信度低不进嘴
  mood: {
    enabled: true,
    baseline: 68,
    floor: 15,
    halfLifeMin: 180,
    emotionHalfLifeMin: 90,
    judgeEvery: 5,
    judgeOnCue: true,
    confidenceGate: 55,
    model: '',
    inject: 'event', // event = 只说「刚才心里那一下」；value = 只说数值；off = 不注入
    influenceWake: true,
    maxNoteChars: 60,
  },
  // 主动搭话：本地掷骰，掷中才花模型
  wake: {
    enabled: false,
    dryRun: true,
    tickSec: 60,
    minGapMin: 20,
    maxGapMin: 90,
    baseHit: 18,
    nearMin: 20,
    nearFactor: 0.15,
    farMin: 360,
    farFactor: 1.5,
    missBonus: 8,
    missCap: 30,
    cooldownMin: 30,
    dailyCap: 3,
    activeDays: 7,
    allowGroups: false,
    targets: [],
    motive: '好久没人跟我说话了，我该主动去打个招呼',
    useQuietHours: true,
    sleepMinMin: 30,
    sleepMaxMin: 120,
  },
  tts: {
    provider: 'sapi', // sapi = 本机离线 | breeze = Breeze Blue 在线
    voice: 'Microsoft Huihui Desktop',
    rate: 0,
    maxChars: 200,
    enabled: true,
    autoSendProbability: 0,
    breeze: {
      baseUrl: 'https://api.breeze.blue',
      voiceId: '',
      modelId: 'breeze-tts-2',
      language: 'zh',
      instructions: '',
      speed: 1,
      guidance: 0, // 0 = 不传；1~10 才生效
      outputFormat: 'wav_24000', // wav 便于在结尾补静音，防止 QQ 转 silk 时削掉最后一个字
      padMs: 300, // 结尾补多少毫秒静音
    },
  },
  media: {
    autoStickerProbability: 0.05,
    collectIncoming: true,
    maxStickers: 500,
    maxPerEmotion: 3,
    reviewIncoming: true,
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`无法解析 ${file}: ${err.message}`);
  }
}

let cache = null;
let secretsCache = null;

export function loadConfig({ force = false } = {}) {
  if (cache && !force) return cache;
  const user = readJson(PATHS.configFile, {});
  cache = deepMerge(DEFAULTS, user);
  cache.server.port = Number(cache.server.port) || 3110;
  cache.onebot.wsUrl = String(cache.onebot.wsUrl || '').replace(/\/+$/, '');
  cache.onebot.httpUrl = String(cache.onebot.httpUrl || '').replace(/\/+$/, '');
  return cache;
}

export function secrets() {
  if (!secretsCache) secretsCache = readJson(PATHS.secretsFile, {});
  return secretsCache;
}

/** 写 secrets.json（原子写；值传 null 表示删掉这个 key） */
export function saveSecrets(patch = {}) {
  const cur = readJson(PATHS.secretsFile, {});
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === '') delete cur[k];
    else cur[k] = String(v);
  }
  const tmp = PATHS.secretsFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n', 'utf8');
  renameSync(tmp, PATHS.secretsFile);
  secretsCache = null;
  return cur;
}

/** 把改动写回 config.json（原子写：先写 .tmp 再 rename） */
export function saveConfig(patch) {
  const current = readJson(PATHS.configFile, {});
  const next = deepMerge(current, patch);
  const tmp = PATHS.configFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, PATHS.configFile);
  cache = null;
  return loadConfig({ force: true });
}

/** 单点更新，如 setConfig('server.port', 3111) */
export function setConfig(dotted, value) {
  const parts = dotted.split('.');
  const patch = {};
  let node = patch;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] = {};
  node[parts[parts.length - 1]] = value;
  return saveConfig(patch);
}

/** 解析 provider 的 api key：config 明文 > secrets.json > 环境变量 */
export function resolveProvider(name) {
  const cfg = loadConfig();
  const p = cfg.llm.providers?.[name];
  if (!p) throw new Error(`未配置的模型提供方: ${name}`);
  const sec = secrets();
  const key =
    p.apiKey ||
    (p.apiKeyRef && sec[p.apiKeyRef]) ||
    (p.apiKeyEnv && process.env[p.apiKeyEnv]) ||
    '';
  return {
    name,
    label: p.label || name,
    baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''),
    model: p.defaultModel || p.models?.[0] || '',
    models: p.models || [],
    apiKey: key,
    noAuth: !!p.noAuth,
    contextWindow: p.contextWindow || 128000,
    headers: p.headers || {},
  };
}

/** 主流 OpenAI 兼容服务商预设：模型名以各家控制台为准，界面上都可以改 */
export const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-flash', 'deepseek-v4-pro', 'deepseek-reasoner'],
    model: 'deepseek-chat',
    contextWindow: 128000,
    vision: 'deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '便宜、中文好；reasoner 是推理模型，回复会慢一些',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    vision: 'Qwen/Qwen2-VL-7B-Instruct',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'Qwen/Qwen2.5-7B-Instruct'],
    model: 'Qwen/Qwen2.5-7B-Instruct',
    contextWindow: 32768,
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '国内聚合站，注册送额度；模型名要带厂商前缀',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    vision: 'qwen-vl-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long'],
    model: 'qwen-plus',
    contextWindow: 131072,
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    note: '走 compatible-mode 这个地址；qwen-turbo 最便宜',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    vision: 'glm-4v-flash',
    models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
    model: 'glm-4-flash',
    contextWindow: 128000,
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    note: 'glm-4-flash 有免费额度',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    vision: 'moonshot-v1-8k-vision-preview',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'],
    model: 'moonshot-v1-8k',
    contextWindow: 8192,
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '长文强；8k 那档便宜，但会挤上下文',
  },
  {
    id: 'volcengine',
    label: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    vision: 'doubao-1.5-vision-pro-32k',
    models: ['doubao-pro-32k', 'doubao-pro-128k', 'doubao-lite-32k'],
    model: 'doubao-pro-32k',
    contextWindow: 32768,
    keyUrl: 'https://console.volcengine.com/ark',
    note: '火山要先在控制台创建「推理接入点」，模型名填接入点 ID（ep-xxx）也行',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    vision: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    model: 'gpt-4o-mini',
    contextWindow: 128000,
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '国内需要能访问的网络环境',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter（聚合）',
    baseUrl: 'https://openrouter.ai/api/v1',
    vision: 'openai/gpt-4o-mini',
    models: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'],
    model: 'deepseek/deepseek-chat',
    contextWindow: 128000,
    keyUrl: 'https://openrouter.ai/keys',
    note: '一个 key 用多家模型；模型名是 vendor/model',
  },
  {
    id: 'ollama',
    label: '本地 Ollama（不用 Key）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    vision: 'qwen2.5vl:7b',
    models: ['qwen2.5:7b', 'llama3.1:8b', 'deepseek-r1:7b'],
    model: 'qwen2.5:7b',
    contextWindow: 32768,
    noAuth: true,
    keyUrl: '',
    note: '先在本机 ollama pull 过模型；显卡不够 7B 会很慢',
  },
  {
    id: 'lmstudio',
    label: '本地 LM Studio（不用 Key）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    vision: 'local-model',
    models: ['local-model'],
    model: 'local-model',
    contextWindow: 32768,
    noAuth: true,
    keyUrl: '',
    note: '在 LM Studio 里开启 Local Server，模型名填它显示的标识',
  },
  {
    id: 'custom',
    label: '自定义（任意 OpenAI 兼容）',
    baseUrl: '',
    models: [],
    model: '',
    contextWindow: 32768,
    keyUrl: '',
    note: '中转站/自建网关都填这里；地址写到 /v1 为止',
  },
];

export function providerPreset(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || null;
}

export function randomBetween([min, max]) {
  const a = Number(min) || 0;
  const b = Number(max) || a;
  return a + Math.random() * Math.max(0, b - a);
}

// 配置热重载：用编辑器改 config.json 后 1 秒内自动生效，不用重启核心。
import { watchFile } from 'node:fs';
watchFile(PATHS.configFile, { interval: 1000 }, () => {
  cache = null;
});

/** 重活用哪个模型：开了 pro 就用 heavyModel，否则用默认 */
export function pickModel() {
  const cfg = loadConfig();
  return cfg.llm.proEnabled ? cfg.llm.heavyModel || cfg.llm.defaultModel || '' : '';
}
