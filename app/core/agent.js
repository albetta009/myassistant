// 对话引擎：接入控制 / 提示词装配 / 流式回复 / 分条发送 / 拟真延迟。
import { loadConfig, resolveProvider, randomBetween, PATHS } from './config.js';
import * as mood from './mood.js';
import * as recall from './recall.js';
import { streamChat, estimateTokens, complete } from './llm.js';
import { activePersonaText } from './persona.js';
import * as store from './store.js';
import { parseConv, normalizeMessage, convOf } from './onebot.js';
import { logger } from './log.js';
import { scheduleDiary, maybeRollSummary, getRollSummary } from './memory.js';
import * as media from './media.js';
const log = logger('agent');

// 黑话库：按文件 mtime 缓存，改完立刻生效
let _slangCache = { mtime: 0, items: [] };
function slangTop(n = 14) {
  try {
    const file = path.join(PATHS.data, 'slang.json');
    const st = fsMod.statSync(file);
    if (st.mtimeMs !== _slangCache.mtime) {
      const arr = JSON.parse(fsMod.readFileSync(file, 'utf8'));
      _slangCache = {
        mtime: st.mtimeMs,
        items: (Array.isArray(arr) ? arr : []).filter((x) => x && x.content),
      };
    }
    return _slangCache.items.slice(0, n);
  } catch {
    return [];
  }
}
const path = await import('node:path');

const SILENT = /^\s*(\[SILENT\]|\[沉默\]|（沉默）|\(silent\))\s*$/i;

/* ---------------- 准入 ---------------- */

export function isAllowed(convId, senderId) {
  const { access } = loadConfig();
  const { kind, id } = parseConv(convId);
  if (String(access.mode) === 'owner') {
    return !!access.ownerQQ && String(senderId) === String(access.ownerQQ);
  }
  const deny = access.deny?.[kind === 'group' ? 'groups' : 'private'] || [];
  if (deny.map(String).includes(String(id))) return false;
  const allow = access.allow?.[kind === 'group' ? 'groups' : 'private'] || [];
  if (!allow.length) return !!access.allowAllWhenEmpty;
  return allow.map(String).includes(String(id));
}

export function isOwner(senderId) {
  const { access } = loadConfig();
  return !!access.ownerQQ && String(senderId) === String(access.ownerQQ);
}

/* ---------------- 提示词 ---------------- */

function hhmm(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function weekday(ts = Date.now()) {
  return '星期' + '日一二三四五六'[new Date(ts).getDay()];
}

export function buildSystemPrompt({ convId, partnerName, factsText = '' }) {
  const cfg = loadConfig();
  const persona = activePersonaText();
  const { kind } = parseConv(convId);
  const st = store.getConvState(convId);
  const parts = [];

  parts.push(
    `现在是 ${new Date().toLocaleString('zh-CN', { hour12: false })}（${weekday()}），你在 QQ 上跟「${partnerName || '对方'}」聊天。`
  );
  if (persona.text) parts.push(`\n# 你的人设\n${persona.text}`);

  const affinity = st?.affinity ?? 0;
  parts.push(
    `\n# 当前状态\n- 关系亲密度：${affinity.toFixed(0)}/100（0=刚认识，100=最亲密）` +
      `\n- 会话类型：${kind === 'group' ? '群聊' : '私聊'}`
  );

  // 心情：带数值和「刚才心里那一下」，同一次变化只说一次（promptBlock 内部会消费掉）
  try {
    const moodBlock = mood.promptBlock(convId);
    if (moodBlock) parts.push(moodBlock);
  } catch {
    /* 心情出错不影响回复 */
  }

  if (factsText) parts.push(`\n# 你记得的事（长期记忆，别生硬复述）\n${factsText}`);
  parts.push(
    '\n# 记忆的边界\n记忆是跨会话的：你在别的群、别的私聊里知道的事也会被想起来。' +
      '但别主动把别人的私事拿到这个会话里说，也别把听来的八卦当谈资；被问到时可以说"你之前跟我说过"。'
  );

  const diary = diaryText(convId);
  if (diary) {
    parts.push('\n# 你记得的这几天（你写的日记，别照念，自然带出来）\n' + diary);
  }

  const slang = slangTop();
  if (slang.length) {
    parts.push(
      '\n# 黑话（你们之间常用的说法，看懂就用，别硬塞、别解释）\n' +
        slang.map((x) => '- ' + x.content + '：' + String(x.meaning || '').slice(0, 55)).join('\n')
    );
  }

  parts.push(
    '\n# 关于回忆\n' +
      '有人问"你还记得吗""你记得我什么"时，从上面的事实和日记里挑**具体的**一件事说出来——' +
      '哪一天、什么细节、当时怎么聊的。不要只给"我记得你很忙""你最近很累"这种空话，那等于没记住。\n' +
      '举个例子：不要说「记得你很忙」，要说「你上次说加班到十点，还骂了老板一句」。一次说一两件就够，说完可以顺手问一句。真的记不清就直说"这个我记不太清了"，别编，也别把别人的事说成他的。'
  );

  const ruleText = (cfg.prompt && cfg.prompt.rules ? String(cfg.prompt.rules) : '').trim();
  if (ruleText) parts.push('\n# 怎么说话（这条比人设优先）\n' + ruleText);
  const ttsCfg = loadConfig().tts;
  if (ttsCfg?.enabled) {
    parts.push(
      '\n# 语音\n你偶尔可以发语音（文字转的真人声音，女声）。\n' +
      '用法：单独起一行写 [[语音:你要说的话]]，时长控制在 20 字以内，像真的开口说一句。\n' +
      '适合：撒娇、说晚安、认真安慰、想让他听见你声音的时候。别频繁，一天几次就够。\n'
    );
  }
  const tags = media.stickerTags();
  if (tags.length) {
    parts.push(
      '\n# 表情包（这是你真正在用的功能）\n' +
      '你手上有 ' + tags.length + ' 张表情，心情词：' + tags.join('、') + '。\n' +
      '用法：**单独起一行**写 [[表情:心情词]]，我会把它换成一张真的表情图发出去。\n' +
      '什么时候用：说完一句带情绪的话，紧接着跟一张——开心、无语、嫌弃、得意、惊讶、心疼、敷衍都算。\n' +
      '频率：多数时候 2~3 轮里至少用一次，但别连着两条都用；一次对话最多两张。\n' +
      '示例：\n' +
      '  你：被你气笑了\n' +
      '  [[表情:无语]]\n' +
      '  你：那你去忙吧，我不打扰你\n' +
      '  [[表情:没关系]]\n' +
      '没有贴切的心情词就别硬编，胡说一个词我会找不到图。'
    );
  }
  return parts.join('\n');
}

function diaryText(convId) {
  try {
    const list = store.listDiary(convId, 3);
    if (!list.length) return '';
    return list
      .map((d) => '- ' + d.day + (d.mood ? '（' + d.mood + '）' : '') + '：' + d.summary)
      .join('\n');
  } catch {
    return '';
  }
}

const RECALL_RE = /(还记得|记得我|记不记得|你还记得|还记得我|记得什么|以前说|我说过|之前说|上次说|回忆|认识我多久|了解我多少|记不记得我)/;

/** 把一句话切成 trigram FTS 能吃的片段：中文 3 字、英文/数字 3 字符起 */
function ftsTokens(text) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(/[a-zA-Z0-9_]{3,}/g)) out.add(m[0].toLowerCase());
  for (const seg of s.replace(/[^\u3400-\u9fff]+/g, ' ').split(/\s+/)) {
    const chars = [...seg];
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(''));
  }
  return [...out].slice(0, 12);
}

/** 按这句话回溯相关的旧原话；一个都命中不了，就退回到最近说过的话 */
function relevantQuotes(convId, query, limit = 5) {
  const toks = ftsTokens(query);
  if (toks.length) {
    const match = toks.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ');
    const hits = store.searchMessagesByMatch(match, 30, convId);
    if (hits.length) {
      const inWindow = new Set(store.recentMessages(convId, 24).map((m) => m.id));
      const picked = hits.filter(
        (m) => m.role === 'user' && m.text && !String(m.text).startsWith('[') && !inWindow.has(m.id)
      );
      if (picked.length) return picked.slice(0, limit);
    }
  }
  return store
    .recentMessages(convId, 120)
    .filter((m) => m.role === 'user' && m.text && !String(m.text).startsWith('['))
    .slice(-limit);
}

/** 把日记 + 相关的旧原话拼成一份"证据"，逼她用具体的，而不是概括 */
function recallEvidence(convId, query = '') {
  const lines = [];
  try {
    for (const d of store.listDiary(convId, 7)) {
      lines.push('[你的日记 ' + d.day + (d.mood ? ' 心情:' + d.mood : '') + '] ' + String(d.summary || '').slice(0, 160));
    }
  } catch {}
  try {
    for (const m of relevantQuotes(convId, query, 5)) {
      const d = new Date(m.ts);
      const p = (x) => String(x).padStart(2, '0');
      lines.push(
        '[他说 ' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + '] ' + String(m.text).slice(0, 120)
      );
    }
  } catch {}
  return lines.join('\n').slice(0, 1800);
}

/** 下载图片 → base64 数据 URL（QQ 的图大多是 http，直接抓） */
async function loadImageParts(urls, cfg) {
  const max = Number(cfg.llm.visionMaxBytes) || 3 * 1024 * 1024;
  const out = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > max || buf.length < 800) continue;
      let mime = 'image/jpeg';
      if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
      else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
      else if (buf.slice(8, 12).toString() === 'WEBP') mime = 'image/webp';
      out.push({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } });
    } catch {
      /* 单张失败就跳过 */
    }
  }
  return out;
}

export function buildMessages({ convId, partnerName, userText, extraSystem = '', imageParts = [], proactive = null }) {
  const cfg = loadConfig();
  const rows = store.recentMessages(convId, (Number(cfg.llm.historyTurns) || 24) * 2);

  // 召回：按这句话的相关度挑 facts（不再全量塞）
  let memBlock = '';
  let memInfo = null;
  try {
    const lastUserRow = [...rows].reverse().find((r) => r.role === 'user');
    const mem = recall.selectFacts({ convId, query: String(userText || lastUserRow?.text || '') });
    memBlock = mem.block;
    memInfo = mem.telemetry;
  } catch {
    memBlock = '';
  }

  let systemContent = buildSystemPrompt({ convId, partnerName, factsText: memBlock });
  if (extraSystem) systemContent += '\n' + extraSystem;

  const lastUser = [...rows].reverse().find((r) => r.role === 'user');
  if (lastUser && RECALL_RE.test(String(lastUser.text || ''))) {
    const ev = recallEvidence(convId, String(lastUser.text || ''));
    if (ev) {
      systemContent +=
        '\n\n# 检索到的记忆（这一次必须用）\n' +
        '下面是你自己日记里、和他聊天记录里翻出来的原文。回答时必须从中引用至少一条**具体的**——' +
        '说清哪一天、什么细节、他当时的原话。禁止概括成"你很忙""你最近很累"这种空话。\n' +
        '一次说 1~2 件就够，不要照念整段，也不要暴露"我在查资料"。\n' +
        ev.slice(0, 2600);
    }
  }

  const roll = getRollSummary(convId);
  if (roll) {
    systemContent +=
      '\n\n# 更早的对话（你已经整理过的记忆，别照念，自然带出来）\n' + roll;
  }

  const msgs = [{ role: 'system', content: systemContent }];
  const isGroup = String(convId).startsWith('group:');
  for (const r of rows) {
    if (!r.text) continue;
    if (r.role === 'user') {
      const who = isGroup && r.senderName ? r.senderName + '：' : '';
      msgs.push({ role: 'user', content: who + r.text });
    } else if (r.role === 'assistant') {
      msgs.push({ role: 'assistant', content: r.text });
    }
  }
  if (userText) msgs.push({ role: 'user', content: userText });
  if (imageParts && imageParts.length) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        msgs[i] = {
          role: 'user',
          content: [{ type: 'text', text: msgs[i].content || '看看这个' }, ...imageParts],
        };
        break;
      }
    }
  }

  if (proactive) {
    const motive = String(proactive.motive || '').trim() || '好久没人跟我说话了，我该主动去打个招呼';
    const hours = proactive.hours ? `距上次说话已经 ${proactive.hours} 小时。` : '';
    msgs[0] = {
      role: 'system',
      content:
        msgs[0].content +
        '\n\n# 现在没人跟你说话\n' +
        '这不是他来找你，是你自己想开口。' +
        hours +
        `\n你的动机：${motive}\n` +
        '规矩：跟平时一样短，一次 1~2 条；不要解释「我为什么突然找你」，不要说「系统提示」「定时任务」这类词；' +
        '如果你此刻真的不想说话，就只输出 [SILENT]。',
    };
    msgs.push({ role: 'user', content: '（没有新消息。这是你自己想开口，不是他发的。）' });
  }

  return msgs;
}

/* ---------------- 分条 ---------------- */

export function splitReply(text, maxChars) {
  const max = Number(maxChars) || 60;
  const cleaned = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/^```[\s\S]*?```$/gm, (m) => m.replace(/```[a-z]*\n?/gi, ''))
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .trim();
  if (!cleaned) return [];
  const rough = cleaned
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。！？!?~～…])\s*/))
    .map((s) => s.trim())
    .filter(Boolean);

  const beh = loadConfig().behavior || {};
  const splitComma = beh.splitOnComma !== false;
  const commaMin = Number(beh.commaSplitMinChars) || 12;
  const segs = [];
  for (const seg of segs) {
    const m = splitComma ? (function () { var q = seg.search(/[，,、；;]/); return q > 0 ? [seg.slice(0, q + 1), seg.slice(q + 1)] : null; })() : null;
    if (m) {
      const head = m[1].replace(/[，,、；;]$/, '').trim();
      const tail = m[2].trim();
      if (head.length >= commaMin && tail.length >= 4) { segs.push(head); segs.push(tail); continue; }
    }
    segs.push(seg);
  }
  const out = [];
  for (const seg of rough) {
    let s = seg;
    while (s.length > max) {
      let cut = s.lastIndexOf('，', max);
      if (cut < max * 0.5) cut = s.lastIndexOf(' ', max);
      if (cut < max * 0.5) cut = max;
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) out.push(s);
  }
  return out.slice(0, 8);
}

/* ---------------- 引擎 ---------------- */

const SEND_LOG = new Map();
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

/** 打字延迟：每字 × 字数，封顶（导出来便于测试） */
export function typingDelay(text, beh = {}) {
  const per = Number(beh.typingMsPerChar) || 55;
  const cap = Number(beh.typingMaxMs) || 6000;
  return Math.min(per * String(text || '').length, cap);
}

/** 真限流：滑动窗口，超了就拒发（返回 {ok, reason}） */
export function sendGate(convId, beh) {
  const now = Date.now();
  const arr = (SEND_LOG.get(convId) || []).filter((t) => now - t < HOUR_MS);
  SEND_LOG.set(convId, arr);
  const perMin = Number(beh.maxSendPerMinute) || 0;
  const perHour = Number(beh.maxSendPerHour) || 0;
  const lastMin = arr.filter((t) => now - t < MIN_MS).length;
  if (perHour > 0 && arr.length >= perHour) return { ok: false, reason: `每小时上限 ${perHour} 条` };
  if (perMin > 0 && lastMin >= perMin) return { ok: false, reason: `每分钟上限 ${perMin} 条` };
  return { ok: true };
}

export function markSent(convId) {
  const arr = SEND_LOG.get(convId) || [];
  arr.push(Date.now());
  SEND_LOG.set(convId, arr);
}

export class Agent {
  constructor({ onebot, bus }) {
    this.onebot = onebot;
    this.bus = bus;
    this.queues = new Map(); // convId -> Promise 链，避免同一会话并发回复
    this.attention = new Map(); // "会话|发送者" -> 最近一次叫我的时间戳（群聊看图用）
    this.batch = new Map(); // convId -> 攒批计时器（群里连发时先等一等再回）
    this.lastReplyAt = new Map(); // convId -> 上次开口的时间（最小间隔用）
    this.coveredTs = new Map(); // convId -> 已经回到哪条消息（防止重复回同一批）
    this.stats = { handled: 0, replied: 0, silent: 0, errors: 0 };
  }

  patchConv(convId, patch) {
    const st = store.getConvState(convId) || { affinity: 0 };
    return store.setConvState(convId, { ...patch });
  }

  /** 文字里有没有叫我：QQ 昵称 + 配置里的 callNames（人格卡名字不写死，避免误伤普通词） */
  calledByName(text) {
    const s = String(text || '');
    if (!s) return false;
    const names = [];
    if (this.onebot?.selfName) names.push(String(this.onebot.selfName));
    const extra = loadConfig().persona?.callNames;
    if (Array.isArray(extra)) for (const n of extra) names.push(String(n));
    return names.some((n) => n && n.length >= 2 && s.includes(n));
  }

  /** 引用回复的那条，是不是我自己发的 */
  isMyMessage(convId, replyId) {
    try {
      const id = String(replyId);
      return store
        .recentMessages(convId, 24)
        .some((m) => m.role === 'assistant' && m.meta && String(m.meta.messageId ?? '') === id);
    } catch {
      return false;
    }
  }

  /** 记一下"这个人刚叫过我" */
  noteAttention(convId, senderId) {
    const now = Date.now();
    this.attention.set(convId + '|' + senderId, now);
    if (this.attention.size > 400) {
      const ttl = this.attentionMs();
      for (const [k, t] of this.attention) if (now - t > ttl) this.attention.delete(k);
    }
  }

  inAttentionWindow(convId, senderId) {
    const t = this.attention.get(convId + '|' + senderId) || 0;
    return t > 0 && Date.now() - t <= this.attentionMs();
  }

  /** 被叫到之后多久内发的图还算"给我看的"，默认 180 秒，可在 config.behavior.imageAttentionSec 改 */
  attentionMs() {
    const sec = Number(loadConfig().behavior?.imageAttentionSec);
    return (Number.isFinite(sec) && sec > 0 ? sec : 180) * 1000;
  }

  async onEvent(ev) {
    if (!ev || ev.post_type !== 'message') return;
    if (ev.message_sent) return; // 自己发的不回
    const convId = convOf(ev);
    const senderId = String(ev.user_id ?? '');
    if (String(ev.self_id ?? this.onebot.selfId) === senderId) return;

    const norm = normalizeMessage(ev);
    if (norm.images && norm.images.length) media.collectIncoming(norm.images).catch(() => {});
    const userText = norm.text || (norm.images.length ? '[图片]' : norm.faces.length ? '[表情]' : norm.voice ? '[语音]' : '');
    if (!userText) return;

    const selfIdStr = String(ev.self_id ?? this.onebot.selfId);
    const isGroup = ev.message_type === 'group';
    // 被叫到的三种方式：@ 我、文字里叫我名字、引用回复我的消息
    const calledByName = this.calledByName(userText);
    const atMe = !isGroup || (norm.ats || []).some((x) => String(x) === selfIdStr) || calledByName;
    const replyToMe = isGroup && norm.replyId ? this.isMyMessage(convId, norm.replyId) : false;
    if (atMe || replyToMe) this.noteAttention(convId, senderId);
    // 群里默认不翻图（省 token）；被叫到之后的一小段时间内，这个人再发图才看
    const lookImages = atMe || replyToMe || (isGroup && this.inAttentionWindow(convId, senderId));
    if (norm.images.length) log.info(`图片 ${norm.images.length} 张 · ${lookImages ? '看' : '不看'} · ${convId}`);

    // 记人：QQ 是身份，名字只是别名（同昵称不同号会留一条待确认线索）
    try {
      store.touchPerson({ qq: senderId, name: ev.sender?.card || ev.sender?.nickname || '', convId });
    } catch {
      /* 记人失败不影响回复 */
    }

    store.addMessage({
      convId,
      role: 'user',
      senderId,
      senderName: ev.sender?.card || ev.sender?.nickname || '',
      text: userText,
      kind: norm.images.length && !norm.text ? 'image' : 'text',
      meta: { raw: ev.message_id, images: (norm.images || []).map((i) => i.url).filter(Boolean), lookImages },
    });
    store.setConvState(convId, { lastUserAt: Date.now(), unread: (store.getConvState(convId)?.unread || 0) + 1 });
    this.emit('message', { convId, senderId, userText });

    if (!isAllowed(convId, senderId)) {
      log.info(`跳过（不在白名单）: ${convId} <- ${senderId}`);
      return;
    }
    if (isOwner(senderId)) {
      // 主人永远不睡、不限流，但"看到消息"的时间仍然保留
    } else if (this.inQuietHours()) {
      log.info(`静默时段，不回复 ${convId}`);
      return;
    }

    const beh0 = loadConfig().behavior;
    // 拟真 0：群里不是每条都要接话；被 @、被叫名字、被引用回复必回；主人永远回
    const forced = isGroup && (atMe || replyToMe);
    const replyP = Number(beh0 && beh0.replyProbability);
    if (!forced && !isOwner(senderId) && Number.isFinite(replyP) && Math.random() > replyP) {
      this.emit('skip', { convId, reason: '概率忽略' });
      log.info(`跳过不接（概率）: ${convId}`);
      return;
    }

    // 拟真 1：先"看到"消息，隔一会儿才开始想（不是秒回机器人）
    const beh = loadConfig().behavior;
    const readDelay = randomBetween(beh.readDelayMs || [600, 2200]);
    this.emit('read', { convId, delayMs: Math.round(readDelay) });
    await sleep(readDelay);

    // 拟真 2：尽力标记已读（协议端支持才生效）
    this.onebot.call('mark_msg_as_read', { message_id: ev.message_id }, { timeout: 4000 }).catch(() => {});

    this.scheduleReply(convId, ev.sender?.card || ev.sender?.nickname || '');
  }

  /**
   * 群里消息密集时先攒一会儿：等这段安静下来（或最多等 N 秒）再一次看完再回，
   * 避免"别人发一条她回一条"。私聊不攒，直接回。
   */
  scheduleReply(convId, partnerName) {
    const beh = loadConfig().behavior || {};
    const isGroup = String(convId).startsWith('group:');
    const quiet = Number(beh.groupBatchQuietMs) || 0;
    const maxWait = Number(beh.groupBatchMaxWaitMs) || 0;
    if (!isGroup || quiet <= 0) {
      this.enqueue(convId, () => this.reply(convId, { partnerName }));
      return;
    }
    const now = Date.now();
    let b = this.batch.get(convId);
    if (!b) {
      b = { firstAt: now, timer: null, partnerName };
      this.batch.set(convId, b);
    }
    b.partnerName = partnerName || b.partnerName;
    // 等安静：最后一条之后 quiet 毫秒；但别为了等安静无限拖，第一条起最多 maxWait
    const byQuiet = Math.min(quiet, Math.max(150, maxWait - (now - b.firstAt)));
    // 冷却：她刚说过话就别隔一秒又插一句
    const gap = Number(beh.groupMinGapMs) || 0;
    const byGap = Math.max(0, (this.lastReplyAt.get(convId) || 0) + gap - now);
    const due = Math.max(byQuiet, byGap, 150);
    clearTimeout(b.timer);
    b.timer = setTimeout(() => {
      this.batch.delete(convId);
      this.enqueue(convId, () => this.replyBatch(convId, b.partnerName));
    }, due);
    if (b.timer.unref) b.timer.unref();
  }

  /** 攒批落点：这批里如果有更新的消息已经回过了，就静默跳过，防止连发两轮 */
  async replyBatch(convId, partnerName) {
    const rows = store.recentMessages(convId, 12);
    const lastUser = [...rows].reverse().find((m) => m.role === 'user');
    if (!lastUser) return { skipped: true };
    if (lastUser.ts <= (this.coveredTs.get(convId) || 0)) return { skipped: true };
    this.lastReplyAt.set(convId, Date.now());
    try {
      return await this.reply(convId, { partnerName });
    } finally {
      this.coveredTs.set(convId, lastUser.ts);
    }
  }

  enqueue(convId, task) {
    const prev = this.queues.get(convId) || Promise.resolve();
    const next = prev.then(task).catch((err) => {
      this.stats.errors++;
      log.error('回复失败', err.message);
      this.emit('error', { convId, message: err.message });
    }).finally(() => {
      if (this.queues.get(convId) === next) this.queues.delete(convId);
    });
    this.queues.set(convId, next);
    return next;
  }

  inQuietHours() {
    const q = loadConfig().behavior.quietHours;
    if (!q?.enabled) return false;
    const [sh, sm] = String(q.start || '01:30').split(':').map(Number);
    const [eh, em] = String(q.end || '09:00').split(':').map(Number);
    const d = new Date();
    const cur = d.getHours() * 60 + d.getMinutes();
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
  }

  async reply(convId, { partnerName = '', userText = '', stream = false, proactive = null } = {}) {
    const cfg = loadConfig();
    const providerName = cfg.llm.defaultProvider;
    const provider = resolveProvider(providerName);
    // 有图就用视觉模型，没图用默认模型；主动开口不重新翻旧图
    const lastRow = store.recentMessages(convId, 4).reverse().find((m) => m.role === 'user');
    const allowLook = !proactive && !(lastRow && lastRow.meta && lastRow.meta.lookImages === false);
    const imgUrls = allowLook
      ? ((lastRow && lastRow.meta && lastRow.meta.images) || []).slice(0, Number(cfg.llm.visionMaxImages) || 2)
      : [];
    const imageParts = imgUrls.length ? await loadImageParts(imgUrls, cfg) : [];
    const model = imageParts.length && cfg.llm.visionModel ? cfg.llm.visionModel : provider.model;
    if (imageParts.length) log.info('带图回复：' + imageParts.length + ' 张，模型 ' + model);

    const msgs = buildMessages({ convId, partnerName, userText, imageParts, proactive });
    const systemChars = msgs[0].content.length;

    this.emit('thinking', { convId, persona: activePersonaText().name, model, systemChars });

    const started = Date.now();
    let acc = '';
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    this._abort = onAbort;

    try {
      for await (const ev of streamChat({
        provider,
        model,
        messages: msgs,
        temperature: Number(cfg.llm.temperature) || 1,
        maxTokens: Number(cfg.llm.maxTokens) || 1024,
        signal: ac.signal,
      })) {
        if (ev.type === 'delta') {
          acc += ev.text;
          this.emit('delta', { convId, text: ev.text });
        } else if (ev.type === 'usage') {
          store.recordUsage({
            convId,
            provider: providerName,
            model,
            promptTokens: ev.usage.prompt_tokens || 0,
            completionTokens: ev.usage.completion_tokens || 0,
            latencyMs: Date.now() - started,
          });
        }
      }
    } finally {
      this._abort = null;
    }

    acc = acc.trim();
    if (!acc || SILENT.test(acc)) {
      this.stats.silent++;
      log.info(`选择沉默 (${convId})`);
      store.setConvState(convId, { unread: 0 });
      this.emit('silent', { convId });
      return { silent: true };
    }

    const ops = media.splitOps(acc);
    const plan = [];
    for (const op of ops) {
      if (op.kind === 'text') {
        for (const t of splitReply(op.text, cfg.behavior.splitMaxChars)) plan.push({ kind: 'text', text: t });
      } else {
        plan.push(op);
      }
    }
    if (!plan.length) return { silent: true };

    const sent = [];
    let seq = 0;
    let usedSticker = false;
    for (const item of plan) {
      if (seq++ > 0) await sleep(randomBetween(cfg.behavior.sendGapMs));

      if (item.kind === 'text') {
        const typingMs = typingDelay(item.text, cfg.behavior);
        if (typingMs > 200) {
          this.onebot.typing(convId).catch(() => {});
          await sleep(typingMs);
        }
        const gate = sendGate(convId, cfg.behavior);
        if (!gate.ok) {
          log.warn(`限流跳过 ${convId}：${gate.reason}`);
          this.emit('ratelimit', { convId, reason: gate.reason });
          break;
        }
        try {
          const messageId = await this.onebot.send(convId, item.text);
          markSent(convId);
          sent.push({ text: item.text, messageId });
          store.addMessage({ convId, role: 'assistant', text: item.text, kind: 'text', meta: { messageId } });
          this.emit('sent', { convId, text: item.text, messageId });
        } catch (err) {
          this.stats.errors++;
          log.error('发送失败 ' + convId + ': ' + err.message);
          store.addMessage({ convId, role: 'assistant', text: item.text, kind: 'text', meta: { error: err.message } });
          break;
        }
      } else if (item.kind === 'sticker') {
        try {
          const r = await media.sendSticker(this.onebot, convId, item.query);
          usedSticker = true;
          const label = '[表情:' + (r.sticker.desc || '无备注') + ']';
          store.addMessage({ convId, role: 'assistant', text: label, kind: 'sticker', meta: { messageId: r.id } });
          this.emit('sent', { convId, text: label, messageId: r.id });
          sent.push({ text: label, messageId: r.id });
        } catch (err) {
          log.warn('发表情失败: ' + err.message);
        }
      } else if (item.kind === 'voice') {
        try {
          const tts = await import('./tts.js');
          const r = await tts.sendVoice(this.onebot, convId, item.query);
          const label = '[语音] ' + r.text;
          store.addMessage({ convId, role: 'assistant', text: label, kind: 'voice', meta: { messageId: r.messageId, file: r.file } });
          this.emit('sent', { convId, text: label, messageId: r.messageId });
          sent.push({ text: label, messageId: r.messageId });
        } catch (err) {
          log.warn('发语音失败: ' + err.message);
        }
      } else if (item.kind === 'image') {
        try {
          const fp = path.join(PATHS.images, item.query);
          const mid = await media.sendImage(this.onebot, convId, fp);
          const label = '[图片:' + item.query + ']';
          store.addMessage({ convId, role: 'assistant', text: label, kind: 'image', meta: { messageId: mid } });
          this.emit('sent', { convId, text: label, messageId: mid });
          sent.push({ text: label, messageId: mid });
        } catch (err) {
          log.warn('发图失败: ' + err.message);
        }
      }
    }

    // 自动表情：先看她刚才说了什么，语义对得上才配（对不上就极小概率随机）
    const lastText = sent.filter((x) => !String(x.text).startsWith('[')).map((x) => x.text).join(' ');
    const matched = media.pickStickerByText(lastText);
    const blindP = Number(cfg.media?.autoStickerProbability) || 0;
    const pSticker = matched ? 0.6 : blindP;
    if (!usedSticker && Math.random() < pSticker) {
      try {
        const r = await media.sendSticker(this.onebot, convId, matched ? matched.desc : null);
        const label = '[表情:' + (r.sticker.desc || '无备注') + ']';
        store.addMessage({ convId, role: 'assistant', text: label, kind: 'sticker', meta: { messageId: r.id } });
        this.emit('sent', { convId, text: label, messageId: r.id });
        sent.push({ text: label, messageId: r.id });
      } catch (err) {
        log.warn('自动表情失败: ' + err.message);
      }
    }
    const parts = sent.filter((x) => !String(x.text).startsWith('[')).map((x) => x.text);
    const prevAff = Number(store.getConvState(convId)?.affinity) || 0;
    const nextAff = Math.min(100, prevAff + 0.6);
    store.setConvState(convId, { lastBotAt: Date.now(), unread: 0, affinity: nextAff });

    // 情绪：本地判 + 抽样复核，异步跑，不拖慢发送
    const userLine = String(
      userText || store.recentMessages(convId, 8).reverse().find((m) => m.role === 'user')?.text || (proactive ? '（她自己先开的口）' : '')
    );
    mood
      .afterTurn({ convId, userText: userLine, botText: parts.join(' '), partnerName })
      .catch((err) => log.warn('情绪更新失败: ' + err.message));

    scheduleDiary(convId, this.bus);
    maybeRollSummary(convId, this.bus).catch((e) => log.warn('滚动摘要失败: ' + e.message));
    this.stats.replied++;
    log.info(`回复 ${convId}：${parts.length} 条 / ${acc.length} 字 / ${Date.now() - started}ms`);
    return { parts: sent, raw: acc };
  }

  /** 主动开口：不写 user 消息、不计 unread，让她用自己的语气起个话头（可以选 [SILENT]） */
  async proactive(convId, motive = '') {
    const st = store.getConvState(convId) || {};
    const hours = st.lastUserAt || st.lastBotAt ? Math.round((Date.now() - (st.lastBotAt || st.lastUserAt)) / 3600000) : null;
    this.emit('wake', { convId, motive });
    return this.reply(convId, { partnerName: '', proactive: { motive, hours: hours && hours > 0 ? hours : null } });
  }

  /** 控制台"试聊"：不经过 QQ，直接跑一轮 */
  async preview(convId, text) {
    store.addMessage({ convId, role: 'user', senderId: 'console', senderName: '试聊', text });
    const cfg = loadConfig();
    const provider = resolveProvider(cfg.llm.defaultProvider);
    const msgs = buildMessages({ convId, partnerName: '我', userText: text });
    const started = Date.now();
    let acc = '';
    for await (const ev of streamChat({
      provider,
      model: provider.model,
      messages: msgs,
      temperature: Number(cfg.llm.temperature) || 1,
      maxTokens: Number(cfg.llm.maxTokens) || 1024,
    })) {
      if (ev.type === 'delta') acc += ev.text;
      if (ev.type === 'usage') {
        store.recordUsage({
          convId,
          provider: cfg.llm.defaultProvider,
          model: provider.model,
          promptTokens: ev.usage.prompt_tokens || 0,
          completionTokens: ev.usage.completion_tokens || 0,
          latencyMs: Date.now() - started,
        });
      }
    }
    const ops = media.splitOps(acc);
    const display = [];
    const parts = [];
    for (const op of ops) {
      if (op.kind === 'text') {
        for (const t of splitReply(op.text, cfg.behavior.splitMaxChars)) {
          parts.push(t);
          display.push(t);
        }
      } else if (op.kind === 'sticker') {
        const hit = media.pickSticker(op.query);
        const label = '[表情:' + (hit && hit.desc ? hit.desc : op.query) + ']';
        parts.push(label);
        display.push(label);
      } else if (op.kind === 'voice') {
        const label = '[语音:' + op.query + ']';
        parts.push(label);
        display.push(label);
      } else {
        const label = '[图片:' + op.query + ']';
        parts.push(label);
        display.push(label);
      }
    }
    for (const p of parts) store.addMessage({ convId, role: 'assistant', text: p });
    return { raw: media.stripMarkers(acc), parts, ms: Date.now() - started };
  }

  cancel() {
    try {
      this._abort?.();
    } catch {
      /* ignore */
    }
  }

  emit(type, payload) {
    this.bus?.emit('agent', { type, ...payload, ts: Date.now() });
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
