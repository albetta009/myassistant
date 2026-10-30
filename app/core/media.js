// 表情包与图片：本地库、旧库导入、按心情挑选、发送（file:// 优先，失败退 base64）。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { PATHS, loadConfig } from './config.js';
import { logger } from './log.js';

const log = logger('media');
const INDEX = path.join(PATHS.stickers, 'index.json');
const IMG_EXT = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp']);

const MIME = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

if (!existsSync(PATHS.stickers)) mkdirSync(PATHS.stickers, { recursive: true });
if (!existsSync(PATHS.images)) mkdirSync(PATHS.images, { recursive: true });

/* ---------------- 索引 ---------------- */

export function loadIndex() {
  try {
    if (!existsSync(INDEX)) return { items: [] };
    const j = JSON.parse(readFileSync(INDEX, 'utf8'));
    if (!Array.isArray(j.items)) j.items = [];
    return j;
  } catch {
    return { items: [] };
  }
}

function saveIndex(idx) {
  writeFileSync(INDEX, JSON.stringify(idx, null, 2) + '\n', 'utf8');
}

/** 列表给控制台用：审核页要看到全部（含待审核/已拒绝） */
export function listStickers() {
  const idx = loadIndex();
  return idx.items.map((it) => ({
    ...it,
    status: it.status || 'approved',
    exists: existsSync(path.join(PATHS.stickers, it.file)),
  }));
}

/** 她能用的：只有审核通过、且文件还在的；待审核的一律看不见 */
export function approvedStickers() {
  return listStickers().filter((i) => i.exists && (i.status || 'approved') === 'approved');
}

export function stickerTags() {
  const tags = new Set();
  for (const it of approvedStickers()) {
    if (it.desc) tags.add(it.desc);
    for (const t of it.tags || []) tags.add(t);
  }
  return [...tags];
}

/* ---------------- 导入 / 收集 ---------------- */

function extFromContentType(ct, url) {
  const s = String(ct || '').toLowerCase();
  if (s.includes('gif')) return '.gif';
  if (s.includes('png')) return '.png';
  if (s.includes('webp')) return '.webp';
  if (s.includes('jpeg') || s.includes('jpg')) return '.jpg';
  const m = /\.(gif|png|jpe?g|webp)(?:\?|$)/i.exec(String(url || ''));
  return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : '.png';
}

async function download(url, filePath) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 MYAssistant' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(filePath, buf);
  return { bytes: buf.length, ext: extFromContentType(res.headers.get('content-type'), url) };
}

/** 导入旧 qq-bridge 的 stickers.json（元数据 + 从 QQ 表情 CDN 下图片） */
export async function importLegacy(file) {
  if (!existsSync(file)) throw new Error('旧库文件不存在: ' + file);
  const arr = JSON.parse(readFileSync(file, 'utf8'));
  const idx = loadIndex();
  const have = new Set(idx.items.map((i) => i.id));
  let added = 0;
  let failed = 0;

  for (const s of arr) {
    if (!s?.md5 || have.has(s.md5)) continue;
    const ext = extFromContentType('', s.url);
    const fileName = `${s.md5}${ext}`;
    const fp = path.join(PATHS.stickers, fileName);
    try {
      if (!existsSync(fp)) await download(s.url, fp);
      idx.items.push({
        id: s.md5,
        file: fileName,
        desc: s.desc || '',
        tags: Array.isArray(s.tags) ? s.tags : [],
        note: s.localNote || '',
        useCount: Number(s.useCount) || 0,
        source: 'qq',
        addedAt: Date.now(),
      });
      added++;
    } catch (err) {
      failed++;
      log.warn(`表情下载失败 ${s.desc}: ${err.message}`);
    }
  }
  saveIndex(idx);
  log.info(`导入表情 ${added} 张，失败 ${failed} 张，共 ${idx.items.length} 张`);
  return { added, failed, total: idx.items.length };
}

/** 把散落在目录里的图片补进索引（手动丢进去的图也能用） */
export function scanDir() {
  const idx = loadIndex();
  const have = new Set(idx.items.map((i) => i.file));
  let added = 0;
  for (const f of require$readdir(PATHS.stickers)) {
    const ext = path.extname(f).toLowerCase();
    if (!IMG_EXT.has(ext) || have.has(f)) continue;
    idx.items.push({ id: f.replace(/\W/g, ''), file: f, desc: path.basename(f, ext), tags: [], note: '', useCount: 0, source: 'local', addedAt: Date.now() });
    added++;
  }
  if (added) saveIndex(idx);
  return { added, total: idx.items.length };
}

// 小工具：避免顶层再引一次 fs
import { readdirSync } from 'node:fs';
function require$readdir(dir) {
  try {
    return readdirSync(dir).filter((f) => IMG_EXT.has(path.extname(f).toLowerCase()));
  } catch {
    return [];
  }
}

/* ---------------- 挑选 ---------------- */

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

/** 按关键词挑一张：先精确 desc/tags，再包含匹配；**指定了找不到就不发**（避免乱发一张对不上的） */
export function pickSticker(query) {
  const items = approvedStickers();
  if (!items.length) return null;
  const q = norm(query);
  if (q) {
    const exact = items.filter((i) => norm(i.desc) === q || (i.tags || []).some((t) => norm(t) === q));
    if (exact.length) return exact[Math.floor(Math.random() * exact.length)];
    const fuzzy = items.filter((i) => {
      const d = norm(i.desc);
      const byDesc = d && (d.includes(q) || q.includes(d));
      const byTag = (i.tags || []).some((t) => t && norm(t).includes(q));
      return byDesc || byTag;
    });
    if (fuzzy.length) return fuzzy[Math.floor(Math.random() * fuzzy.length)];
    return null;
  }
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * 按一句话的语义挑表情：拿她的原话去和各表情的心情词求最长公共子串，
 * 命中度够高才用（避免"辛苦了"配一张"流汗"）。
 */
const EMOTION_HINTS = [
  { re: /累|烦|难受|委屈|哭|崩溃|压力|撑不住|心累|好丧/, desc: '抱抱' },
  { re: /哈哈|笑死|好笑|好笑|逗|乐|绷不住/, desc: '憋笑看戏脸' },
  { re: /无语|气笑|服了|离谱|绝了|算了/, desc: '无语' },
  { re: /嫌弃|恶心|别过来|滚|走开/, desc: '嫌弃' },
  { re: /惊讶|居然|竟然|真的假的|不会吧|啊？/, desc: '惊讶' },
  { re: /骄傲|得意|牛|厉害|夸我|表扬/, desc: '骄傲' },
  { re: /不知道|不懂|语塞|呃|emmm|这\.\.\./, desc: '语塞' },
  { re: /随便|没事|不用了|没关系/, desc: '没关系' },
  { re: /好累|困|睡|晚安/, desc: '抱抱' },
];

export function pickStickerByText(text) {
  const items = approvedStickers().filter((i) => i.desc);
  if (!items.length) return null;
  const t = String(text || '');
  if (!t) return null;

  for (const h of EMOTION_HINTS) {
    if (h.re.test(t)) {
      const hit = items.find((i) => i.desc === h.desc);
      if (hit) return hit;
    }
  }

  const STOP = new Set('的了是我你他她它不没在有就都也很吗呢啊吧呀哦哈嗯这那'.split(''));
  const lcs = (a, b) => {
    let best = 0;
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        let k = 0;
        while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
        if (k > best) best = k;
      }
    }
    return best;
  };

  let best = null;
  let bestScore = 0;
  for (const it of items) {
    const d = it.desc.replace(/\s/g, '');
    if (d.length < 2) continue;
    const chars = [...d].filter((c) => !STOP.has(c));
    if (!chars.length) continue;
    const score = lcs(d, t) / d.length;
    const charHit = chars.filter((c) => t.includes(c)).length / chars.length;
    const total = Math.max(score, charHit * 0.8);
    if (total > bestScore) {
      bestScore = total;
      best = it;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

export function bumpUse(id) {
  const idx = loadIndex();
  const it = idx.items.find((i) => i.id === id);
  if (!it) return;
  it.useCount = (Number(it.useCount) || 0) + 1;
  it.lastUsedAt = Date.now();
  saveIndex(idx);
}

/* ---------------- 发送 ---------------- */

/** 给表情写备注/心情词（写了她才知道什么时候用） */
export function setStickerMeta(id, { desc, tags, note } = {}) {
  const idx = loadIndex();
  const it = idx.items.find((i) => i.id === id);
  if (!it) throw new Error('表情不存在');
  if (desc != null) it.desc = String(desc).slice(0, 20);
  if (tags != null) {
    const arr = Array.isArray(tags) ? tags : String(tags).split(/[\s,，、]+/);
    it.tags = arr.map((t) => String(t).trim()).filter(Boolean).slice(0, 6);
  }
  if (note != null) it.note = String(note).slice(0, 60);
  it.updatedAt = Date.now();
  saveIndex(idx);
  return it;
}

export function approveSticker(id) {
  const idx = loadIndex();
  const it = idx.items.find((i) => i.id === id);
  if (!it) throw new Error('素材不存在');
  it.status = 'approved';
  it.updatedAt = Date.now();
  saveIndex(idx);
  return it;
}

export function rejectSticker(id) {
  const idx = loadIndex();
  const i = idx.items.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const it = idx.items[i];
  try {
    const fp = path.join(PATHS.stickers, it.file);
    if (existsSync(fp)) unlinkSync(fp);
  } catch {}
  idx.items.splice(i, 1);
  saveIndex(idx);
  return true;
}

export function deleteStickers(ids) {
  const set = new Set(ids || []);
  const idx = loadIndex();
  const keep = [];
  let n = 0;
  for (const it of idx.items) {
    if (set.has(it.id)) {
      n++;
      try {
        const fp = path.join(PATHS.stickers, it.file);
        if (existsSync(fp)) unlinkSync(fp);
      } catch {}
    } else keep.push(it);
  }
  idx.items = keep;
  saveIndex(idx);
  return n;
}

/** 某种情绪已有几张（已收录 + 已采纳的） */
function emotionCount(idx, desc) {
  const d = String(desc || '').trim();
  if (!d) return 0;
  return idx.items.filter((x) => (x.status || 'approved') === 'approved' && String(x.desc || '') === d).length;
}

export async function sendImage(onebot, conv, filePath) {
  if (!existsSync(filePath)) throw new Error('文件不存在: ' + filePath);
  const st = statSync(filePath);
  if (st.size > 20 * 1024 * 1024) throw new Error('图片超过 20MB');
  const abs = filePath.replace(/\\/g, '/');
  try {
    return await onebot.send(conv, [{ type: 'image', data: { file: 'file://' + abs } }]);
  } catch (err) {
    log.warn('file:// 发送失败，改 base64: ' + err.message);
    const b64 = readFileSync(filePath).toString('base64');
    return await onebot.send(conv, [{ type: 'image', data: { file: 'base64://' + b64 } }]);
  }
}

export async function sendSticker(onebot, conv, query) {
  const item = pickSticker(query);
  if (!item) throw new Error('表情库是空的');
  const fp = path.join(PATHS.stickers, item.file);
  const id = await sendImage(onebot, conv, fp);
  bumpUse(item.id);
  log.info(`发表情「${item.desc || item.file}」→ ${conv}`);
  return { id, sticker: item };
}

/* ---------------- 解析回复里的指令 ---------------- */

// 模型有时写 [[表情:x]]，有时只写 [表情:x]（历史消息里存的就是单括号标签，会被它模仿），
// 还有时候括号不闭合。这里只认「标签头 + 内容」，右括号可有可无，由 splitOps 自己吞掉。
// 表情/图片必须带冒号；语音允许「[语音] 内容」这种没有冒号的写法——
// 因为历史消息里存的就是 `[语音] …`，模型会照着模仿。三种写法都要认：
//   [[语音:内容]] / [语音:内容] / [语音] 内容
const TAG_OPEN =
  /\[{1,2}\s*(表情|图片|图|sticker|image)\s*[:：]\s*([^\[\]\n]{1,40})|\[{1,2}\s*(语音|voice)\s*(?:\]{1,2}\s*)?[:：]?\s*([^\[\]\n]{1,60})/gi;
// 用于把残留标签（含不闭合的）从正文里清掉
const TAG_FULL =
  /\[{1,2}\s*(表情|图片|图|sticker|image)\s*[:：]\s*([^\[\]\n]{1,40})\s*\]{0,2}|\[{1,2}\s*(语音|voice)\s*(?:\]{1,2}\s*)?[:：]?\s*([^\[\]\n]{1,60})\s*\]{0,2}/gi;

function scrubMarkers(s) {
  return String(s || '')
    .replace(TAG_FULL, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 把模型输出切成有序操作：
 *   [{kind:'text', text}, {kind:'sticker', query}, {kind:'image', query}]
 */
export function splitOps(text) {
  const src = String(text || '');
  const ops = [];
  let last = 0;
  let m;
  TAG_OPEN.lastIndex = 0;
  while ((m = TAG_OPEN.exec(src))) {
    const before = src.slice(last, m.index).trim();
    if (before) ops.push({ kind: 'text', text: before });
    const word = m[1] || m[3];
    const query = (m[2] || m[4] || '').trim();
    const kind = /表情|sticker/i.test(word) ? 'sticker' : /语音|voice/i.test(word) ? 'voice' : 'image';
    ops.push({ kind, query });
    // 吞掉 tag 后面可能跟着的 ] 或 ]]
    let end = m.index + m[0].length;
    while (src[end] === ']') end++;
    last = end;
  }
  const tail = src.slice(last).trim();
  if (tail) ops.push({ kind: 'text', text: tail });
  // 兜底：正文里再出现半截标签也不让它发出去
  return ops
    .map((o) => (o.kind === 'text' ? { kind: 'text', text: scrubMarkers(o.text) } : o))
    .filter((o) => o.kind !== 'text' || o.text);
}

/** 把 [[表情:x]] / [表情:x] 之类的标记整个剥掉（用于纯文本场景，比如控制台预览） */
export function stripMarkers(text) {
  return scrubMarkers(text).replace(/\n{3,}/g, '\n\n').trim();
}

/** 收集对方发来的图片（作为表情库素材），失败静默 */
const STICKER_CLASSIFY = '你在判断一张图是不是 QQ 表情包。只输出一个极短的中文情绪词（2~6 字，如：无语、抱抱、嫌弃、得意、笑死）。如果它只是普通照片、聊天截图、文档、纯文字图片，就只输出：无。不要解释、不要标点。';

async function classifySticker(filePath) {
  try {
    const cfg = loadConfig();
    const { resolveProvider } = await import('./config.js');
    const { complete } = await import('./llm.js');
    const prov = resolveProvider(cfg.llm.defaultProvider);
    const buf = readFileSync(filePath);
    if (buf.length < 1500 || buf.length > 4 * 1024 * 1024) return null;
    let mime = 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
    else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
    const word = await complete({
      provider: prov,
      model: cfg.llm.visionModel || prov.model,
      maxTokens: 600,
      temperature: 0.2,
      messages: [
        { role: 'system', content: STICKER_CLASSIFY },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这是什么？' },
            { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buf.toString('base64') } },
          ],
        },
      ],
    });
    const w = String(word || '').replace(/[\s"'。，,、！!？?]/g, '').slice(0, 8);
    if (!w || w === '无' || w.includes('不是') || w.includes('照片')) return null;
    return w;
  } catch (err) {
    log.warn('分类失败: ' + err.message);
    return null;
  }
}

/** 收图：先判断是不是表情包，是的话进待审核；同情绪超量的直接丢 */
export async function collectIncoming(images) {
  const cfg = loadConfig();
  if (!cfg.media?.collectIncoming) return 0;
  const max = Number(cfg.media.maxStickers) || 500;
  const cap = Number(cfg.media.maxPerEmotion) || 3;
  const review = cfg.media?.reviewIncoming !== false;
  const idx = loadIndex();
  if (idx.items.length >= max) return 0;

  let added = 0;
  for (const img of images) {
    const url = img?.url;
    if (!url || !/^https?:\/\//.test(url)) continue;
    let fp = null;
    try {
      const ext = extFromContentType('', url);
      const fileName = 'in_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + ext;
      fp = path.join(PATHS.stickers, fileName);
      const info = await download(url, fp);
      if (info.bytes < 1500) { unlinkSync(fp); continue; }

      const emotion = await classifySticker(fp);
      if (!emotion) { unlinkSync(fp); continue; }              // 不是表情包，丢掉
      if (emotionCount(idx, emotion) >= cap) { unlinkSync(fp); continue; }  // 同情绪够了，不重复收

      idx.items.push({
        id: fileName,
        file: fileName,
        desc: emotion,
        tags: [emotion],
        note: '',
        useCount: 0,
        source: 'collected',
        status: review ? 'pending' : 'approved',
        addedAt: Date.now(),
      });
      saveIndex(idx);
      added++;
    } catch {
      if (fp && existsSync(fp)) { try { unlinkSync(fp); } catch {} }
    }
  }
  if (added) log.info('收集到 ' + added + ' 张备选表情');
  return added;
}
