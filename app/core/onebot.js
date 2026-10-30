// OneBot v11 客户端：WS 收事件（自动重连），HTTP 主动作。
// 协议无关：napcat / snowluma / lagrange 都走这套，换端只改 config.onebot。
import { EventEmitter } from 'node:events';
import { logger } from './log.js';
const log = logger('onebot');

export class OneBot extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.ws = null;
    this.connected = false;
    this.selfId = Number(cfg.selfId) || 0;
    this.selfName = '';
    this.lastEventAt = 0;
    this.lastHeartbeatAt = 0;
    this.attempt = 0;
    this.stopped = true;
    this._timer = null;
    this._lastError = '';
  }

  get state() {
    return {
      connected: this.connected,
      selfId: this.selfId,
      selfName: this.selfName,
      wsUrl: this.cfg.wsUrl,
      httpUrl: this.cfg.httpUrl,
      lastEventAt: this.lastEventAt,
      lastError: this._lastError,
    };
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this._timer);
    this._timer = null;
    try {
      this.ws?.close(1000, 'bye');
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.connected = false;
  }

  _connect() {
    if (this.stopped) return;
    if (typeof WebSocket === 'undefined') {
      this._lastError = '运行时缺少 WebSocket（需要 Node 22+）';
      log.error(this._lastError);
      return;
    }
    let url;
    try {
      const u = new URL(this.cfg.wsUrl);
      if (this.cfg.accessToken) u.searchParams.set('access_token', this.cfg.accessToken);
      url = u.toString();
    } catch {
      this._lastError = `wsUrl 不合法: ${this.cfg.wsUrl}`;
      log.error(this._lastError);
      this._scheduleReconnect();
      return;
    }

    log.info(`连接 OneBot WS: ${url.replace(/access_token=[^&]+/, 'access_token=***')}`);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._lastError = err.message;
      log.error('WS 构造失败', err.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.attempt = 0;
      this._lastError = '';
      log.info('OneBot 已连接');
      this.emit('connected');
      this.call('get_login_info', {}, { timeout: 8000 })
        .then((d) => {
          if (d?.user_id) {
            this.selfId = Number(d.user_id);
            this.selfName = d.nickname || '';
            this.emit('self', { selfId: this.selfId, nickname: this.selfName });
          }
        })
        .catch((e) => log.warn('get_login_info 失败', e.message));
    });

    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let j;
      try {
        j = JSON.parse(raw);
      } catch {
        return;
      }
      this.lastEventAt = Date.now();
      if (j.post_type === 'meta_event' && j.meta_event_type === 'heartbeat') {
        this.lastHeartbeatAt = Date.now();
      }
      if (j.post_type === 'meta_event' && j.meta_event_type === 'lifecycle') {
        if (j.self_id) this.selfId = Number(j.self_id);
      }
      this.emit('event', j);
    });

    ws.addEventListener('close', (ev) => {
      this.connected = false;
      this.emit('disconnected', { code: ev.code, reason: ev.reason });
      if (!this.stopped) {
        this._lastError = `连接关闭 code=${ev.code}`;
        log.warn(`OneBot 断开 (code=${ev.code})，准备重连`);
        this._scheduleReconnect();
      }
    });

    ws.addEventListener('error', () => {
      // 具体信息由 close 事件承担，这里只记录
      this._lastError = 'WS error';
    });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this._timer);
    const { reconnectMinMs = 1000, reconnectMaxMs = 30000 } = this.cfg;
    const base = Math.min(reconnectMaxMs, reconnectMinMs * Math.pow(1.7, this.attempt));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.attempt = Math.min(this.attempt + 1, 12);
    this._timer = setTimeout(() => this._connect(), delay);
    log.debug(`重连将在 ${delay}ms 后`);
  }

  async call(action, params = {}, { timeout = 15000 } = {}) {
    const url = `${this.cfg.httpUrl}/${action}`;
    const headers = { 'content-type': 'application/json' };
    if (this.cfg.accessToken) headers.authorization = `Bearer ${this.cfg.accessToken}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(`${action} 返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      if (j.status === 'failed' || (j.retcode !== 0 && j.retcode !== 1)) {
        throw new Error(`${action} 失败 retcode=${j.retcode}: ${j.wording || j.msg || j.message || ''}`);
      }
      return j.data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`${action} 超时 (${timeout}ms)`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 发消息：conv = "private:123" | "group:456"，message 可以是字符串或段数组 */
  async send(conv, message) {
    const { kind, id } = parseConv(conv);
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = kind === 'group' ? { group_id: Number(id) } : { user_id: Number(id) };
    params.message = message;
    const data = await this.call(action, params);
    return data?.message_id;
  }

  async recall(messageId) {
    return this.call('delete_msg', { message_id: Number(messageId) });
  }

  async poke(conv) {
    const { kind, id } = parseConv(conv);
    if (kind === 'group') return this.call('group_poke', { group_id: Number(id) });
    return this.call('friend_poke', { user_id: Number(id) });
  }

  /** 群/私聊的"正在输入"提示（部分实现不支持，失败静默） */
  async typing(conv) {
    const { kind, id } = parseConv(conv);
    try {
      if (kind === 'group') return await this.call('set_group_typing', { group_id: Number(id) });
      return await this.call('set_input_status', { user_id: Number(id), event_type: 1 });
    } catch {
      return null;
    }
  }
}

export function parseConv(conv) {
  const s = String(conv || '');
  const m = /^(private|group):(-?\d+)$/.exec(s);
  if (m) return { kind: m[1], id: m[2] };
  const c = /^console:([\w.\-]+)$/.exec(s);
  if (c) return { kind: 'console', id: c[1] };
  throw new Error(`会话 id 不合法: ${conv}`);
}

export function convOf(ev) {
  if (ev.message_type === 'group') return `group:${ev.group_id}`;
  return `private:${ev.user_id}`;
}

/** 把 OneBot 消息段数组归一化成 { text, images, faces, ats, replyId, raw } */
export function normalizeMessage(ev) {
  const segs = Array.isArray(ev.message) ? ev.message : [];
  const out = { text: '', images: [], faces: [], ats: [], replyId: null, voice: null, raw: segs };
  for (const s of segs) {
    const t = s.type;
    const d = s.data || {};
    if (t === 'text') out.text += d.text || '';
    else if (t === 'image') out.images.push({ url: d.url || '', file: d.file || '', sub: d.sub_type || '' });
    else if (t === 'face') out.faces.push(d.id);
    else if (t === 'at') out.ats.push(String(d.qq));
    else if (t === 'reply') out.replyId = d.id;
    else if (t === 'record') out.voice = { url: d.url || '', file: d.file || '' };
    else if (t === 'mface') out.images.push({ url: d.url || '', file: '', sub: 'mface', summary: d.summary });
    else if (t === 'json' || t === 'xml') out.text += `[卡片消息:${(d.data || '').slice(0, 80)}]`;
  }
  return out;
}

export function toText(ev) {
  return normalizeMessage(ev).text.trim();
}
