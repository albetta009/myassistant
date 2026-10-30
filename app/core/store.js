// 存储层：node:sqlite（Node 24 内置，零依赖）。
// 表：messages / facts / diary / conv_state / usage / kv + FTS5 全文索引。
import { DatabaseSync } from 'node:sqlite';
import { PATHS, loadConfig } from './config.js';
import { logger } from './log.js';
const log = logger('store');

let db = null;
let ftsMode = 'none';

export function getDb() {
  if (!db) initStore();
  return db;
}

/**
 * 老库迁移：facts 原来是 (conv_id, subject, key)，按会话隔离。
 * 现在改成「以人（QQ 号）为主键」的全局表：一人一条 key，跨群共享。
 * 老数据按「owner→主人QQ」「昵称→该会话里同名发送者的 QQ」映射，映射不上就标 unknown:昵称。
 */
function migrateFactsToPeople() {
  const cols = db.prepare('PRAGMA table_info(facts)').all().map((c) => c.name);
  if (!cols.includes('conv_id')) return; // 已经是新结构
  const ownerQq = String(loadConfig().access?.ownerQQ || 'owner');
  log.info('迁移 facts → 全局人物记忆…');
  db.exec(`
    DROP TABLE IF EXISTS facts_v2;
    CREATE TABLE facts_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      prev_value TEXT,
      superseded_at INTEGER,
      last_used_at INTEGER,
      votes REAL NOT NULL DEFAULT 1,
      UNIQUE(subject_id, key)
    );
  `);
  const rows = db.prepare('SELECT * FROM facts').all();
  const ins = db.prepare(`INSERT INTO facts_v2
      (subject_id, subject, key, value, confidence, source, created_at, updated_at, pinned, prev_value, superseded_at, last_used_at, votes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(subject_id, key) DO UPDATE SET
        value = CASE WHEN excluded.confidence >= facts_v2.confidence THEN excluded.value ELSE facts_v2.value END,
        confidence = MAX(facts_v2.confidence, excluded.confidence),
        prev_value = CASE WHEN excluded.updated_at > facts_v2.updated_at THEN facts_v2.value ELSE facts_v2.prev_value END,
        updated_at = MAX(facts_v2.updated_at, excluded.updated_at),
        votes = facts_v2.votes + 1`);
  const claim = db.prepare(
    'INSERT INTO fact_claims (subject_id, key, value, speaker_qq, conv_id, confidence, source, ts) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)'
  );
  const person = db.prepare(
    `INSERT INTO people (qq, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(qq) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE people.name END, last_seen = MAX(people.last_seen, excluded.last_seen)`
  );
  const alias = db.prepare(
    `INSERT INTO person_aliases (qq, alias, conv_id, seen_count, last_seen) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(qq, alias) DO UPDATE SET seen_count = seen_count + 1, last_seen = MAX(last_seen, excluded.last_seen)`
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const name = String(r.subject || '').trim();
      let sid = null;
      if (!name || name === 'owner' || name === 'peer') {
        sid = ownerQq;
      } else {
        const hit = db
          .prepare('SELECT sender_id FROM messages WHERE conv_id = ? AND sender_name = ? ORDER BY ts DESC LIMIT 1')
          .get(String(r.conv_id), name);
        sid = hit && hit.sender_id ? String(hit.sender_id) : 'unknown:' + name;
      }
      const ts = Number(r.updated_at) || Date.now();
      ins.run(
        sid,
        name || String(sid),
        r.key,
        r.value,
        Number(r.confidence) || 0.7,
        r.source,
        Number(r.created_at) || ts,
        ts,
        r.pinned ? 1 : 0,
        r.prev_value || null,
        r.superseded_at || null,
        r.last_used_at || null
      );
      claim.run(sid, r.key, r.value, String(r.conv_id || ''), Number(r.confidence) || 0.7, r.source, ts);
      if (!String(sid).startsWith('unknown:')) {
        person.run(sid, name, Number(r.created_at) || ts, ts);
        if (name) alias.run(sid, name, String(r.conv_id || ''), ts);
      }
      n++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec('DROP TABLE facts; ALTER TABLE facts_v2 RENAME TO facts;');
  log.info(`facts 迁移完成：${n} 条 → 全局人物记忆`);
}

export function initStore() {
  if (db) return db;
  db = new DatabaseSync(PATHS.db);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      role TEXT NOT NULL,              -- user | assistant | system
      sender_id TEXT,
      sender_name TEXT,
      text TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'text', -- text | image | sticker | voice | notice
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conv_id, ts DESC);

    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      prev_value TEXT,
      superseded_at INTEGER,
      last_used_at INTEGER,
      votes REAL NOT NULL DEFAULT 1,
      UNIQUE(subject_id, key)
    );

    -- 事实流水：append-only。facts 只留当前值，这里留「什么时候新增/改成了什么」
    CREATE TABLE IF NOT EXISTS fact_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      prev_value TEXT,
      op TEXT NOT NULL,
      confidence REAL,
      source TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fact_events_conv ON fact_events(conv_id, ts DESC);

    -- 人：以 QQ 号为唯一身份；名字只是别名（同一个人在不同群可以有不同叫法）
    CREATE TABLE IF NOT EXISTS people (
      qq TEXT PRIMARY KEY,
      name TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_aliases (
      qq TEXT NOT NULL,
      alias TEXT NOT NULL,
      conv_id TEXT,
      seen_count INTEGER NOT NULL DEFAULT 1,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (qq, alias)
    );
    -- 证据流水：每次「谁说了什么」都留一条，facts 的当前值由它投票算出来
    CREATE TABLE IF NOT EXISTS fact_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      speaker_qq TEXT,
      conv_id TEXT,
      confidence REAL,
      source TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claims_subject ON fact_claims(subject_id, key, ts DESC);
    -- 疑似同一个人（不同 QQ 号）的线索，等人工确认
    CREATE TABLE IF NOT EXISTS person_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      evidence TEXT,
      score REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      UNIQUE(a, b)
    );

    CREATE TABLE IF NOT EXISTS diary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id TEXT NOT NULL,
      day TEXT NOT NULL,
      summary TEXT NOT NULL,
      mood TEXT,
      highlights TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(conv_id, day)
    );

    CREATE TABLE IF NOT EXISTS conv_state (
      conv_id TEXT PRIMARY KEY,
      persona TEXT,
      affinity REAL NOT NULL DEFAULT 0,
      mood TEXT,
      last_user_at INTEGER,
      last_bot_at INTEGER,
      sleeping_until INTEGER,
      unread INTEGER NOT NULL DEFAULT 0,
      json TEXT
    );

    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      conv_id TEXT,
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      latency_ms INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kv (
      k TEXT PRIMARY KEY,
      v TEXT
    );
  `);

  migrate();
  migrateFactsToPeople();

  // FTS5：trigram 对中文最友好（支持子串匹配）；不可用则退回 unicode61；再不行则禁用
  for (const tok of ['trigram', 'unicode61']) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='${tok}');`
      );
      ftsMode = tok;
      break;
    } catch {
      /* try next */
    }
  }
  if (ftsMode === 'none') log.warn('FTS5 不可用，搜索退化为 LIKE');
  else log.info(`全文索引: ${ftsMode}`);

  if (ftsMode !== 'none') {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
    try {
      db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`);
    } catch {
      /* 首次为空表时可能报错，忽略 */
    }
  }
  return db;
}

export function closeStore() {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

/* ---------------- 迁移：老库无损升级 ---------------- */

function ensureColumn(table, name, decl) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
}

function migrate() {
  // 情绪：心情值 + 几根情绪 + 理由 + 置信度 + 「一次变化只说一次」的待播报
  ensureColumn('conv_state', 'mood_score', 'REAL');
  ensureColumn('conv_state', 'mood_json', 'TEXT');
  ensureColumn('conv_state', 'mood_reason', 'TEXT');
  ensureColumn('conv_state', 'mood_conf', 'REAL');
  ensureColumn('conv_state', 'mood_updated', 'INTEGER');
  ensureColumn('conv_state', 'mood_note', 'TEXT');
  ensureColumn('conv_state', 'mood_note_at', 'INTEGER');
  // 事实历史：同键变化时留上一版，不丢
  ensureColumn('facts', 'prev_value', 'TEXT');
  ensureColumn('facts', 'superseded_at', 'INTEGER');
  ensureColumn('facts', 'last_used_at', 'INTEGER');

  db.exec(`
    CREATE TABLE IF NOT EXISTS mood_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      delta REAL,
      score REAL,
      moods TEXT,
      reason TEXT,
      confidence REAL,
      source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mood_log_conv ON mood_log(conv_id, ts DESC);

    CREATE TABLE IF NOT EXISTS wake_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      roll REAL,
      hit REAL,
      fired INTEGER NOT NULL DEFAULT 0,
      dry INTEGER NOT NULL DEFAULT 0,
      kind TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wake_log_ts ON wake_log(ts DESC);
  `);
}

/* ---------------- messages ---------------- */

export function addMessage({ convId, role, senderId = null, senderName = null, text = '', kind = 'text', meta = null, ts = Date.now() }) {
  const d = getDb();
  const st = d.prepare(
    `INSERT INTO messages (conv_id, ts, role, sender_id, sender_name, text, kind, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = st.run(String(convId), ts, role, senderId != null ? String(senderId) : null, senderName, text, kind, meta ? JSON.stringify(meta) : null);
  return Number(info.lastInsertRowid);
}

export function recentMessages(convId, limit = 30) {
  const d = getDb();
  // 按时间排而不是只按自增 id：导入旧记录后，id 顺序不再等于时间顺序
  const rows = d
    .prepare(`SELECT * FROM messages WHERE conv_id = ? ORDER BY ts DESC, id DESC LIMIT ?`)
    .all(String(convId), Number(limit));
  return rows.reverse().map(mapMessage);
}

export function messagesSince(convId, sinceId, limit = 200) {
  const d = getDb();
  return d
    .prepare(`SELECT * FROM messages WHERE conv_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
    .all(String(convId), Number(sinceId), Number(limit))
    .map(mapMessage);
}

export function deleteMessage(id) {
  getDb().prepare('DELETE FROM messages WHERE id = ?').run(Number(id));
}

function mapMessage(r) {
  return {
    id: Number(r.id),
    convId: r.conv_id,
    ts: Number(r.ts),
    role: r.role,
    senderId: r.sender_id,
    senderName: r.sender_name,
    text: r.text,
    kind: r.kind,
    meta: r.meta ? safeParse(r.meta) : null,
  };
}

export function searchMessages(query, limit = 40, convId = null) {
  const d = getDb();
  const q = String(query || '').trim();
  if (!q) return [];
  const conv = convId ? String(convId) : null;
  if (ftsMode === 'trigram' && q.length >= 2) {
    try {
      return d
        .prepare(
          `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH ?${conv ? ' AND m.conv_id = ?' : ''} ORDER BY rank LIMIT ?`
        )
        .all(`"${q.replace(/"/g, '""')}"`, ...(conv ? [conv] : []), Number(limit))
        .map(mapMessage);
    } catch {
      /* fall through to LIKE */
    }
  }
  if (ftsMode === 'unicode61' && q.length >= 1 && !/[\u3400-\u9fff]/.test(q)) {
    try {
      return d
        .prepare(
          `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH ?${conv ? ' AND m.conv_id = ?' : ''} ORDER BY rank LIMIT ?`
        )
        .all(q.replace(/[^\w\s]/g, ' ').trim() || q, ...(conv ? [conv] : []), Number(limit))
        .map(mapMessage);
    } catch {
      /* fall through */
    }
  }
  return d
    .prepare(`SELECT * FROM messages WHERE text LIKE ?${conv ? ' AND conv_id = ?' : ''} ORDER BY id DESC LIMIT ?`)
    .all(`%${q}%`, ...(conv ? [conv] : []), Number(limit))
    .map(mapMessage);
}

/**
 * 直接传 FTS5 MATCH 表达式（调用方负责拼 OR / 引号）。召回用。
 * trigram 下中文至少要 3 个字才能命中，所以这里只负责执行，不做分词。
 */
export function searchMessagesByMatch(match, limit = 20, convId = null) {
  if (!match || ftsMode !== 'trigram') return [];
  const conv = convId ? String(convId) : null;
  try {
    return getDb()
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ?${conv ? ' AND m.conv_id = ?' : ''} ORDER BY rank LIMIT ?`
      )
      .all(String(match), ...(conv ? [conv] : []), Number(limit))
      .map(mapMessage);
  } catch {
    return [];
  }
}

/* ---------------- 人（身份） ---------------- */

export function ownerQq() {
  return String(loadConfig().access?.ownerQQ || 'owner');
}

/** 记一个人和他的名字：QQ 是身份，名字只是别名；同昵称出现在别的 QQ 上会留一条待确认线索 */
export function touchPerson({ qq, name, convId = null, ts = Date.now() }) {
  const id = String(qq || '').trim();
  if (!id) return null;
  const nm = String(name || '').trim().slice(0, 40);
  const d = getDb();
  d.prepare(
    `INSERT INTO people (qq, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(qq) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE people.name END,
       last_seen = MAX(people.last_seen, excluded.last_seen)`
  ).run(id, nm, ts, ts);
  if (nm) {
    d.prepare(
      `INSERT INTO person_aliases (qq, alias, conv_id, seen_count, last_seen) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(qq, alias) DO UPDATE SET seen_count = seen_count + 1, last_seen = MAX(last_seen, excluded.last_seen)`
    ).run(id, nm, convId, ts);
    const others = d.prepare('SELECT DISTINCT qq FROM person_aliases WHERE alias = ? AND qq <> ? LIMIT 3').all(nm, id);
    for (const o of others) addPersonLink(id, o.qq, `同昵称「${nm}」`, 0.5);
  }
  return id;
}

export function addPersonLink(a, b, evidence, score = 0.5) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y || x === y) return null;
  const [p, q] = x < y ? [x, y] : [y, x];
  getDb()
    .prepare(
      `INSERT INTO person_links (a, b, evidence, score, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(a, b) DO UPDATE SET evidence = excluded.evidence, score = MAX(person_links.score, excluded.score)`
    )
    .run(p, q, String(evidence || ''), Number(score) || 0.5, Date.now());
  return { a: p, b: q };
}

export function listPersonLinks(status = 'pending') {
  return getDb()
    .prepare(
      `SELECT l.*, pa.name AS a_name, pb.name AS b_name FROM person_links l
       LEFT JOIN people pa ON pa.qq = l.a LEFT JOIN people pb ON pb.qq = l.b
       WHERE l.status = ? ORDER BY l.score DESC, l.created_at DESC LIMIT 50`
    )
    .all(String(status))
    .map((r) => ({
      id: Number(r.id),
      a: r.a,
      b: r.b,
      aName: r.a_name || r.a,
      bName: r.b_name || r.b,
      evidence: r.evidence,
      score: Number(r.score),
      status: r.status,
      createdAt: Number(r.created_at),
    }));
}

export function setPersonLinkStatus(id, status) {
  const ok = ['pending', 'confirmed', 'rejected'];
  const s = ok.includes(status) ? status : 'pending';
  return Number(getDb().prepare('UPDATE person_links SET status = ? WHERE id = ?').run(s, Number(id)).changes || 0);
}

export function listPeople() {
  return getDb()
    .prepare(
      `SELECT p.qq, p.name, p.first_seen, p.last_seen,
         (SELECT COUNT(*) FROM facts f WHERE f.subject_id = p.qq) AS facts,
         (SELECT COUNT(*) FROM person_aliases a WHERE a.qq = p.qq) AS aliases
       FROM people p ORDER BY p.last_seen DESC LIMIT 200`
    )
    .all()
    .map((r) => ({
      qq: r.qq,
      name: r.name || r.qq,
      firstSeen: Number(r.first_seen),
      lastSeen: Number(r.last_seen),
      facts: Number(r.facts),
      aliases: Number(r.aliases),
    }));
}

export function resolvePersonByName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const row = getDb()
    .prepare('SELECT qq FROM person_aliases WHERE alias = ? ORDER BY seen_count DESC, last_seen DESC LIMIT 1')
    .get(n);
  return row ? String(row.qq) : null;
}

export function resolvePersonBySender(convId, senderName) {
  const n = String(senderName || '').trim();
  if (!n) return null;
  const row = getDb()
    .prepare('SELECT sender_id FROM messages WHERE conv_id = ? AND sender_name = ? ORDER BY ts DESC LIMIT 1')
    .get(String(convId), n);
  return row && row.sender_id ? String(row.sender_id) : null;
}

/* ---------------- facts ---------------- */

export function addClaim({ subjectId, key, value, confidence = 0.8, speakerQq = null, convId = null, source = null, ts = Date.now() }) {
  getDb()
    .prepare(
      `INSERT INTO fact_claims (subject_id, key, value, speaker_qq, conv_id, confidence, source, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(subjectId),
      String(key),
      String(value),
      speakerQq == null ? null : String(speakerQq),
      convId == null ? null : String(convId),
      Number(confidence),
      source,
      Number(ts)
    );
}

/** 一条证据的权重：置信度 × 时间衰减（30 天半衰）；本人说的算双倍 */
function claimWeight(c, subjectId) {
  const days = Math.max(0, (Date.now() - Number(c.ts)) / 86400000);
  const recency = Math.pow(0.5, days / 30);
  const conf = Number(c.confidence) || 0.6;
  const self = c.speaker_qq && String(c.speaker_qq) === String(subjectId) ? 2 : 1;
  return conf * recency * self;
}

/** 当前值怎么定：有本人（或人工编辑）的陈述 → 以最新那条为准（一票否决）；否则按加权票数 */
function pickWinner(subjectId, key) {
  const claims = getDb()
    .prepare('SELECT * FROM fact_claims WHERE subject_id = ? AND key = ? ORDER BY ts DESC, id DESC')
    .all(String(subjectId), String(key));
  if (!claims.length) return null;
  // 本人自述 / 人工编辑：始终压过旁人的说法（取最新一条本人陈述）
  const selfClaims = claims.filter(
    (c) => (c.speaker_qq && String(c.speaker_qq) === String(subjectId)) || String(c.source || '') === 'manual'
  );
  if (selfClaims.length) {
    const c = selfClaims[0];
    return { value: c.value, confidence: Math.max(Number(c.confidence) || 0.8, 0.95), votes: claims.length, why: '本人陈述' };
  }
  const groups = new Map();
  for (const c of claims) {
    const g = groups.get(c.value) || { value: c.value, weight: 0, latest: 0, conf: 0 };
    g.weight += claimWeight(c, subjectId);
    g.latest = Math.max(g.latest, Number(c.ts));
    g.conf = Math.max(g.conf, Number(c.confidence) || 0);
    groups.set(c.value, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.weight - a.weight || b.latest - a.latest);
  return { value: sorted[0].value, confidence: sorted[0].conf || 0.7, votes: claims.length, why: '票数' };
}

/**
 * 按证据重建 facts（修复迁移/合并后的不一致；保留置顶、使用记录）
 */
export function rebuildFacts() {
  const d = getDb();
  const prevRows = d.prepare('SELECT * FROM facts').all();
  const preserve = new Map(prevRows.map((r) => [r.subject_id + '|' + r.key, r]));
  const groups = d.prepare('SELECT DISTINCT subject_id, key FROM fact_claims').all();
  let n = 0;
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM facts').run();
    for (const g of groups) {
      const win = pickWinner(g.subject_id, g.key);
      if (!win) continue;
      const old = preserve.get(g.subject_id + '|' + g.key);
      const last = d
        .prepare('SELECT source, ts FROM fact_claims WHERE subject_id = ? AND key = ? ORDER BY ts DESC, id DESC LIMIT 1')
        .get(g.subject_id, g.key);
      const name = old?.subject || d.prepare('SELECT name FROM people WHERE qq = ?').get(g.subject_id)?.name || g.subject_id;
      d.prepare(
        `INSERT INTO facts (subject_id, subject, key, value, confidence, source, created_at, updated_at, pinned, prev_value, superseded_at, last_used_at, votes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        g.subject_id,
        name,
        g.key,
        win.value,
        Number(win.confidence) || 0.7,
        last?.source || null,
        old?.created_at || last?.ts || Date.now(),
        last?.ts || Date.now(),
        old?.pinned || 0,
        old?.prev_value || null,
        old?.superseded_at || null,
        old?.last_used_at || null,
        Number(win.votes) || 1
      );
      n++;
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return n;
}

/**
 * 写入一条事实：先记证据（claim），再由证据算出当前值。
 * @param {string} subjectId  这个事实是关于谁的（QQ 号）
 * @param {string} [speakerQq] 这句话是谁说的（等于 subjectId 就是本人自述，会被优先采信）
 */
export function upsertFact({
  subjectId,
  subject = '',
  key,
  value,
  confidence = 0.8,
  source = null,
  speakerQq = null,
  convId = null,
  pinned = 0,
  ts = Date.now(),
}) {
  const sid = String(subjectId || '').trim() || 'unknown:' + String(subject || '对方').trim();
  const k = String(key || '').trim();
  const v = String(value || '').trim();
  if (!k || !v) return null;
  addClaim({ subjectId: sid, key: k, value: v, confidence, speakerQq, convId, source, ts });
  const win = pickWinner(sid, k) || { value: v, confidence: Number(confidence) || 0.7, votes: 1 };
  const d = getDb();
  const prev = d.prepare('SELECT value FROM facts WHERE subject_id = ? AND key = ?').get(sid, k);
  d.prepare(
      `INSERT INTO facts (subject_id, subject, key, value, confidence, source, created_at, updated_at, pinned, votes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject_id, key) DO UPDATE SET
         value = excluded.value,
         confidence = excluded.confidence,
         source = excluded.source,
         subject = CASE WHEN excluded.subject <> '' THEN excluded.subject ELSE facts.subject END,
         pinned = MAX(facts.pinned, excluded.pinned),
         updated_at = excluded.updated_at,
         votes = excluded.votes,
         prev_value = CASE WHEN facts.value <> excluded.value THEN facts.value ELSE facts.prev_value END,
         superseded_at = CASE WHEN facts.value <> excluded.value THEN excluded.updated_at ELSE facts.superseded_at END`
    )
    .run(sid, String(subject || '').slice(0, 40), k, win.value, Number(win.confidence) || 0.7, source, ts, ts, pinned ? 1 : 0, Number(win.votes) || 1);
  try {
    if (!prev) {
      recordFactEvent({ convId: convId || '', subject: sid, key: k, value: win.value, op: 'add', confidence: win.confidence, source, ts });
    } else if (String(prev.value) !== String(win.value)) {
      recordFactEvent({ convId: convId || '', subject: sid, key: k, value: win.value, prevValue: prev.value, op: 'update', confidence: win.confidence, source, ts });
    }
  } catch {
    /* 流水失败绝不能影响事实本身 */
  }
  return { subjectId: sid, key: k, value: win.value, changed: !prev || String(prev.value) !== String(win.value), votes: win.votes };
}

/** 事实流水：append-only，回答「以前是不是这样」「什么时候改的」 */
export function recordFactEvent({ convId, subject, key, value, prevValue = null, op = 'add', confidence = null, source = null, ts = Date.now() }) {
  getDb()
    .prepare(
      `INSERT INTO fact_events (conv_id, subject, key, value, prev_value, op, confidence, source, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(convId),
      String(subject),
      String(key),
      String(value),
      prevValue == null ? null : String(prevValue),
      String(op),
      confidence == null ? null : Number(confidence),
      source,
      Number(ts)
    );
  return true;
}

export function listFactEvents(convId, limit = 50) {
  return getDb()
    .prepare('SELECT * FROM fact_events WHERE conv_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
    .all(String(convId), Number(limit))
    .map((r) => ({
      id: Number(r.id),
      subject: r.subject,
      key: r.key,
      value: r.value,
      prevValue: r.prev_value || null,
      op: r.op,
      confidence: r.confidence == null ? null : Number(r.confidence),
      source: r.source,
      ts: Number(r.ts),
    }));
}

/** 记忆页要看的量（全局，不拉全表） */
/** 钉住的事实：不管当前是谁在说话，都要带上 */
export function listPinnedFacts(limit = 20) {
  return getDb()
    .prepare('SELECT * FROM facts WHERE pinned = 1 ORDER BY updated_at DESC LIMIT ?')
    .all(Number(limit))
    .map(mapFact);
}

export function factStats() {
  const d = getDb();
  const total = Number(d.prepare('SELECT COUNT(*) n FROM facts').get().n) || 0;
  const since = Date.now() - 7 * 86400000;
  const new7d = Number(d.prepare('SELECT COUNT(*) n FROM facts WHERE created_at > ?').get(since).n) || 0;
  const events = Number(d.prepare('SELECT COUNT(*) n FROM fact_events').get().n) || 0;
  const claims = Number(d.prepare('SELECT COUNT(*) n FROM fact_claims').get().n) || 0;
  const people = Number(d.prepare('SELECT COUNT(*) n FROM people').get().n) || 0;
  return { total, new7d, events, claims, people };
}

function mapFact(r) {
  return {
    id: Number(r.id),
    subjectId: r.subject_id,
    subject: r.subject || r.subject_id,
    key: r.key,
    value: r.value,
    confidence: Number(r.confidence),
    source: r.source,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    pinned: !!r.pinned,
    prevValue: r.prev_value || null,
    supersededAt: r.superseded_at ? Number(r.superseded_at) : null,
    lastUsedAt: r.last_used_at ? Number(r.last_used_at) : null,
    votes: Number(r.votes || 1),
  };
}

/** 全局事实；给了 subjectIds 就只取这些人的（召回用） */
export function listFacts({ subjectIds = null, limit = 5000 } = {}) {
  const d = getDb();
  const lim = Number(limit) || 5000;
  let rows;
  if (Array.isArray(subjectIds) && subjectIds.length) {
    const ids = subjectIds.map(String);
    const ph = ids.map(() => '?').join(',');
    rows = d.prepare(`SELECT * FROM facts WHERE subject_id IN (${ph}) ORDER BY pinned DESC, updated_at DESC LIMIT ?`).all(...ids, lim);
  } else {
    rows = d.prepare('SELECT * FROM facts ORDER BY pinned DESC, updated_at DESC LIMIT ?').all(lim);
  }
  return rows.map(mapFact);
}

/** 把 from 这个身份合并进 to（人工确认「同一个人」后调用）：证据重新投票，别名并过去 */
export function mergePeople(from, to) {
  const src = String(from || '').trim();
  const dst = String(to || '').trim();
  if (!src || !dst || src === dst) return { merged: 0 };
  const d = getDb();
  const claims = d.prepare('SELECT * FROM fact_claims WHERE subject_id = ?').all(src);
  const keys = [...new Set(claims.map((c) => c.key))];
  d.exec('BEGIN');
  try {
    d.prepare('UPDATE fact_claims SET subject_id = ? WHERE subject_id = ?').run(dst, src);
    const name = d.prepare('SELECT name FROM people WHERE qq = ?').get(dst)?.name || dst;
    for (const k of keys) {
      const win = pickWinner(dst, k);
      if (!win) continue;
      d.prepare(
        `INSERT INTO facts (subject_id, subject, key, value, confidence, source, created_at, updated_at, pinned, votes)
         VALUES (?, ?, ?, ?, ?, 'merge', ?, ?, 0, ?)
         ON CONFLICT(subject_id, key) DO UPDATE SET
           value = excluded.value, confidence = excluded.confidence, updated_at = excluded.updated_at, votes = excluded.votes`
      ).run(dst, name, k, win.value, Number(win.confidence) || 0.7, Date.now(), Date.now(), Number(win.votes) || 1);
    }
    d.prepare('DELETE FROM facts WHERE subject_id = ?').run(src);
    d.prepare('UPDATE OR IGNORE person_aliases SET qq = ? WHERE qq = ?').run(dst, src);
    d.prepare('DELETE FROM person_aliases WHERE qq = ?').run(src);
    d.prepare('DELETE FROM people WHERE qq = ?').run(src);
    d.prepare("UPDATE person_links SET status = 'confirmed' WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)").run(src, dst, dst, src);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return { merged: claims.length, keys: keys.length };
}

export function deleteFact(id) {
  const d = getDb();
  const row = d.prepare('SELECT subject_id, key FROM facts WHERE id = ?').get(Number(id));
  if (row) d.prepare('DELETE FROM fact_claims WHERE subject_id = ? AND key = ?').run(row.subject_id, row.key);
  d.prepare('DELETE FROM facts WHERE id = ?').run(Number(id));
}

/** 把选中的几条改到另一个人名下（subjectId 是 QQ 号）；同键冲突时按证据重算 */
export function renameFacts(ids, subjectId, subjectName = '') {
  const d = getDb();
  const sid = String(subjectId || '').trim();
  if (!sid) return { renamed: 0, merged: 0, total: 0 };
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isFinite(n));
  const nm = String(subjectName || '').slice(0, 40);
  let renamed = 0;
  let merged = 0;
  let skipped = 0;
  d.exec('BEGIN');
  try {
    for (const id of list) {
      const cur = d.prepare('SELECT * FROM facts WHERE id = ?').get(id);
      if (!cur) continue;
      if (cur.subject_id === sid) {
        skipped++;
        continue;
      }
      d.prepare('UPDATE fact_claims SET subject_id = ? WHERE subject_id = ? AND key = ?').run(sid, cur.subject_id, cur.key);
      d.prepare('DELETE FROM facts WHERE id = ?').run(id);
      const win = pickWinner(sid, cur.key) || { value: cur.value, confidence: cur.confidence, votes: 1 };
      const hit = d.prepare('SELECT id FROM facts WHERE subject_id = ? AND key = ?').get(sid, cur.key);
      if (hit) {
        d.prepare('UPDATE facts SET value = ?, confidence = ?, updated_at = ?, votes = ? WHERE id = ?').run(
          win.value,
          Number(win.confidence) || 0.7,
          Date.now(),
          Number(win.votes) || 1,
          hit.id
        );
        merged++;
      } else {
        d.prepare(
          `INSERT INTO facts (subject_id, subject, key, value, confidence, source, created_at, updated_at, pinned, votes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(sid, nm || sid, cur.key, win.value, Number(win.confidence) || 0.7, cur.source, cur.created_at, Date.now(), cur.pinned, Number(win.votes) || 1);
        renamed++;
      }
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return { renamed, merged, skipped, total: list.length };
}

/** 按 id 列表删除（连带删掉证据，避免下次又被抽回来） */
export function deleteFacts(ids) {
  const d = getDb();
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isFinite(n));
  if (!list.length) return 0;
  let n = 0;
  d.exec('BEGIN');
  try {
    for (const id of list) {
      const row = d.prepare('SELECT subject_id, key FROM facts WHERE id = ?').get(id);
      if (!row) continue;
      d.prepare('DELETE FROM fact_claims WHERE subject_id = ? AND key = ?').run(row.subject_id, row.key);
      n += Number(d.prepare('DELETE FROM facts WHERE id = ?').run(id).changes || 0);
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return n;
}

/** 手工改一条：写入一条「人工」证据（权重最高），再按证据重算 */
export function updateFact(id, { key, value, confidence, pinned, subject, subjectId }) {
  const d = getDb();
  const cur = d.prepare('SELECT * FROM facts WHERE id = ?').get(Number(id));
  if (!cur) throw new Error('记忆条目不存在');
  const nextKey = String(key ?? cur.key).trim().slice(0, 40);
  const nextSid = String(subjectId ?? cur.subject_id);
  const nextSubject = String(subject ?? cur.subject).slice(0, 40);
  const nextValue = String(value ?? cur.value);
  if (nextKey !== cur.key || nextSid !== cur.subject_id) {
    d.prepare('UPDATE fact_claims SET subject_id = ?, key = ? WHERE subject_id = ? AND key = ?').run(nextSid, nextKey, cur.subject_id, cur.key);
  }
  addClaim({ subjectId: nextSid, key: nextKey, value: nextValue, confidence: confidence ?? 1, speakerQq: nextSid, source: 'manual' });
  const win = pickWinner(nextSid, nextKey) || { value: nextValue, confidence: 1, votes: 1 };
  const hit = d.prepare('SELECT id FROM facts WHERE subject_id = ? AND key = ? AND id <> ?').get(nextSid, nextKey, Number(id));
  if (hit) {
    d.prepare('UPDATE facts SET value = ?, confidence = ?, pinned = ?, updated_at = ?, votes = ? WHERE id = ?').run(
      win.value,
      Number(win.confidence) || 1,
      pinned == null ? cur.pinned : pinned ? 1 : 0,
      Date.now(),
      Number(win.votes) || 1,
      hit.id
    );
    d.prepare('DELETE FROM facts WHERE id = ?').run(Number(id));
    return { merged: true, into: hit.id, subjectId: nextSid, key: nextKey };
  }
  d.prepare('UPDATE facts SET subject_id = ?, subject = ?, key = ?, value = ?, confidence = ?, pinned = ?, updated_at = ?, votes = ? WHERE id = ?').run(
    nextSid,
    nextSubject,
    nextKey,
    win.value,
    Number(win.confidence) || 1,
    pinned == null ? cur.pinned : pinned ? 1 : 0,
    Date.now(),
    Number(win.votes) || 1,
    Number(id)
  );
  return { merged: false, subjectId: nextSid, key: nextKey };
}

/* ---------------- diary ---------------- */

export function upsertDiary({ convId, day, summary, mood = null, highlights = null }) {
  getDb()
    .prepare(
      `INSERT INTO diary (conv_id, day, summary, mood, highlights, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conv_id, day) DO UPDATE SET summary=excluded.summary, mood=excluded.mood, highlights=excluded.highlights`
    )
    .run(String(convId), day, summary, mood, highlights ? JSON.stringify(highlights) : null, Date.now());
}

export function listDiary(convId, limit = 60) {
  return getDb()
    .prepare(`SELECT * FROM diary WHERE conv_id = ? ORDER BY day DESC LIMIT ?`)
    .all(String(convId), Number(limit))
    .map((r) => ({
      id: Number(r.id),
      day: r.day,
      summary: r.summary,
      mood: r.mood,
      highlights: r.highlights ? safeParse(r.highlights) : null,
    }));
}

export function deleteDiary(id) {
  getDb().prepare('DELETE FROM diary WHERE id = ?').run(Number(id));
}

/* ---------------- conv state ---------------- */

export function getConvState(convId) {
  const row = getDb().prepare('SELECT * FROM conv_state WHERE conv_id = ?').get(String(convId));
  if (!row) return null;
  return {
    convId: row.conv_id,
    persona: row.persona,
    affinity: Number(row.affinity),
    mood: row.mood,
    moodScore: row.mood_score == null ? null : Number(row.mood_score),
    moods: row.mood_json ? safeParse(row.mood_json) : null,
    moodReason: row.mood_reason || '',
    moodConf: row.mood_conf == null ? null : Number(row.mood_conf),
    moodUpdated: row.mood_updated ? Number(row.mood_updated) : null,
    moodNote: row.mood_note || '',
    moodNoteAt: row.mood_note_at ? Number(row.mood_note_at) : null,
    lastUserAt: row.last_user_at ? Number(row.last_user_at) : null,
    lastBotAt: row.last_bot_at ? Number(row.last_bot_at) : null,
    sleepingUntil: row.sleeping_until ? Number(row.sleeping_until) : null,
    unread: Number(row.unread || 0),
    json: row.json ? safeParse(row.json) : null,
  };
}

export function setConvState(convId, patch) {
  const d = getDb();
  const cur = getConvState(convId) || {
    convId: String(convId),
    persona: null,
    affinity: 0,
    mood: null,
    moodScore: null,
    moods: null,
    moodReason: '',
    moodConf: null,
    moodUpdated: null,
    moodNote: '',
    moodNoteAt: null,
    lastUserAt: null,
    lastBotAt: null,
    sleepingUntil: null,
    unread: 0,
    json: null,
  };
  const next = { ...cur, ...patch };
  d.prepare(
    `INSERT INTO conv_state (
       conv_id, persona, affinity, mood, last_user_at, last_bot_at, sleeping_until, unread, json,
       mood_score, mood_json, mood_reason, mood_conf, mood_updated, mood_note, mood_note_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conv_id) DO UPDATE SET
       persona=excluded.persona, affinity=excluded.affinity, mood=excluded.mood,
       last_user_at=excluded.last_user_at, last_bot_at=excluded.last_bot_at,
       sleeping_until=excluded.sleeping_until, unread=excluded.unread, json=excluded.json,
       mood_score=excluded.mood_score, mood_json=excluded.mood_json, mood_reason=excluded.mood_reason,
       mood_conf=excluded.mood_conf, mood_updated=excluded.mood_updated,
       mood_note=excluded.mood_note, mood_note_at=excluded.mood_note_at`
  ).run(
    String(convId),
    next.persona,
    Number(next.affinity) || 0,
    next.mood,
    next.lastUserAt,
    next.lastBotAt,
    next.sleepingUntil,
    Number(next.unread) || 0,
    next.json ? JSON.stringify(next.json) : null,
    next.moodScore == null ? null : Number(next.moodScore),
    next.moods ? JSON.stringify(next.moods) : null,
    next.moodReason || '',
    next.moodConf == null ? null : Number(next.moodConf),
    next.moodUpdated || null,
    next.moodNote || '',
    next.moodNoteAt || null
  );
  return next;
}

export function listConvs() {
  return getDb()
    .prepare(
      `SELECT conv_id, MAX(ts) AS last_ts, COUNT(*) AS n FROM messages GROUP BY conv_id ORDER BY last_ts DESC`
    )
    .all()
    .map((r) => ({ convId: r.conv_id, lastTs: Number(r.last_ts), count: Number(r.n) }));
}

/* ---------------- usage ---------------- */

export function recordUsage({ convId = null, provider, model, promptTokens = 0, completionTokens = 0, latencyMs = 0 }) {
  getDb()
    .prepare(
      `INSERT INTO usage (ts, conv_id, provider, model, prompt_tokens, completion_tokens, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(Date.now(), convId, provider, model, promptTokens, completionTokens, latencyMs);
}

export function usageSummary(hours = 24) {
  const since = Date.now() - hours * 3600 * 1000;
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS calls, SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct,
              AVG(latency_ms) AS avg_ms
       FROM usage WHERE ts >= ?`
    )
    .get(since);
}

/* ---------------- kv ---------------- */

export function kvGet(k, fallback = null) {
  const row = getDb().prepare('SELECT v FROM kv WHERE k = ?').get(String(k));
  if (!row) return fallback;
  return safeParse(row.v);
}

export function kvSet(k, v) {
  getDb()
    .prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
    .run(String(k), JSON.stringify(v));
}

/* ---------------- 情绪时间线 ---------------- */

export function insertMoodLog({ convId, delta = 0, score = null, moods = null, reason = '', confidence = null, source = 'heuristic' }) {
  getDb()
    .prepare(
      `INSERT INTO mood_log (conv_id, ts, delta, score, moods, reason, confidence, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(String(convId), Date.now(), Number(delta) || 0, score == null ? null : Number(score), moods ? JSON.stringify(moods) : null, String(reason || ''), confidence == null ? null : Number(confidence), source);
}

export function recentMoodLog(convId, limit = 40) {
  return getDb()
    .prepare(`SELECT * FROM mood_log WHERE conv_id = ? ORDER BY ts DESC LIMIT ?`)
    .all(String(convId), Number(limit))
    .map((r) => ({
      ts: Number(r.ts),
      delta: Number(r.delta),
      score: r.score == null ? null : Number(r.score),
      moods: r.moods ? safeParse(r.moods) : null,
      reason: r.reason || '',
      confidence: r.confidence == null ? null : Number(r.confidence),
      source: r.source,
    }));
}

/* ---------------- 主动搭话记录 ---------------- */

export function insertWakeLog({ convId, roll = null, hit = null, fired = false, dry = true, kind = 'tick', detail = '' }) {
  getDb()
    .prepare(
      `INSERT INTO wake_log (conv_id, ts, roll, hit, fired, dry, kind, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(String(convId), Date.now(), roll == null ? null : Number(roll), hit == null ? null : Number(hit), fired ? 1 : 0, dry ? 1 : 0, String(kind), String(detail || ''));
}

export function recentWakeLog(limit = 60) {
  return getDb()
    .prepare(`SELECT * FROM wake_log ORDER BY ts DESC LIMIT ?`)
    .all(Number(limit))
    .map((r) => ({
      id: Number(r.id),
      convId: r.conv_id,
      ts: Number(r.ts),
      roll: r.roll == null ? null : Number(r.roll),
      hit: r.hit == null ? null : Number(r.hit),
      fired: !!r.fired,
      dry: !!r.dry,
      kind: r.kind,
      detail: r.detail || '',
    }));
}

/** 记录哪几条 fact 刚被用到（鲜活度之外的「用进废退」参考） */
export function touchFacts(ids) {
  if (!ids || !ids.length) return;
  const stmt = getDb().prepare('UPDATE facts SET last_used_at = ? WHERE id = ?');
  const now = Date.now();
  for (const id of ids) stmt.run(now, Number(id));
}

export function factCount() {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM facts').get();
  return Number(row?.n || 0);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
