// AI我 控制台前端：原生 ESM，无构建步骤，无第三方依赖。
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const api = {
  async get(path) {
    const r = await fetch(path, { cache: 'no-store' });
    const t = await r.text();
    let d;
    try { d = JSON.parse(t); } catch { throw new Error(t.slice(0, 200)); }
    if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
    return d;
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body ?? {}),
    });
    const t = await r.text();
    let d;
    try { d = JSON.parse(t); } catch { throw new Error(t.slice(0, 200)); }
    if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
    return d;
  },
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtTime = (ts) => {
  if (!ts) return '-';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date().toDateString() === d.toDateString();
  return today ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const fmtDur = (ms) => {
  const s = Math.floor((ms || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${m}m` : `${m}m${s % 60}s`;
};

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2600);
}

/* ---------------- 全局状态 ---------------- */
const S = {
  state: null,
  page: 'dashboard',
  events: [],
  conv: '',
  persona: { list: [], active: '', editing: '', text: '' },
  memory: { tab: 'facts', facts: [], diary: [], search: [] },
  config: null,
  previewing: false,
  llmPresets: null,
};

const CTX = { mounted: null };

async function boot() {
  await refreshState();
  if (!S.persona.list.length) await loadPersonaList();
  await applyTheme();
  const qp = new URLSearchParams(location.search);
  const TITLES = { dashboard: '总览', chat: '聊天', persona: '人格', memory: '记忆', assets: '素材', zone: '空间', access: '权限', slang: '词库', tune: '调参', settings: '设置' };
  const startPage = qp.get('page');
  if (startPage && TITLES[startPage]) {
    S.page = startPage;
    document.querySelectorAll('#nav .nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === startPage));
    $('#page-title').textContent = TITLES[startPage];
  }
  render();
  // 截图/调试用：?noSse=1 时不开长连接，否则无头浏览器不会退出
  if (!new URLSearchParams(location.search).has('noSse')) connectSSE();
  setInterval(refreshState, 5000);
}

async function refreshState() {
  try {
    S.state = await api.get('/api/state');
    paintChrome();
    if (CTX.mounted === 'dashboard') paintDashboardLive();
  } catch (err) {
    $('#pill-gw').textContent = '离线';
  }
}

function paintChrome() {
  const st = S.state;
  if (!st) return;
  const gwOk = !!st.onebot.connected;
  $('#led-gw').className = 'led' + (gwOk ? ' on' : '');
  $('#pill-gw').textContent = gwOk ? `#${st.onebot.selfId || '?'}` : '未连接';
  const llmOk = !!st.llm.keyReady;
  $('#led-llm').className = 'led' + (llmOk ? ' on' : ' warn');
  $('#pill-llm').textContent = st.llm.model || '-';
  $('#pill-up').textContent = fmtDur(st.uptimeMs);
  $('#brand-ver').textContent = 'v' + (st.app?.version || '0.1.0');
  $('#foot-persona').textContent = st.persona.active || '无';
  $('#foot-qq').textContent = gwOk ? `${st.onebot.selfName || ''} ${st.onebot.selfId || ''}`.trim() || '已连接' : '未连接';
  $('#foot-model').textContent = `${st.llm.provider}/${st.llm.model}`;
}

/* ---------------- 路由 ---------------- */
$$('#nav .nav-item').forEach((n) => {
  n.addEventListener('click', () => {
    $$('#nav .nav-item').forEach((x) => x.classList.remove('active'));
    n.classList.add('active');
    S.page = n.dataset.page;
    $('#page-title').textContent = { dashboard: '总览', chat: '聊天', persona: '人格', memory: '记忆', assets: '素材', zone: '空间', access: '权限', slang: '词库', tune: '调参', settings: '设置' }[S.page];
    render();
  });
});

function render() {
  CTX.mounted = S.page;
  const c = $('#content');
  c.innerHTML = '';
  ({ dashboard: pageDashboard, chat: pageChat, persona: pagePersona, memory: pageMemory, assets: pageAssets, zone: pageZone, access: pageAccess, slang: pageSlang, tune: pageTune, settings: pageSettings })[S.page](c);
}

/* ---------------- 总览 ---------------- */
/* ================= 总览：自由画布（绝对定位 + 磁吸） ================= */
/* 位置模型：x 用「列」（0..12，窗口变宽自动缩放用），y/w/h 用像素。
   w 是列宽数，h 是像素高；拖动只改 x/y，右下角只改 w/h。 */
const DASH_COLS = 12;
const DASH_GAP = 12;
const DASH_STEP = 8;   // 细网格吸附步长
const DASH_TOL = 6;    // 磁吸容差（像素）
const DASH_MIN_H = 96;
const DASH_KEY = 'dashLayout.v2';

/* 默认布局（=（2026-10-26）定版：第一行四张状态卡，第二行余额/上下文/快捷，
   第三行最近会话 + 实时事件，右下角当前心情。没有 localStorage 时就用这份。 */
const DASH_DEFAULT_POS = {
  gw: { x: 0, y: 0, w: 3, h: 112 },
  llm: { x: 3, y: 0, w: 3, h: 112 },
  persona: { x: 6, y: 0, w: 3, h: 104 },
  access: { x: 9, y: 0, w: 3, h: 104 },
  bal: { x: 0, y: 124, w: 3, h: 104 },
  ctx: { x: 3, y: 124, w: 3, h: 96 },
  quick: { x: 6, y: 124, w: 6, h: 208 },
  convs: { x: 0, y: 344, w: 6, h: 256 },
  events: { x: 6, y: 344, w: 6, h: 144 },
  mood: { x: 6, y: 496, w: 6, h: 140 },
};

const DASH = { canvas: null, pos: {}, z: 10 };

function dashLayout() {
  try {
    const v = JSON.parse(localStorage.getItem(DASH_KEY) || '{}');
    return v && typeof v === 'object' && v.pos && typeof v.pos === 'object' ? v : { pos: {} };
  } catch {
    return { pos: {} };
  }
}

function dashSave() {
  try {
    localStorage.setItem(DASH_KEY, JSON.stringify({ pos: DASH.pos, ts: Date.now() }));
  } catch (e) {}
}

function dashColW() {
  const c = DASH.canvas;
  if (!c) return 100;
  return Math.max(24, c.clientWidth / DASH_COLS);
}

function dashCardW(p) {
  return Math.max(120, p.w * dashColW() - DASH_GAP);
}

function dashPaint(el, animated) {
  const p = DASH.pos[el.dataset.cid];
  if (!p) return;
  const cw = dashColW();
  const x = Math.max(0, Math.min(p.x, DASH_COLS - p.w));
  el.style.left = Math.round(x * cw) + 'px';
  el.style.top = Math.round(p.y) + 'px';
  el.style.width = Math.round(Math.max(120, p.w * cw - DASH_GAP)) + 'px';
  el.style.height = Math.round(p.h) + 'px';
  if (animated) {
    el.classList.add('animate');
    clearTimeout(el._dashAnim);
    el._dashAnim = setTimeout(() => el.classList.remove('animate'), 240);
  }
}

function dashPaintAll(animated) {
  if (!DASH.canvas || !DASH.canvas.isConnected) return;
  [...DASH.canvas.querySelectorAll('.dash-card')].forEach((el) => dashPaint(el, animated));
  dashGrow();
}

function dashGrow() {
  const c = DASH.canvas;
  if (!c) return;
  let maxY = 0;
  for (const k of Object.keys(DASH.pos)) {
    const p = DASH.pos[k];
    if (p) maxY = Math.max(maxY, p.y + p.h);
  }
  c.style.height = Math.max(560, Math.round(maxY + 24)) + 'px';
}

/* 磁吸：在候选线里找最近的一条（容差内），返回命中位置或 null */
function dashSnap(val, cands) {
  let best = null;
  let bd = DASH_TOL + 0.001;
  for (const c of cands) {
    const d = Math.abs(val - c);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

function dashGuides(canvas) {
  let v = canvas.querySelector('.dash-guide.v');
  let h = canvas.querySelector('.dash-guide.h');
  if (!v) {
    v = document.createElement('div');
    v.className = 'dash-guide v';
    canvas.appendChild(v);
  }
  if (!h) {
    h = document.createElement('div');
    h.className = 'dash-guide h';
    canvas.appendChild(h);
  }
  return { v, h };
}

function dashGuide(g, axis, at) {
  const el = axis === 'v' ? g.v : g.h;
  if (at == null) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  if (axis === 'v') el.style.left = Math.round(at) + 'px';
  else el.style.top = Math.round(at) + 'px';
}

/** 初始化：量自然高度 → 合并已存布局 → 绑拖动 / 缩放 */
function initDashLayout() {
  const canvas = document.getElementById('dash-canvas');
  if (!canvas) return;
  DASH.canvas = canvas;
  const cards = [...canvas.querySelectorAll('.dash-card')];
  const saved = dashLayout().pos || {};
  const cw = dashColW();

  // 1) 先定宽度（height:auto 的绝对定位元素会按内容撑开），量出每张卡的自然高度
  const nat = {};
  cards.forEach((el) => {
    const cid = el.dataset.cid;
    const w = Math.max(2, Math.min(DASH_COLS, Number(el.dataset.w) || 3));
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.width = Math.max(120, w * cw - DASH_GAP) + 'px';
    el.style.height = 'auto';
    nat[cid] = { w, h: el.getBoundingClientRect().height };
  });

  // 2) 已保存的位置优先 → 其次内置默认布局 → 再其次放到最下面（避免叠在老卡片上）
  const pos = {};
  cards.forEach((el) => {
    const cid = el.dataset.cid;
    const n = nat[cid];
    const sv = saved[cid];
    if (sv && Number.isFinite(sv.x) && Number.isFinite(sv.y)) {
      pos[cid] = {
        x: Math.max(0, Math.min(sv.x, DASH_COLS - 2)),
        y: Math.max(0, sv.y),
        w: Math.max(2, Math.min(DASH_COLS, Number(sv.w) || n.w)),
        h: Math.max(DASH_MIN_H, Number(sv.h) || Math.ceil(n.h / DASH_STEP) * DASH_STEP),
      };
    }
  });
  cards.forEach((el) => {
    const cid = el.dataset.cid;
    if (pos[cid]) return;
    const n = nat[cid];
    const d = DASH_DEFAULT_POS[cid];
    if (d) {
      pos[cid] = { x: d.x, y: d.y, w: d.w, h: Math.max(DASH_MIN_H, d.h || Math.ceil(n.h / DASH_STEP) * DASH_STEP) };
    }
  });
  let belowY = 0;
  for (const k of Object.keys(pos)) belowY = Math.max(belowY, pos[k].y + pos[k].h);
  cards.forEach((el) => {
    const cid = el.dataset.cid;
    if (pos[cid]) return;
    const n = nat[cid];
    const h = Math.max(DASH_MIN_H, Math.ceil(n.h / DASH_STEP) * DASH_STEP);
    pos[cid] = { x: 0, y: belowY + (belowY ? DASH_GAP : 0), w: n.w, h };
    belowY = pos[cid].y + h;
  });

  DASH.pos = pos;
  dashPaintAll(false);

  const g = dashGuides(canvas);

  // 其它卡片的左/右/上/下边缘（磁吸候选线）
  const edgesOf = (self) =>
    cards
      .filter((c) => c !== self)
      .map((c) => {
        const p = DASH.pos[c.dataset.cid];
        const left = p.x * dashColW();
        const w = Math.max(120, p.w * dashColW() - DASH_GAP);
        return { l: left, r: left + w, t: p.y, b: p.y + p.h };
      });

  cards.forEach((el) => {
    const cid = el.dataset.cid;
    const head = el.querySelector('h3') || el;
    head.style.cursor = 'grab';

    /* ---------- 拖动 ---------- */
    head.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest('button,input,textarea,select,a')) return;
      ev.preventDefault();
      const p = DASH.pos[cid];
      const cw0 = dashColW();
      const sx = ev.clientX;
      const sy = ev.clientY;
      const left0 = p.x * cw0;
      const top0 = p.y;
      el.classList.add('dragging');
      el.style.zIndex = ++DASH.z;
      head.style.cursor = 'grabbing';

      const move = (m) => {
        if (m.buttons === 0) { up(); return; } // 松手事件丢在窗口外时兜底
        let left = Math.max(0, left0 + (m.clientX - sx));
        let top = Math.max(0, top0 + (m.clientY - sy));
        const os = edgesOf(el);
        const xc = [0, ...os.map((o) => o.l), ...os.map((o) => o.r)];
        const yc = [0, ...os.map((o) => o.t), ...os.map((o) => o.b)];
        const hx = dashSnap(left, xc);
        const hy = dashSnap(top, yc);
        if (hx != null) left = hx;
        else left = Math.round(left / DASH_STEP) * DASH_STEP;
        if (hy != null) top = hy;
        else top = Math.round(top / DASH_STEP) * DASH_STEP;
        dashGuide(g, 'v', hx);
        dashGuide(g, 'h', hy);
        el.classList.toggle('snapping', hx != null || hy != null);
        p.x = Math.max(0, Math.min(DASH_COLS - p.w, left / cw0));
        p.y = top;
        el.style.left = Math.round(left) + 'px';
        el.style.top = Math.round(top) + 'px';
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        el.classList.remove('dragging', 'snapping');
        head.style.cursor = 'grab';
        dashGuide(g, 'v', null);
        dashGuide(g, 'h', null);
        p.x = Math.max(0, Math.min(DASH_COLS - p.w, Math.round(p.x)));
        p.y = Math.max(0, Math.round(p.y / DASH_STEP) * DASH_STEP);
        dashPaint(el, true);
        dashGrow();
        dashSave();
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });

    /* ---------- 右下角缩放 ---------- */
    let rs = el.querySelector('.rs');
    if (!rs) {
      rs = document.createElement('div');
      rs.className = 'rs';
      rs.title = '拖拽改大小';
      el.appendChild(rs);
    }
    rs.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const p = DASH.pos[cid];
      const cw0 = dashColW();
      const sx = ev.clientX;
      const sy = ev.clientY;
      const w0 = p.w;
      const h0 = p.h;
      el.classList.add('resizing');
      el.style.zIndex = ++DASH.z;

      const move = (m) => {
        if (m.buttons === 0) { up(); return; }
        p.w = Math.max(2, Math.min(DASH_COLS - p.x, Math.round((w0 * cw0 + (m.clientX - sx)) / cw0)));
        p.h = Math.max(DASH_MIN_H, Math.round((h0 + (m.clientY - sy)) / DASH_STEP) * DASH_STEP);
        el.style.width = Math.round(Math.max(120, p.w * cw0 - DASH_GAP)) + 'px';
        el.style.height = Math.round(p.h) + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        el.classList.remove('resizing');
        dashPaint(el, true);
        dashGrow();
        dashSave();
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  });
}

let dashResizeTimer;
window.addEventListener('resize', () => {
  if (!DASH.canvas || !DASH.canvas.isConnected) return;
  clearTimeout(dashResizeTimer);
  dashResizeTimer = setTimeout(() => dashPaintAll(false), 120);
});
/* ================= 总览页面 ================= */
function pageDashboard(root) {
  const st = S.state || {};
  const allow = st.access?.allow?.private?.length || 0;
  const groups = st.access?.allow?.groups?.length || 0;
  const usage = st.usage || {};
  const convs = (st.convs || []).filter((c) => !String(c.convId).startsWith('console:'));

  const card = (cid, w, title, body) => `
    <div class="card dash-card" data-cid="${cid}" data-w="${w}">
      <h3>${title}</h3>
      <div class="dash-body">${body}</div>
      <div class="rs" title="拖拽改大小"></div>
    </div>`;

  root.innerHTML = `
    <div class="dash-toolbar">
      <span>拖动标题栏自由摆放 · 拖右下角改大小 · 靠近其它卡片边缘会磁吸对齐 · 布局自动记住</span>
      <span class="spacer"></span>
      <button class="btn sm ghost" id="btn-dash-reset">恢复默认布局</button>
    </div>
    <div class="dash-canvas" id="dash-canvas">
      ${card('gw', 3, 'QQ 网关', `
        <div class="stat" id="dash-gw">${st.onebot?.connected ? '已连接' : '未连接'}</div>
        <div class="sub" id="dash-gw-sub">${esc(st.onebot?.selfId ? 'QQ ' + st.onebot.selfId : st.onebot?.lastError || '等待协议端')}</div>`)}
      ${card('llm', 3, '模型', `
        <div class="stat" id="dash-llm">${esc(st.llm?.model || '-')}</div>
        <div class="sub">${esc(st.llm?.provider || '-')} · key ${st.llm?.keyReady ? '就绪' : '缺失'}</div>`)}
      ${card('persona', 3, '当前人格', `
        <div class="stat sm">${esc(st.persona?.active || '未启用')}</div>
        <div class="sub">${st.persona?.list?.length || 0} 张卡可用</div>`)}
      ${card('access', 3, '准入', `
        <div class="stat sm">${st.access?.mode === 'owner' ? '仅主人' : '白名单'}</div>
        <div class="sub">私聊 ${allow} · 群 ${groups}</div>`)}
      ${card('bal', 3, 'API 余额', `
        <div class="stat sm" id="dash-bal">—</div>
        <div class="sub" id="dash-bal-sub">读取中…</div>`)}
      ${card('ctx', 3, '上下文占用', `
        <div class="stat sm" id="dash-ctx">—</div>
        <div class="sub" id="dash-ctx-sub"></div>`)}
      ${card('quick', 6, '快捷操作', `
        <div class="row wrap">
          <button class="btn" id="btn-test-llm">测试模型</button>
          <button class="btn" id="btn-test-qq">测试 QQ</button>
          <button class="btn" id="btn-refresh">刷新状态</button>
        </div>
        <div class="hint" id="quick-out" style="margin-top:10px;min-height:18px"></div>
        <h3 style="margin-top:16px">今日用量</h3>
        <div class="row" style="gap:22px">
          <div><div class="stat sm">${usage.calls || 0}</div><div class="sub">调用</div></div>
          <div><div class="stat sm">${usage.pt || 0}</div><div class="sub">输入 token</div></div>
          <div><div class="stat sm">${usage.ct || 0}</div><div class="sub">输出 token</div></div>
          <div><div class="stat sm">${Math.round(usage.avg_ms || 0)}ms</div><div class="sub">平均延迟</div></div>
        </div>`)}
      ${card('convs', 6, '最近会话', `
        <div class="list" id="dash-convs">
          ${convs.length
            ? convs.slice(0, 8).map((c) => `
              <div class="item" data-conv="${esc(c.convId)}">
                <div class="grow">
                  <div class="t mono">${esc(c.convId)}</div>
                  <div class="d">${c.count} 条 · ${fmtTime(c.lastTs)}</div>
                </div>
              </div>`).join('')
            : '<div class="empty">还没有消息记录</div>'}
        </div>`)}
      ${card('events', 6, '实时事件', `
        <div class="events" id="dash-events"></div>`)}
      ${card('mood', 6, '当前心情', `
        <div class="mood-wrap">
          <div class="mood-score" id="dash-mood-score">—</div>
          <div class="mood-main">
            <div class="sub" id="dash-mood-label">读取中…</div>
            <div class="mood-bars" id="dash-mood-bars"></div>
          </div>
        </div>
        <div class="sub" id="dash-mood-reason" style="margin-top:6px"></div>`)}
      ${(st.warnings || []).length
        ? card('warn', 12, '需要注意', `${st.warnings.map((w) => `<div style="color:#fbbf24;font-size:12.5px;line-height:1.8">• ${esc(w)}</div>`).join('')}`)
        : ''}
    </div>
  `;

  // 先把事件列表填进去再量高度，否则 events 卡片会按空内容定高
  paintDashboardEvents();

  initDashLayout();
  paintMoodCard();

  $('#btn-dash-reset').onclick = () => {
    try { localStorage.removeItem(DASH_KEY); } catch (e) {}
    render();
    toast('已恢复默认布局');
  };

  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };

  bind('btn-test-llm', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const r = await api.post('/api/test/llm');
      $('#quick-out').textContent = `模型正常 · ${r.ms}ms · ${r.text}`;
      toast('模型链路正常');
    } catch (err) {
      $('#quick-out').textContent = '失败: ' + err.message;
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '测试模型';
    }
  });

  bind('btn-test-qq', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const r = await api.post('/api/test/onebot');
      $('#quick-out').textContent = `QQ 登录号 ${r.info.user_id} / ${r.info.nickname}`;
      toast('QQ 网关正常');
    } catch (err) {
      $('#quick-out').textContent = 'QQ 网关未就绪: ' + err.message;
      toast('QQ 网关未就绪', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '测试 QQ';
    }
  });

  bind('btn-refresh', async () => {
    await refreshState();
    render();
    toast('已刷新');
  });

  $$('#dash-convs .item').forEach((it) => {
    it.onclick = () => {
      S.conv = it.dataset.conv;
      $$('#nav .nav-item').forEach((x) => x.classList.toggle('active', x.dataset.page === 'chat'));
      S.page = 'chat';
      $('#page-title').textContent = '聊天';
      render();
    };
  });

  (async () => {
    try {
      const b = await api.get('/api/billing');
      const bal = b.billing && b.billing.balance_infos && b.billing.balance_infos[0];
      const el = document.getElementById('dash-bal');
      const sub = document.getElementById('dash-bal-sub');
      if (bal) {
        el.textContent = '¥' + bal.total_balance;
        sub.textContent = '赠金 ' + bal.granted_balance + ' · 充值 ' + bal.topped_up_balance;
      } else {
        el.textContent = '—';
        sub.textContent = b.err || '该服务商不支持余额查询';
      }
      const ctx = document.getElementById('dash-ctx');
      const csub = document.getElementById('dash-ctx-sub');
      if (b.last) {
        const pct = Math.round((b.last.prompt_tokens / b.contextWindow) * 1000) / 10;
        ctx.textContent = Number(b.last.prompt_tokens).toLocaleString() + ' tokens';
        csub.textContent = '窗口 ' + Math.round(b.contextWindow / 1000) + 'k · 占用 ' + pct + '% · 上次输出 ' + b.last.completion_tokens;
      } else {
        ctx.textContent = '暂无记录';
      }
    } catch (e) {
      const sub = document.getElementById('dash-bal-sub');
      if (sub) sub.textContent = '读取失败';
    }
  })();
}
function paintDashboardLive() {
  const gw = $('#dash-gw');
  if (gw) $('#dash-gw').textContent = S.state.onebot?.connected ? '已连接' : '未连接';
  paintMoodCard();
}

const MOOD_ORDER = ['开心', '甜蜜', '委屈', '心疼'];

function moodBars(moods) {
  return MOOD_ORDER.map((e) => {
    const v = Math.max(0, Math.min(100, Number(moods?.[e] || 0)));
    return `<span class="mood-bar" title="${e} ${Math.round(v)}"><i style="width:${v}%"></i><b>${e}</b></span>`;
  }).join('');
}

function paintMoodCard() {
  const box = document.getElementById('dash-mood-score');
  if (!box) return;
  const m = S.state?.mood;
  if (!m) {
    box.textContent = '—';
    return;
  }
  box.textContent = Math.round(m.score);
  const conf = m.confidence == null ? '' : ` · 判断置信 ${Math.round(m.confidence)}`;
  document.getElementById('dash-mood-label').textContent = `${m.label || '平静'} · 基线 ${Math.round(m.baseline ?? 68)}${conf}`;
  document.getElementById('dash-mood-bars').innerHTML = moodBars(m.moods);
  const reason = document.getElementById('dash-mood-reason');
  reason.textContent = m.reason
    ? `刚才：${m.reason}${m.updatedAt ? ' · ' + fmtTime(m.updatedAt) : ''}`
    : m.updatedAt
      ? `最近更新 ${fmtTime(m.updatedAt)}`
      : '还没被触发过（聊两句就会动）';
}

function paintDashboardEvents() {
  const box = $('#dash-events');
  if (!box) return;
  box.innerHTML = S.events.slice(-60).map((e) => `
    <div class="e"><span class="ts">${fmtTime(e.ts)}</span><span class="k">${esc(e.kind)}</span><span class="v">${esc(e.text)}</span></div>
  `).join('') || '<div class="empty">暂无事件</div>';
  box.scrollTop = box.scrollHeight;
}

/* ---------------- 聊天 ---------------- */
async function pageChat(root) {
  const st = S.state || {};
  const convs = st.convs || [];
  if (!S.conv) S.conv = convs[0]?.convId || (st.access?.ownerQQ ? `private:${st.access.ownerQQ}` : '');

  root.innerHTML = `
    <div class="chat-layout">
      <div class="card chat-convs">
        <h3>会话</h3>
        <div class="list scroll-y" id="conv-list" style="flex:1">
          ${convs.length ? convs.map((c) => `
            <div class="item ${c.convId === S.conv ? 'active' : ''}" data-conv="${esc(c.convId)}">
              <div class="grow"><div class="t mono" style="font-size:12px">${esc(c.convId)}</div>
              <div class="d">${c.count} 条 · ${fmtTime(c.lastTs)}</div></div>
            </div>`).join('') : '<div class="empty">暂无会话</div>'}
        </div>
        <div class="row" style="margin-top:10px">
          <input type="text" id="conv-new" placeholder="private:123456" />
          <button class="btn sm" id="conv-go">打开</button>
        </div>
      </div>
      <div class="card chat-main">
        <h3 style="display:flex;justify-content:space-between">
          <span class="mono" id="chat-title">${esc(S.conv || '未选择')}</span>
          <span class="muted" id="chat-count" style="font-size:11px"></span>
        </h3>
        <div class="msgs" id="msgs"></div>
        <div class="composer">
          <textarea id="composer" placeholder="在这里试聊（不发给 QQ）…   Enter 发送 / Shift+Enter 换行"></textarea>
          <div style="display:flex;flex-direction:column;gap:6px">
            <button class="btn primary sm" id="btn-preview">试聊</button>
            <button class="btn sm" id="btn-send">发到 QQ</button>
          </div>
        </div>
      </div>
    </div>
  `;

  $$('#conv-list .item').forEach((it) => {
    it.onclick = () => {
      S.conv = it.dataset.conv;
      render();
    };
  });
  $('#conv-go').onclick = () => {
    const v = $('#conv-new').value.trim();
    if (v) { S.conv = v; render(); }
  };

  const composer = $('#composer');
  composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#btn-preview').click();
    }
  });

  $('#btn-preview').onclick = async () => {
    const text = composer.value.trim();
    if (!text || !S.conv) return;
    if (S.previewing) return;
    S.previewing = true;
    appendMsg('user', text);
    composer.value = '';
    const t = document.createElement('div');
    t.className = 'msg assistant';
    t.innerHTML = '<div class="bubble muted">正在输入…</div>';
    $('#msgs').appendChild(t);
    $('#msgs').scrollTop = 1e9;
    try {
      const r = await api.post('/api/test/preview', { text, conv: S.conv });
      t.remove();
      for (const p of r.parts) appendMsg('assistant', p, `${r.ms}ms`);
    } catch (err) {
      t.remove();
      appendMsg('assistant', '（出错）' + err.message);
      toast(err.message, true);
    } finally {
      S.previewing = false;
    }
  };

  $('#btn-send').onclick = async () => {
    const text = composer.value.trim();
    if (!text || !S.conv) return;
    try {
      await api.post('/api/send', { conv: S.conv, text });
      appendMsg('assistant', text, '已发送');
      composer.value = '';
    } catch (err) {
      toast('发送失败: ' + err.message, true);
    }
  };

  await loadMessages();
}

async function loadMessages() {
  if (!S.conv) return;
  try {
    const r = await api.get(`/api/messages?conv=${encodeURIComponent(S.conv)}&limit=80`);
    const box = $('#msgs');
    if (!box) return;
    box.innerHTML = '';
    for (const m of r.list) appendMsg(m.role === 'user' ? 'user' : 'assistant', m.text, fmtTime(m.ts));
    box.scrollTop = 1e9;
    $('#chat-count').textContent = `${r.list.length} 条`;
  } catch (err) {
    /* 静默 */
  }
}

function appendMsg(who, text, meta = '') {
  const box = $('#msgs');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.innerHTML = `<div class="bubble">${esc(text)}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}`;
  box.appendChild(d);
  box.scrollTop = 1e9;
}

/* ---------------- 人格 ---------------- */
async function loadPersonaList() {
  const r = await api.get('/api/personas');
  S.persona.list = r.list;
  S.persona.active = r.active;
}

async function pagePersona(root) {
  await loadPersonaList();
  if (!S.persona.editing) S.persona.editing = S.persona.active || S.persona.list[0]?.name || '';
  let text = '';
  if (S.persona.editing) {
    try {
      text = (await api.get('/api/persona?name=' + encodeURIComponent(S.persona.editing))).text;
    } catch { text = ''; }
  }
  S.persona.text = text;

  root.innerHTML = `
    <div class="grid" style="grid-template-columns:260px 1fr;gap:12px">
      <div class="card">
        <h3>人格卡（${S.persona.list.length}）</h3>
        <div class="list" id="p-list" style="max-height:520px;overflow:auto">
          ${S.persona.list.map((p) => `
            <div class="item ${p.name === S.persona.editing ? 'active' : ''}" data-name="${esc(p.name)}">
              <div class="grow">
                <div class="t">${esc(p.name)} ${p.name === S.persona.active ? '<span class="tag on">启用中</span>' : ''}</div>
                <div class="d">${p.chars} 字${p.overLimit ? ' · ⚠ 超上限' : ''}</div>
              </div>
            </div>`).join('') || '<div class="empty">还没有人格卡</div>'}
        </div>
        <div class="row" style="margin-top:10px">
          <input type="text" id="p-new" placeholder="新角色名" />
          <button class="btn sm" id="p-create">新建</button>
        </div>
      </div>

      <div class="card">
        <h3 style="display:flex;justify-content:space-between;align-items:center">
          <span>${esc(S.persona.editing || '未选择')}</span>
          <span class="muted" id="p-count" style="font-size:11px">${text.length} 字</span>
        </h3>
        <textarea id="p-text" style="height:440px" placeholder="# 角色卡：…&#10;&#10;## 一、你是谁&#10;- "></textarea>
        <div class="row wrap" style="margin-top:10px">
          <button class="btn primary" id="p-save">保存</button>
          <button class="btn" id="p-activate">设为当前人格</button>
          <button class="btn ghost" id="p-rename">重命名</button>
          <button class="btn danger" id="p-del">删除</button>
          <span class="hint" style="margin:0">改完保存，下一条消息即刻生效</span>
        </div>
        <div class="hint">
          只写「人设」，不写工具用法。建议 3000~5000 字：人格卡会随每条消息注入，6000 字约合 4~6k token。
        </div>
      </div>
    </div>
  `;

  $('#p-text').value = text;
  $('#p-text').oninput = (e) => ($('#p-count').textContent = `${e.target.value.length} 字`);

  $$('#p-list .item').forEach((it) => {
    it.onclick = () => {
      S.persona.editing = it.dataset.name;
      render();
    };
  });

  $('#p-save').onclick = async () => {
    const name = S.persona.editing;
    if (!name) return toast('先选一张卡或新建', true);
    try {
      await api.post('/api/persona', { name, text: $('#p-text').value });
      toast('已保存');
      await loadPersonaList();
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };

  $('#p-activate').onclick = async () => {
    const name = S.persona.editing;
    if (!name) return;
    try {
      await api.post('/api/persona/activate', { name });
      toast(`已切换到「${name}」`);
      await refreshState();
      await loadPersonaList();
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };

  $('#p-create').onclick = async () => {
    const name = $('#p-new').value.trim();
    if (!name) return;
    try {
      await api.post('/api/persona', { name, text: `# 角色卡：${name}\n\n## 一、你是谁\n- \n\n## 二、说话风格\n- \n\n## 三、性格与反应\n- \n` });
      S.persona.editing = name;
      toast('已新建');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };

  $('#p-rename').onclick = async () => {
    const from = S.persona.editing;
    if (!from) return;
    const to = prompt('新名字', from);
    if (!to || to === from) return;
    try {
      await api.post('/api/persona', { name: from, action: 'rename', to });
      S.persona.editing = to;
      toast('已重命名');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };

  $('#p-del').onclick = async () => {
    const name = S.persona.editing;
    if (!name) return;
    if (!confirm(`删除人格卡「${name}」？此操作不可撤销。`)) return;
    try {
      await api.post('/api/persona', { name, action: 'delete' });
      S.persona.editing = '';
      toast('已删除');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

/* ---------------- 记忆 ---------------- */
async function pageMemory(root) {
  if (!S.conv) S.conv = (S.state?.convs?.[0]?.convId) || `private:${S.state?.access?.ownerQQ || 0}`;
  root.innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div class="row wrap">
        <label class="muted" style="font-size:12px">会话</label>
        <input type="text" id="m-conv" value="${esc(S.conv)}" style="max-width:260px" />
        <button class="btn sm" id="m-load">载入</button>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm ${S.memory.tab === 'facts' ? 'primary' : ''}" data-tab="facts">事实档案</button>
        <button class="btn sm ${S.memory.tab === 'diary' ? 'primary' : ''}" data-tab="diary">日记</button>
        <button class="btn sm ${S.memory.tab === 'search' ? 'primary' : ''}" data-tab="search">全文搜索</button>
        <button class="btn sm ${S.memory.tab === 'recall' ? 'primary' : ''}" data-tab="recall">召回</button>
      </div>
    </div>
    <div id="m-body"></div>
  `;

  $('#m-load').onclick = () => { S.conv = $('#m-conv').value.trim() || S.conv; render(); };
  $$('[data-tab]').forEach((b) => {
    b.onclick = () => { S.memory.tab = b.dataset.tab; render(); };
  });

  const body = $('#m-body');
  if (S.memory.tab === 'facts') await renderFacts(body);
  else if (S.memory.tab === 'diary') await renderDiary(body);
  else if (S.memory.tab === 'recall') await renderRecall(body);
  else renderSearch(body);
}

/* ---------------- 召回面板 ---------------- */

async function renderRecall(body) {
  const r = await api.get('/api/memory/recall?conv=' + encodeURIComponent(S.conv));
  const last = r.last;
  body.innerHTML = `
    <div class="card">
      <h3>最近一次召回${last ? ' · ' + fmtTime(last.ts) : ''}</h3>
      <div class="hint">
        每次回复前会按这句话去挑 facts（不再全量塞）。下面能看见谁进了、谁没进、为什么没进。
      </div>
      <div class="row" style="margin:10px 0">
        <input type="text" id="rc-q" placeholder="试跑：输入一句话，看她会想起什么" />
        <button class="btn sm primary" id="rc-go">试跑</button>
      </div>
      <div id="rc-out"></div>
    </div>
    <div class="card" style="margin-top:12px">
      <h3>事实档案（${r.stats?.total ?? 0} 条 · 7 天新增 ${r.stats?.new7d ?? 0} · 库 ${((r.stats?.dbBytes || 0) / 1048576).toFixed(1)} MB）</h3>
      ${(r.stats?.total || 0) > 5000 ? '<div class="hint">超过 5000 条，召回开始变慢（实测 2 万条约 200ms），到时候再考虑归档。</div>' : ''}
      <table class="tbl">
        <thead><tr><th style="width:80px">对象</th><th style="width:130px">键</th><th>值</th><th style="width:90px">更新</th><th style="width:110px">上次被想起</th></tr></thead>
        <tbody>
          ${(r.facts || []).map((f) => `
            <tr>
              <td>${esc(f.subject)} ${f.pinned ? '📌' : ''}</td>
              <td class="mono">${esc(f.key)}</td>
              <td>${esc(f.value)}${f.prevValue ? `<div class="hint" style="margin:0">旧值：${esc(f.prevValue)}</div>` : ''}</td>
              <td class="muted">${fmtTime(f.updatedAt)}</td>
              <td class="muted">${f.lastUsedAt ? fmtTime(f.lastUsedAt) : '—'}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="empty">还没有事实条目</td></tr>'}
        </tbody>
      </table>
    </div>
  `;

  const paint = (t) => {
    const out = document.getElementById('rc-out');
    if (!out) return;
    if (!t) {
      out.innerHTML = '<div class="hint">还没有召回记录，先聊一句或点上面的「试跑」。</div>';
      return;
    }
    const picked = t.pickedRows || [];
    const dropped = t.droppedRows || [];
    out.innerHTML = `
      <div class="hint">问题：${esc(t.query || '（空）')} · 从 ${t.total} 条里挑 ${t.picked} 条 · 共 ${t.chars || 0} 字（预算 ${t.maxChars} 字 / ${t.topK} 条）${t.ms ? ' · 耗时 ' + t.ms + 'ms' : ''}</div>
      <table class="tbl" style="margin-top:8px">
        <thead><tr><th style="width:120px">键</th><th>值</th><th style="width:60px">分数</th><th style="width:60px">证据</th><th style="width:60px">鲜活</th></tr></thead>
        <tbody>
          ${picked.map((p) => `
            <tr>
              <td class="mono">${esc(p.key)}</td>
              <td>${esc(p.value)}</td>
              <td>${p.score == null ? '—' : p.score}</td>
              <td class="muted">${p.evidence ?? '—'}</td>
              <td class="muted">${p.vitality ?? '—'}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="empty">这次一条都没挑中（问题跟记忆无关？）</td></tr>'}
        </tbody>
      </table>
      ${dropped.length ? `
        <div class="hint" style="margin-top:12px">没进这次注入的：</div>
        <table class="tbl">
          <thead><tr><th style="width:120px">键</th><th>值</th><th style="width:230px">为什么没进</th></tr></thead>
          <tbody>${dropped.map((d) => `
            <tr><td class="mono">${esc(d.key)}</td><td>${esc(d.value)}</td><td class="muted">${esc(d.why)}</td></tr>`).join('')}
          </tbody>
        </table>` : ''}
    `;
  };

  paint(last);
  document.getElementById('rc-go').onclick = async () => {
    const q = document.getElementById('rc-q').value.trim();
    if (!q) return toast('先写一句问题', true);
    try {
      const out = await api.post('/api/memory/recall', { convId: S.conv, query: q });
      paint(out.telemetry);
      toast(`挑中 ${out.telemetry.picked} 条`);
    } catch (e) {
      toast(e.message, true);
    }
  };
}

async function renderFacts(body) {
  const r = await api.get('/api/facts?conv=' + encodeURIComponent(S.conv));
  const subjects = [...new Set(r.list.map((f) => f.subject))];
  const options = subjects.map((s) => `<option value="${esc(s)}"></option>`).join('');
  body.innerHTML = `
    ${(r.links || []).length ? `
    <div class="card" style="margin-bottom:12px">
      <h3>可能是同一个人（待确认）</h3>
      <div class="hint">不同 QQ 号用了同一个昵称。确认了才会合并，合并后记忆并到一起，不可自动撤销。</div>
      ${r.links.map((l) => `
        <div class="row wrap" style="gap:8px;align-items:center;margin:8px 0">
          <span><b>${esc(l.aName)}</b> <span class="muted">${esc(l.a)}</span> ⇄ <b>${esc(l.bName)}</b> <span class="muted">${esc(l.b)}</span></span>
          <span class="hint" style="margin:0">${esc(l.evidence || '')}</span>
          <button class="btn sm primary" data-merge="${esc(l.a)}|${esc(l.b)}">合并</button>
          <button class="btn sm ghost" data-ignore="${l.id}">忽略</button>
        </div>`).join('')}
    </div>` : ''}
    <div class="card">
      <h3>事实档案（${r.stats?.total ?? r.list.length} 条 · 7 天新增 ${r.stats?.new7d ?? 0} · ${r.stats?.people ?? 0} 个人 · 库 ${((r.stats?.dbBytes || 0) / 1048576).toFixed(1)} MB）</h3>
      <div class="hint">记忆是<b>全局</b>的：同一个人在私聊、各个群里的事都记在同一个身份（QQ 号）下；名字只是别名。</div>
      <div class="row wrap" style="margin-bottom:10px;gap:8px">
        <span class="hint" style="margin:0">已选 <b id="f-selcount">0</b> 条</span>
        <input type="text" id="f-batch-to" list="f-subjects" placeholder="改成谁的（QQ 或名字）" style="max-width:220px" />
        <button class="btn sm primary" id="f-batch-rename">改选中的</button>
        <button class="btn sm danger" id="f-batch-del">删除选中的</button>
        <button class="btn sm" id="f-clear">清空选择</button>
        <div class="spacer" style="flex:1"></div>
        <button class="btn sm ghost" id="f-open">打开数据目录</button>
        <button class="btn sm ghost" id="f-export">导出 JSON</button>
      </div>
      <datalist id="f-subjects">${options}</datalist>
      <table class="tbl">
        <thead><tr>
          <th style="width:34px"><input type="checkbox" id="f-all" title="全选" /></th>
          <th style="width:170px">对象（QQ）</th>
          <th style="width:150px">键</th>
          <th>值</th>
          <th style="width:70px">置信</th>
          <th style="width:60px">证据</th>
        </tr></thead>
        <tbody>
          ${r.list.map((f) => `
            <tr data-id="${f.id}">
              <td><input type="checkbox" class="f-pick" value="${f.id}" /></td>
              <td>${esc(f.subject)}${f.pinned ? ' 📌' : ''}<div class="hint" style="margin:0">${esc(f.subjectId || '')}</div></td>
              <td><input type="text" value="${esc(f.key)}" data-f="key" /></td>
              <td><input type="text" value="${esc(f.value)}" data-f="value" /></td>
              <td><input type="number" value="${f.confidence}" step="0.1" min="0" max="1" data-f="confidence" /></td>
              <td class="muted">${f.votes ?? 1} 票</td>
            </tr>`).join('') || '<tr><td colspan="6" class="empty">还没有记忆条目</td></tr>'}
        </tbody>
      </table>
      <div class="row wrap" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
        <input type="text" id="f-sub" placeholder="对象（QQ 或昵称）" list="f-subjects" style="max-width:190px" />
        <input type="text" id="f-key" placeholder="键，如：喜欢的食物" style="max-width:160px" />
        <input type="text" id="f-val" placeholder="值，如：抹茶" style="max-width:240px" />
        <button class="btn sm primary" id="f-add">添加</button>
      </div>
      <div class="hint">
        每次回复前按「和这句话的相关度 + 鲜活度 + 重要度」挑 top-k 注入（不是全量）。改了值会记一条人工证据（权重最高），以后别人说法再冲突也顶不掉，除非本人纠正。
        记忆存在 <code>app/data/memory.db</code>（SQLite，不是纯文本），点「导出 JSON」可以拿出去看/备份。
      </div>
    </div>
  `;

  $$('[data-merge]').forEach((b) => {
    b.onclick = async () => {
      const [a, c] = String(b.dataset.merge).split('|');
      if (!a || !c) return;
      b.disabled = true;
      try {
        const out = await api.post('/api/people/merge', { a, b: c });
        toast(`已合并，${out.merged || 0} 条证据`);
        render();
      } catch (e) {
        toast('合并失败：' + e.message);
        b.disabled = false;
      }
    };
  });
  $$('[data-ignore]').forEach((b) => {
    b.onclick = async () => {
      await api.post('/api/people/link', { id: Number(b.dataset.ignore), status: 'rejected' });
      render();
    };
  });

  const picks = () => $$('.f-pick').filter((c) => c.checked).map((c) => Number(c.value));
  const refreshCount = () => {
    const n = picks().length;
    const el = $('#f-selcount');
    if (el) el.textContent = String(n);
  };

  $$('.f-pick').forEach((c) => {
    c.onchange = () => {
      refreshCount();
      const tr = c.closest('tr');
      if (tr) tr.classList.toggle('selected', c.checked);
    };
  });
  $('#f-all').onchange = (e) => {
    $$('.f-pick').forEach((c) => {
      c.checked = e.target.checked;
      const tr = c.closest('tr');
      if (tr) tr.classList.toggle('selected', c.checked);
    });
    refreshCount();
  };
  $('#f-clear').onclick = () => {
    $$('.f-pick').forEach((c) => {
      c.checked = false;
      const tr = c.closest('tr');
      if (tr) tr.classList.remove('selected');
    });
    const all = $('#f-all');
    if (all) all.checked = false;
    refreshCount();
  };

  $$('tr[data-id] input[data-f]').forEach((inp) => {
    inp.onchange = async () => {
      const id = Number(inp.closest('tr').dataset.id);
      const row = inp.closest('tr');
      const payload = { action: 'update', id };
      $$('input[data-f]', row).forEach((i) => (payload[i.dataset.f] = i.dataset.f === 'confidence' ? Number(i.value) : i.value));
      try {
        const out = await api.post('/api/facts', payload);
        if (out && out.merged) {
          toast('和已有条目同名同键，已合并');
          render();
        } else toast('已保存');
      } catch (e) {
        toast(e.message, true);
      }
    };
  });

  let delArmTimer = null;
  const delBtn = $('#f-batch-del');
  const disarmDel = () => {
    if (delArmTimer) clearTimeout(delArmTimer);
    delArmTimer = null;
    delBtn.dataset.armed = '';
    delBtn.textContent = '删除选中的';
  };
  delBtn.onclick = async () => {
    const ids = picks();
    if (!ids.length) return toast('先勾选要删的几条', true);
    if (delBtn.dataset.armed !== '1') {
      delBtn.dataset.armed = '1';
      delBtn.textContent = `再点一次，删掉这 ${ids.length} 条`;
      delArmTimer = setTimeout(disarmDel, 4000);
      return;
    }
    delBtn.disabled = true;
    try {
      const out = await api.post('/api/facts/delete-selected', { convId: S.conv, ids });
      toast(`已删除 ${out.deleted} 条`);
      render();
    } catch (e) {
      toast(e.message, true);
      delBtn.disabled = false;
      disarmDel();
    }
  };

  $('#f-add').onclick = async () => {
    const subject = $('#f-sub').value.trim();
    const key = $('#f-key').value.trim();
    const value = $('#f-val').value.trim();
    if (!key || !value) return toast('键和值都要填', true);
    try {
      await api.post('/api/facts', { convId: S.conv, subject, key, value, confidence: 0.9 });
      toast('已添加');
      render();
    } catch (e) { toast(e.message, true); }
  };

  $('#f-batch-rename').onclick = async () => {
    const ids = picks();
    const to = $('#f-batch-to').value.trim();
    if (!ids.length) return toast('先勾选要改的几条', true);
    if (!to) return toast('填一下改成谁', true);
    const btn = $('#f-batch-rename');
    btn.disabled = true;
    try {
      const out = await api.post('/api/facts/rename-selected', { convId: S.conv, ids, to });
      toast(`改了 ${out.renamed} 条${out.merged ? '，合并 ' + out.merged + ' 条' : ''}${out.skipped ? '，' + out.skipped + ' 条本来就叫这个' : ''}`);
      render();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
  };

  $('#f-open').onclick = async () => {
    try {
      const out = await api.post('/api/open-path', { which: 'data' });
      toast('已打开：' + out.path);
    } catch (e) { toast(e.message, true); }
  };

  $('#f-export').onclick = async () => {
    try {
      const out = await api.post('/api/facts/export', { convId: S.conv });
      toast(`已导出 ${out.facts} 条事实 + ${out.diary} 篇日记到 app/data/memory-export.json`);
    } catch (e) { toast(e.message, true); }
  };
}

async function renderDiary(body) {
  const r = await api.get('/api/diary?conv=' + encodeURIComponent(S.conv));
  body.innerHTML = `
    <div class="card">
      <h3 style="display:flex;justify-content:space-between;align-items:center">
        <span>情景日记（${r.list.length}）</span>
        <button class="btn sm" id="d-gen">生成今天的日记</button>
      </h3>
      <div>
      ${r.list.length ? r.list.map((d) => `
        <div class="item" style="align-items:flex-start;cursor:default">
          <div class="grow">
            <div class="t">${esc(d.day)} ${d.mood ? `<span class="tag">${esc(d.mood)}</span>` : ''}</div>
            <div class="d" style="white-space:pre-wrap;margin-top:4px;line-height:1.6">${esc(d.summary)}</div>
          </div>
        </div>`).join('') : '<div class="empty">还没有日记。聊几句后点右上角生成，或等消息停下 3 分钟让它自己写。</div>'}
      </div>
    </div>
  `;
  const btn = document.getElementById('d-gen');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '整理中…';
    try {
      const out = await api.post('/api/diary/generate', { conv: S.conv });
      toast(out.skipped ? out.skipped : out.error ? out.error : '日记已生成' + (out.facts ? '，新事实 ' + out.facts + ' 条' : ''), !!out.error);
      render();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = '生成今天的日记';
    }
  };
}

function renderSearch(body) {
  body.innerHTML = `
    <div class="card">
      <div class="row">
        <input type="text" id="s-q" placeholder="搜索历史消息（支持中文子串）" />
        <button class="btn sm primary" id="s-go">搜索</button>
      </div>
      <div id="s-res" style="margin-top:12px"></div>
    </div>
  `;
  const doSearch = async () => {
    const q = $('#s-q').value.trim();
    if (!q) return;
    const r = await api.get('/api/search?q=' + encodeURIComponent(q));
    $('#s-res').innerHTML = r.list.length
      ? r.list.map((m) => `
          <div class="item" style="cursor:default">
            <div class="grow">
              <div class="d">${esc(m.convId)} · ${fmtTime(m.ts)} · ${m.role === 'user' ? '对方' : '她'}</div>
              <div class="t" style="font-weight:400;white-space:pre-wrap">${esc(m.text)}</div>
            </div>
          </div>`).join('')
      : '<div class="empty">没有命中</div>';
  };
  $('#s-go').onclick = doSearch;
  $('#s-q').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
}

/* ---------------- 设置 ---------------- */

/* ---------------- 主题 ---------------- */
async function applyTheme() {
  try {
    const t = await api.get('/api/theme');
    const st = document.documentElement.style;
    if (t.accent) st.setProperty('--accent', t.accent);
    if (t.accent2) st.setProperty('--accent-2', t.accent2);
    const layer = document.getElementById('bg-layer');
    if (layer) {
      if (t.bg) {
        layer.style.backgroundImage = 'url("' + t.bg + '")';
        layer.style.opacity = String(t.bgOpacity == null ? 0.18 : t.bgOpacity);
        document.body.classList.add('has-bg');
      } else {
        layer.style.backgroundImage = 'none';
        document.body.classList.remove('has-bg');
      }
    }
  } catch (e) {
    /* 主题坏了不影响主流程 */
  }
}

function readAccessForm() {
  const nums = (v) =>
    String(v || '')
      .split(/[\s,，、]+/)
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n !== 0);
  return {
    mode: document.getElementById('s-mode').value,
    ownerQQ: Number(document.getElementById('s-owner').value) || 0,
    allow: {
      private: nums(document.getElementById('s-allow-p').value),
      groups: nums(document.getElementById('s-allow-g').value),
    },
    deny: {
      private: nums(document.getElementById('s-deny-p').value),
      groups: nums(document.getElementById('s-deny-g').value),
    },
    allowAllWhenEmpty: document.getElementById('s-allowall').checked,
  };
}

function accessKey(a) {
  const arr = (v) => (Array.isArray(v) ? v.map(Number).sort((x, y) => x - y) : []);
  return JSON.stringify({
    m: a.mode,
    o: Number(a.ownerQQ) || 0,
    ap: arr(a.allow && a.allow.private),
    ag: arr(a.allow && a.allow.groups),
    dp: arr(a.deny && a.deny.private),
    dg: arr(a.deny && a.deny.groups),
    all: !!a.allowAllWhenEmpty,
  });
}

async function pageAccess(root) {
  const c = S.config || (S.config = await api.get('/api/config'));
  let pr;
  try {
    pr = await api.get('/api/profiles');
  } catch {
    pr = { list: [] };
  }
  const profiles = pr.list || [];
  const currentKey = accessKey(c.access);

  root.innerHTML = `
    <div class="grid c2">
      <div class="card">
        <h3>准入控制</h3>
        <div class="field">
          <label>模式</label>
          <select id="s-mode">
            <option value="owner" ${c.access.mode === 'owner' ? 'selected' : ''}>仅主人（只有 ownerQQ 能触发）</option>
            <option value="public" ${c.access.mode === 'public' ? 'selected' : ''}>白名单（allow 里的人和群）</option>
          </select>
        </div>
        <div class="field">
          <label>主人 QQ（不受限流/静默影响）</label>
          <input type="text" id="s-owner" value="${c.access.ownerQQ || ''}" />
        </div>
        <div class="field">
          <label>白名单 · 私聊</label>
          <textarea id="s-allow-p" style="height:68px">${(c.access.allow.private || []).join(', ')}</textarea>
        </div>
        <div class="field">
          <label>白名单 · 群</label>
          <textarea id="s-allow-g" style="height:56px">${(c.access.allow.groups || []).join(', ')}</textarea>
        </div>
        <div class="field">
          <label>黑名单 · 私聊（优先于白名单）</label>
          <textarea id="s-deny-p" style="height:56px">${(c.access.deny.private || []).join(', ')}</textarea>
        </div>
        <div class="field">
          <label>黑名单 · 群</label>
          <textarea id="s-deny-g" style="height:56px">${(c.access.deny.groups || []).join(', ')}</textarea>
        </div>
        <label class="switch"><input type="checkbox" id="s-allowall" ${c.access.allowAllWhenEmpty ? 'checked' : ''} /> 白名单为空时放行全部（危险）</label>
        <div class="row" style="margin-top:12px;align-items:center">
          <button class="btn primary" id="a-save">保存准入设置</button>
          <span class="hint" id="a-dirty" style="margin:0;color:var(--warn);display:none">● 有未保存的改动</span>
        </div>
      </div>

      <div class="card">
        <h3>名单方案（${profiles.length}）</h3>
        <div class="hint" style="margin-bottom:10px">
          点「存为方案」会把**左边输入框里当前的内容**存下来并立即生效，不用先点保存。
          同名会覆盖。应用方案会覆盖当前设置。
        </div>
        <div class="row" style="margin-bottom:10px">
          <input type="text" id="p-name" placeholder="方案名，如：只跟熟人" />
          <button class="btn sm primary" id="p-save">存为方案</button>
        </div>
        <div class="list" style="max-height:400px;overflow:auto">
          ${profiles.length ? profiles.map((p) => `
            <div class="item" style="align-items:flex-start;cursor:default">
              <div class="grow">
                <div class="t">${esc(p.name)} ${accessKey(p.access) === currentKey ? '<span class="tag on">当前</span>' : ''}</div>
                <div class="d">
                  ${p.access.mode === 'owner' ? '仅主人' : '白名单'} ·
                  私聊 ${(p.access.allow.private || []).length} · 群 ${(p.access.allow.groups || []).length}
                  ${(p.access.deny.private || []).length + (p.access.deny.groups || []).length ? ' · 黑名单 ' + ((p.access.deny.private || []).length + (p.access.deny.groups || []).length) : ''}
                </div>
              </div>
              <div class="row">
                <button class="btn sm" data-apply="${p.id}">应用</button>
                <button class="btn sm" data-rename="${p.id}">改名</button>
                <button class="btn sm danger" data-del="${p.id}">删</button>
              </div>
            </div>`).join('') : '<div class="empty">还没有方案。填好左边的名单，起个名字点「存为方案」。</div>'}
        </div>
      </div>
    </div>`;

  // 未保存改动提示
  const dirtyEl = document.getElementById('a-dirty');
  const markDirty = () => {
    if (dirtyEl) dirtyEl.style.display = 'inline';
  };
  ['s-mode', 's-owner', 's-allow-p', 's-allow-g', 's-deny-p', 's-deny-g', 's-allowall'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', markDirty);
      el.addEventListener('change', markDirty);
    }
  });

  document.getElementById('a-save').onclick = async () => {
    try {
      await api.post('/api/config', { access: readAccessForm() });
      S.config = null;
      toast('准入设置已保存');
      await refreshState();
      render();
    } catch (e) {
      toast(e.message, true);
    }
  };

  document.getElementById('p-save').onclick = async () => {
    const nameEl = document.getElementById('p-name');
    const name = nameEl.value.trim();
    if (!name) return toast('先给方案起个名字', true);
    try {
      // 关键：把表单里的当前值一起提交，而不是让服务端去读旧配置
      const r = await api.post('/api/profiles/save', { name, access: readAccessForm() });
      await api.post('/api/profiles/apply', { id: r.profile.id });
      S.config = null;
      toast('已存为方案并生效：' + name);
      await refreshState();
      render();
    } catch (e) {
      toast(e.message, true);
    }
  };

  document.querySelectorAll('[data-apply]').forEach((b) => {
    b.onclick = async () => {
      const dirty = dirtyEl && dirtyEl.style.display !== 'none';
      if (dirty && !confirm('当前有未保存的改动，应用方案会覆盖它们。继续？')) return;
      try {
        await api.post('/api/profiles/apply', { id: b.dataset.apply });
        S.config = null;
        toast('已切换方案');
        await refreshState();
        render();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });

  document.querySelectorAll('[data-rename]').forEach((b) => {
    b.onclick = async () => {
      const cur = b.closest('.item').querySelector('.t').textContent.replace('当前', '').trim();
      const name = prompt('方案新名字', cur);
      if (!name || name === cur) return;
      try {
        await api.post('/api/profiles/rename', { id: b.dataset.rename, name });
        render();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });

  document.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除这个方案？')) return;
      try {
        await api.post('/api/profiles/delete', { id: b.dataset.del });
        render();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
}

async function pageSettings(root) {
  const c = S.config || (S.config = await api.get('/api/config'));
  if (!S.llmPresets) {
    try {
      S.llmPresets = await api.get('/api/llm/presets');
    } catch {
      S.llmPresets = { presets: [], configured: {}, defaultProvider: c.llm.defaultProvider };
    }
  }
  const presets = S.llmPresets.presets || [];
  const configured = S.llmPresets.configured || {};
  const curId = c.llm.defaultProvider;
  const curPreset = presets.find((x) => x.id === curId) || null;
  const prov = c.llm.providers[curId] || {};
  const th = c.theme || {};
  const opPct = Math.round((th.bgOpacity == null ? 0.18 : th.bgOpacity) * 100);
  const extraIds = Object.keys(configured).filter((id) => !presets.some((x) => x.id === id));
  const ttsInfo = await api.get('/api/tts').catch(() => null);
  const tts = ttsInfo || { provider: c.tts?.provider || 'sapi', voice: c.tts?.voice || '', rate: c.tts?.rate ?? 0, breeze: c.tts?.breeze || {}, hasKey: false };
  const tb = tts.breeze || {};

  root.innerHTML = `
    <div class="grid c2">
      <div class="card">
        <h3>模型</h3>
        <div class="hint" id="s-live" style="margin:-4px 0 10px">当前生效：${esc(curPreset?.label || curId)} · ${esc(prov.defaultModel || curPreset?.model || '未设置模型')} · key ${prov.hasKey ? '已保存' : '未填'}${c.llm.visionModel ? ` · 图片用 ${esc(c.llm.visionModel)}` : ' · 图片未单独配模型'}</div>
        <div class="field">
          <label>服务商</label>
          <select id="s-prov">
            ${presets.map((x) => `<option value="${x.id}" ${x.id === curId ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}
            ${extraIds.map((id) => `<option value="${esc(id)}" ${id === curId ? 'selected' : ''}>${esc(configured[id].label || id)}（已配置）</option>`).join('')}
          </select>
          <div class="hint" id="s-prov-hint">${esc(curPreset?.note || '换服务商只改这一栏，人格/记忆/参数都不动')}</div>
        </div>
        <div class="field">
          <label>接口地址（baseUrl，写到 /v1 为止）</label>
          <input type="text" id="s-base" value="${esc(prov.baseUrl || curPreset?.baseUrl || '')}" />
        </div>
        <div class="field">
          <label>模型名（填了 key 可以点「自动识别」）</label>
          <div class="row">
            <input type="text" id="s-model" list="s-models" value="${esc(prov.defaultModel || curPreset?.model || '')}" />
            <button class="btn sm" id="s-fetch" title="问服务商的 /models 接口，把这家的模型列出来">自动识别</button>
          </div>
          <datalist id="s-models">${(prov.models || curPreset?.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
          <div class="hint">常用：<span id="s-models-hint">${esc((prov.models || curPreset?.models || []).join(' / ') || '自定义')}</span> · 模型名以服务商控制台为准，可直接手改</div>
        </div>
        <div class="field">
          <label>视觉模型（带图回复用，可留空）</label>
          <div class="row">
            <input type="text" id="s-vision" list="s-vision-models" value="${esc(curId === c.llm.defaultProvider ? c.llm.visionModel || '' : '')}" />
          </div>
          <datalist id="s-vision-models"></datalist>
          <div class="hint">留空 = 带图时用上面的模型（不支持看图就会报错）；DeepSeek 用 <code>deepseek-flash</code>，通义用 <code>qwen-vl-plus</code>，智谱用 <code>glm-4v-flash</code></div>
        </div>
        <div class="field">
          <label>API Key（可以留空，之后再填）</label>
          <div class="row">
            <input type="password" id="s-key" placeholder="${prov.hasKey ? '已保存（留空表示不改）' : '留空 = 先不填，之后再补'}" autocomplete="off" />
            <button class="btn sm" id="s-keyclear" title="保存后删掉已存的 key">清除</button>
          </div>
          <div class="hint" id="s-keyhint">${prov.hasKey ? '已配置 key' : curPreset?.noAuth ? '本地模型，不需要 key' : '还没有 key（可以先填服务商和模型，key 以后再补）'}${curPreset?.keyUrl ? ` · 申请地址：${esc(curPreset.keyUrl)}` : ''}</div>
        </div>
        <div class="row wrap" style="margin-bottom:10px">
          <button class="btn sm" id="s-test">测试连接</button>
          <button class="btn sm ghost" id="s-models-refresh">填回预设模型名</button>
          <span class="hint" id="s-testmsg" style="margin:0"></span>
        </div>
        <div class="grid c2" style="gap:10px">
          <div class="field"><label>temperature</label><input type="number" id="s-temp" step="0.1" value="${c.llm.temperature}" /></div>
          <div class="field"><label>max_tokens</label><input type="number" id="s-maxtok" value="${c.llm.maxTokens}" /></div>
        </div>
        <div class="field"><label>历史轮数</label><input type="number" id="s-hist" value="${c.llm.historyTurns}" /></div>
      </div>

      <div class="card">
        <h3>外观</h3>
        <div class="grid c2" style="gap:10px">
          <div class="field">
            <label>主题色</label>
            <input type="color" id="t-accent" value="${th.accent || '#6ee7b7'}" style="height:40px;padding:3px" />
          </div>
          <div class="field">
            <label>次色（渐变/高亮）</label>
            <input type="color" id="t-accent2" value="${th.accent2 || '#818cf8'}" style="height:40px;padding:3px" />
          </div>
        </div>
        <div class="field">
          <label>自定义背景图</label>
          <input type="file" id="t-bg-file" accept="image/png,image/jpeg,image/webp,image/gif" />
          <div class="hint">选图后自动上传并生效；建议 1600px 宽以内，文件 ≤12MB。</div>
        </div>
        <div class="field">
          <label>背景透明度 <b id="t-op-label">${opPct}%</b></label>
          <input type="range" id="t-op" min="0" max="100" value="${opPct}" />
        </div>
        <div class="row wrap">
          <button class="btn primary" id="t-save">保存外观</button>
          <button class="btn" id="t-clear">清除背景</button>
          <button class="btn ghost" id="t-reset">恢复默认色</button>
        </div>
        <div class="hint" id="t-msg"></div>
      </div>

      <div class="card">
        <h3>语音（TTS）</h3>
        <div class="field">
          <label>语音服务商</label>
          <select id="s-tts-provider">
            <option value="sapi" ${tts.provider !== 'breeze' ? 'selected' : ''}>本机 SAPI（离线，免 key）</option>
            <option value="breeze" ${tts.provider === 'breeze' ? 'selected' : ''}>Breeze Blue（在线，音色更好）</option>
          </select>
          <div class="hint">换服务商只影响合成；「允许她发语音」还是调参页那个开关。</div>
        </div>

        <div id="s-tts-sapi">
          <div class="grid c2" style="gap:10px">
            <div class="field"><label>SAPI 音色</label><input type="text" id="s-tts-voice" value="${esc(tts.voice || 'Microsoft Huihui Desktop')}" /></div>
            <div class="field"><label>语速（-10~10）</label><input type="number" id="s-tts-rate" value="${tts.rate ?? 0}" /></div>
          </div>
        </div>

        <div id="s-tts-breeze">
          <div class="field">
            <label>API Key（<a href="https://breezeblue.ai/zh/app/developer/api-keys" target="_blank">申请地址</a>）</label>
            <div class="row">
              <input type="password" id="s-breeze-key" placeholder="${tts.hasKey ? '已保存（留空表示不改）' : 'brz_...'}" autocomplete="off" />
              <button class="btn sm" id="s-breeze-clear">清除</button>
            </div>
          </div>
          <div class="field">
            <label>音色</label>
            <div class="row">
              <select id="s-breeze-voice"><option value="">（填 key 后点「加载音色」）</option></select>
              <button class="btn sm" id="s-breeze-load">加载音色</button>
            </div>
            <div class="row" style="margin-top:6px">
              <input type="text" id="s-breeze-search" placeholder="搜音色名（比如你自己的「傲气学姐」）" />
            </div>
            <input type="text" id="s-breeze-voiceid" placeholder="voice_id（voc_...）" value="${esc(tb.voiceId || '')}" style="margin-top:6px" />
          </div>
          <div class="grid c2" style="gap:10px">
            <div class="field"><label>模型</label><input type="text" id="s-breeze-model" value="${esc(tb.modelId || 'breeze-tts-2')}" /></div>
            <div class="field"><label>语言（ISO 两位）</label><input type="text" id="s-breeze-lang" value="${esc(tb.language || 'zh')}" /></div>
            <div class="field"><label>语速（0.5~2）</label><input type="number" id="s-breeze-speed" step="0.05" min="0.5" max="2" value="${tb.speed ?? 1}" /></div>
            <div class="field"><label>表现力 guidance（0=不传，1~10）</label><input type="number" id="s-breeze-guide" min="0" max="10" value="${tb.guidance ?? 0}" /></div>
            <div class="field"><label>结尾静音（ms，防削字）</label><input type="number" id="s-breeze-pad" min="0" max="2000" value="${tb.padMs ?? 300}" /></div>
          </div>
          <div class="field"><label>演出指令（可选的语气/角色描述）</label><textarea id="s-breeze-inst" rows="2" placeholder="例：年轻女孩，说话随口、自然，别太播音腔，语气偏冷淡">${esc(tb.instructions || '')}</textarea></div>
          <div class="hint">「加载音色」按「中文 · 女声」筛；也可以直接填 voice_id。试听用的是表单当前值，不需要先保存。</div>
        </div>

        <div class="row wrap" style="margin-top:10px">
          <button class="btn" id="s-tts-test">试听一句</button>
          <span class="hint" id="s-tts-msg" style="margin:0"></span>
        </div>
        <audio id="s-tts-audio" style="width:100%;margin-top:8px" controls></audio>
      </div>

      <div class="card">
        <h3>拟真与限流</h3>
        <div class="grid c2" style="gap:10px">
          <div class="field"><label>已读延迟下限 (ms)</label><input type="number" id="s-read-min" value="${c.behavior.readDelayMs[0]}" /></div>
          <div class="field"><label>已读延迟上限 (ms)</label><input type="number" id="s-read-max" value="${c.behavior.readDelayMs[1]}" /></div>
          <div class="field"><label>分条间隔下限 (ms)</label><input type="number" id="s-gap-min" value="${c.behavior.sendGapMs[0]}" /></div>
          <div class="field"><label>分条间隔上限 (ms)</label><input type="number" id="s-gap-max" value="${c.behavior.sendGapMs[1]}" /></div>
          <div class="field"><label>单条最长字数</label><input type="number" id="s-split" value="${c.behavior.splitMaxChars}" /></div>
          <div class="field"><label>每小时最多发送</label><input type="number" id="s-maxh" value="${c.behavior.maxSendPerHour}" /></div>
        </div>
        <label class="switch" style="margin:6px 0 10px"><input type="checkbox" id="s-quiet" ${c.behavior.quietHours.enabled ? 'checked' : ''} /> 启用静默时段（非主人不回复）</label>
        <div class="row">
          <input type="text" id="s-quiet-s" value="${c.behavior.quietHours.start}" style="max-width:90px" />
          <span class="muted">→</span>
          <input type="text" id="s-quiet-e" value="${c.behavior.quietHours.end}" style="max-width:90px" />
        </div>
      </div>

      <div class="card">
        <h3>协议端</h3>
        <div class="field"><label>协议端类型</label>
          <select id="s-kind">
            <option value="napcat" ${c.onebot.kind === 'napcat' ? 'selected' : ''}>NapCat</option>
            <option value="snowluma" ${c.onebot.kind === 'snowluma' ? 'selected' : ''}>SnowLuma</option>
          </select>
        </div>
        <div class="field"><label>OneBot WebSocket</label><input type="text" id="s-ws" value="${esc(c.onebot.wsUrl)}" /></div>
        <div class="field"><label>OneBot HTTP API</label><input type="text" id="s-http" value="${esc(c.onebot.httpUrl)}" /></div>
        <div class="field"><label>accessToken</label><input type="text" id="s-token" value="${esc(c.onebot.accessToken)}" /></div>
        <div class="hint">NapCat 和 SnowLuma 都是 OneBot v11，换协议端就是换端口。</div>
      </div>
    </div>

    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="s-save">保存设置</button>
      <span class="hint" style="margin:0">准入 / 白名单 / 黑名单已移到「权限」页</span>
    </div>
  `;

  const op = document.getElementById('t-op');
  if (op) {
    op.oninput = () => {
      document.getElementById('t-op-label').textContent = op.value + '%';
      const layer = document.getElementById('bg-layer');
      if (layer) layer.style.opacity = String(Number(op.value) / 100);
    };
  }

  document.getElementById('t-save').onclick = async () => {
    const msg = document.getElementById('t-msg');
    try {
      await api.post('/api/theme', {
        accent: document.getElementById('t-accent').value,
        accent2: document.getElementById('t-accent2').value,
        bgOpacity: Number(op.value) / 100,
      });
      await applyTheme();
      S.config = null;
      if (msg) msg.textContent = '外观已保存';
      toast('外观已保存');
    } catch (e) {
      if (msg) msg.textContent = e.message;
      toast(e.message, true);
    }
  };

  document.getElementById('t-bg-file').onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const msg = document.getElementById('t-msg');
    if (msg) msg.textContent = '上传中…';
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('读取文件失败'));
      fr.readAsDataURL(file);
    });
    try {
      await api.post('/api/theme', { bgDataUrl: dataUrl, bgOpacity: Number(op.value) / 100 });
      await applyTheme();
      S.config = null;
      if (msg) msg.textContent = '背景已更新';
      toast('背景已更新');
    } catch (err) {
      if (msg) msg.textContent = err.message;
      toast(err.message, true);
    }
  };

  document.getElementById('t-clear').onclick = async () => {
    try {
      await api.post('/api/theme', { bgDataUrl: null });
      await applyTheme();
      S.config = null;
      toast('背景已清除');
      render();
    } catch (e) {
      toast(e.message, true);
    }
  };

  document.getElementById('t-reset').onclick = async () => {
    try {
      await api.post('/api/theme', { accent: '#6EE7B7', accent2: '#818CF8', bgOpacity: 0.18 });
      await applyTheme();
      S.config = null;
      toast('已恢复默认配色');
      render();
    } catch (e) {
      toast(e.message, true);
    }
  };

  // ---------- 语音（TTS） ----------
  const elTtsProv = document.getElementById('s-tts-provider');
  const elTtsSapi = document.getElementById('s-tts-sapi');
  const elTtsBreeze = document.getElementById('s-tts-breeze');
  const elBreezeKey = document.getElementById('s-breeze-key');
  const elBreezeVoice = document.getElementById('s-breeze-voice');
  const elBreezeVoiceId = document.getElementById('s-breeze-voiceid');
  const elBreezeMsg = document.getElementById('s-tts-msg');
  const elTtsAudio = document.getElementById('s-tts-audio');
  const elBreezeLang = document.getElementById('s-breeze-lang');
  let clearBreezeKey = false;

  const breezeForm = () => ({
    voiceId: elBreezeVoiceId.value.trim(),
    modelId: document.getElementById('s-breeze-model').value.trim(),
    language: elBreezeLang.value.trim(),
    speed: Number(document.getElementById('s-breeze-speed').value),
    guidance: Number(document.getElementById('s-breeze-guide').value),
    padMs: Number(document.getElementById('s-breeze-pad').value),
    instructions: document.getElementById('s-breeze-inst').value,
  });

  const paintTts = () => {
    const isB = elTtsProv.value === 'breeze';
    elTtsSapi.style.display = isB ? 'none' : '';
    elTtsBreeze.style.display = isB ? '' : 'none';
  };
  elTtsProv.onchange = paintTts;
  paintTts();

  document.getElementById('s-breeze-clear').onclick = () => {
    clearBreezeKey = true;
    elBreezeKey.value = '';
    elBreezeKey.placeholder = '保存后删除已存的 key';
    if (elBreezeMsg) elBreezeMsg.textContent = '保存设置后会清除 key';
  };

  document.getElementById('s-breeze-load').onclick = async () => {
    if (elBreezeMsg) elBreezeMsg.textContent = '加载音色中…';
    const q = document.getElementById('s-breeze-search').value.trim();
    try {
      const out = await api.post('/api/tts/voices', {
        apiKey: elBreezeKey.value.trim() || undefined,
        language: q ? '' : elBreezeLang.value.trim() || 'zh',
        gender: q ? null : 'female',
        search: q,
      });
      const list = out.list || [];
      elBreezeVoice.innerHTML =
        '<option value="">（' + list.length + ' 个音色，选一个）</option>' +
        list
          .map((v) => {
            const meta = [v.lang, v.gender, v.accent].filter(Boolean).join(' · ');
            return '<option value="' + esc(v.id) + '">' + esc(v.name) + '（' + esc(meta) + '）</option>';
          })
          .join('');
      if (tb.voiceId) elBreezeVoice.value = tb.voiceId;
      // 用名字搜出来的结果，直接选中第一个，避免"选了但没生效"
      if (q && list.length && !elBreezeVoice.value) {
        elBreezeVoice.value = list[0].id;
        elBreezeVoiceId.value = list[0].id;
        if (elBreezeMsg) elBreezeMsg.textContent = '已选中「' + list[0].name + '」';
      }
      if (elBreezeMsg && !(q && list.length)) elBreezeMsg.textContent = list.length ? '加载了 ' + list.length + ' 个音色' : '没查到音色（换个关键词或检查 key）';
    } catch (e) {
      if (elBreezeMsg) elBreezeMsg.textContent = '加载失败：' + e.message;
      toast(e.message, true);
    }
  };

  elBreezeVoice.onchange = () => {
    if (elBreezeVoice.value) elBreezeVoiceId.value = elBreezeVoice.value;
  };

  document.getElementById('s-tts-test').onclick = async () => {
    if (elBreezeMsg) elBreezeMsg.textContent = '合成中…';
    const provider = elTtsProv.value;
    // 下拉里选中的优先，避免"下拉选了、输入框还是旧的"
    if (elBreezeVoice.value) elBreezeVoiceId.value = elBreezeVoice.value;
    const picked = elBreezeVoiceId.value.trim();
    const pickedName = elBreezeVoice.value
      ? elBreezeVoice.options[elBreezeVoice.selectedIndex].textContent
      : picked;
    try {
      const out = await api.post('/api/tts/test', {
        text: '你好呀，能听出这是我的声音吗？',
        provider,
        apiKey: elBreezeKey.value.trim() || undefined,
        voice: document.getElementById('s-tts-voice').value.trim(),
        rate: Number(document.getElementById('s-tts-rate').value),
        breeze: { ...breezeForm(), voiceId: picked },
      });
      elTtsAudio.src = out.dataUrl;
      elTtsAudio.play().catch(() => {});
      if (elBreezeMsg) {
        elBreezeMsg.textContent =
          '合成成功 · ' + Math.round((out.bytes || 0) / 1024) + ' KB · ' + out.format + (pickedName ? ' · ' + pickedName : '');
      }
    } catch (e) {
      if (elBreezeMsg) elBreezeMsg.textContent = '试听失败：' + e.message;
      toast(e.message, true);
    }
  };

  // ---------- 模型服务商 ----------
  const provSel = document.getElementById('s-prov');
  const elBase = document.getElementById('s-base');
  const elModel = document.getElementById('s-model');
  const elModels = document.getElementById('s-models');
  const elModelsHint = document.getElementById('s-models-hint');
  const elProvHint = document.getElementById('s-prov-hint');
  const elKey = document.getElementById('s-key');
  const elKeyHint = document.getElementById('s-keyhint');
  const presetOf = (id) => presets.find((x) => x.id === id) || null;
  let clearKey = false;

  const fillProvider = (id) => {
    const p = presetOf(id);
    const cfgP = configured[id] || null;
    elBase.value = (cfgP && cfgP.baseUrl) || p?.baseUrl || '';
    elModel.value = (cfgP && cfgP.model) || p?.model || '';
    const models = (cfgP && cfgP.models && cfgP.models.length ? cfgP.models : p?.models) || [];
    elModels.innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join('');
    elModelsHint.textContent = models.join(' / ') || '自定义';
    elProvHint.textContent = p?.note || (cfgP ? '这是之前配置过的服务商' : '');
    const elVision = document.getElementById('s-vision');
    const elVisionList = document.getElementById('s-vision-models');
    if (elVision) {
      elVision.value = id === c.llm.defaultProvider ? c.llm.visionModel || '' : p?.vision || '';
      if (!elVision.value) elVision.value = p?.vision || '';
    }
    if (elVisionList) elVisionList.innerHTML = p?.vision ? `<option value="${esc(p.vision)}"></option>` : '';
    const hasKey = !!cfgP?.hasKey;
    elKey.value = '';
    clearKey = false;
    elKey.placeholder = hasKey ? '已保存（留空表示不改）' : '留空 = 先不填，之后再补';
    elKeyHint.textContent = hasKey ? '已配置 key' : p?.noAuth ? '本地模型，不需要 key' : '还没有 key（可以先填服务商和模型，key 以后再补）';
    if (p?.keyUrl) elKeyHint.textContent += ' · 申请地址：' + p.keyUrl;
    const msg = document.getElementById('s-testmsg');
    if (msg) msg.textContent = '';
  };

  provSel.onchange = () => fillProvider(provSel.value);

  document.getElementById('s-models-refresh').onclick = () => {
    const p = presetOf(provSel.value);
    if (!p) return toast('自定义服务商没有预设模型名', true);
    elModel.value = p.model;
    elModels.innerHTML = (p.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
    elModelsHint.textContent = (p.models || []).join(' / ');
    toast('已填回预设模型名，记得保存');
  };

  document.getElementById('s-fetch').onclick = async (e) => {
    const btn = e.target;
    const msg = document.getElementById('s-testmsg');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '识别中…';
    msg.style.color = 'var(--fg-dim)';
    msg.textContent = '正在问服务商的 /models …';
    try {
      const r = await api.post('/api/llm/models', {
        id: provSel.value,
        baseUrl: elBase.value.trim(),
        apiKey: elKey.value.trim() || undefined,
      });
      if (!r.ok) {
        msg.style.color = 'var(--err)';
        msg.textContent = '识别失败：' + (r.error || '未知错误');
        return;
      }
      const ids = (r.models || []).map((m) => m.id);
      const visionIds = (r.models || []).filter((m) => m.vision).map((m) => m.id);
      elModels.innerHTML = ids.map((m) => `<option value="${esc(m)}"></option>`).join('');
      elModelsHint.textContent = ids.join(' / ');
      const vList = document.getElementById('s-vision-models');
      if (vList) vList.innerHTML = (visionIds.length ? visionIds : ids).map((m) => `<option value="${esc(m)}"></option>`).join('');
      if (ids.length && !elModel.value.trim()) elModel.value = ids[0];
      msg.style.color = 'var(--ok)';
      msg.textContent = `识别到 ${ids.length} 个模型${visionIds.length ? '（' + visionIds.length + ' 个支持图片）' : ''}，已填进下拉；记得点保存`;
    } catch (err) {
      msg.style.color = 'var(--err)';
      msg.textContent = '识别失败：' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };

  document.getElementById('s-keyclear').onclick = () => {
    clearKey = true;
    elKey.value = '';
    elKeyHint.textContent = '保存后会删掉已存的 key';
    elKey.placeholder = '保存后删除';
  };

  document.getElementById('s-test').onclick = async (e) => {
    const btn = e.target;
    const msg = document.getElementById('s-testmsg');
    btn.disabled = true;
    msg.style.color = 'var(--fg-dim)';
    msg.textContent = '测试中…（最多 30 秒）';
    try {
      const r = await api.post('/api/llm/test', {
        id: provSel.value,
        baseUrl: elBase.value.trim(),
        model: elModel.value.trim(),
        apiKey: elKey.value.trim() || undefined,
        noAuth: presetOf(provSel.value)?.noAuth,
      });
      msg.style.color = r.ok ? 'var(--ok)' : 'var(--err)';
      msg.textContent = r.ok ? `通了 · ${r.ms}ms · “${r.text || '（空回复）'}”` : `失败：${r.error || '未知错误'}`;
    } catch (err) {
      msg.style.color = 'var(--err)';
      msg.textContent = '失败：' + err.message;
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('s-save').onclick = async () => {
    if (elTtsProv.value === 'breeze') {
      const hasKeyNow = !!elBreezeKey.value.trim() || (!!tts.hasKey && !clearBreezeKey);
      if (!hasKeyNow) {
        toast('Breeze 还没填 API Key', true);
        return;
      }
      if (!elBreezeVoiceId.value.trim()) {
        toast('Breeze 还没选音色（voice_id）', true);
        return;
      }
    }
    const patch = {
      behavior: {
        readDelayMs: [Number(document.getElementById('s-read-min').value), Number(document.getElementById('s-read-max').value)],
        sendGapMs: [Number(document.getElementById('s-gap-min').value), Number(document.getElementById('s-gap-max').value)],
        splitMaxChars: Number(document.getElementById('s-split').value),
        maxSendPerHour: Number(document.getElementById('s-maxh').value),
        quietHours: {
          enabled: document.getElementById('s-quiet').checked,
          start: document.getElementById('s-quiet-s').value,
          end: document.getElementById('s-quiet-e').value,
        },
      },
      llm: {
        temperature: Number(document.getElementById('s-temp').value),
        maxTokens: Number(document.getElementById('s-maxtok').value),
        historyTurns: Number(document.getElementById('s-hist').value),
      },
      onebot: {
        kind: document.getElementById('s-kind').value,
        wsUrl: document.getElementById('s-ws').value.trim(),
        httpUrl: document.getElementById('s-http').value.trim(),
        accessToken: document.getElementById('s-token').value.trim(),
      },
    };
    try {
      const p = presetOf(provSel.value);
      const provRes = await api.post('/api/llm/provider', {
        id: provSel.value,
        baseUrl: elBase.value.trim(),
        model: elModel.value.trim(),
        apiKey: elKey.value.trim() || undefined,
        clearKey,
        noAuth: p ? !!p.noAuth : undefined,
        visionModel: document.getElementById('s-vision').value.trim(),
      });
      await api.post('/api/tts', {
        tts: {
          provider: elTtsProv.value,
          voice: document.getElementById('s-tts-voice').value.trim(),
          rate: Number(document.getElementById('s-tts-rate').value),
          breeze: breezeForm(),
        },
        apiKey: elBreezeKey.value.trim() || undefined,
        clearKey: clearBreezeKey,
      });
      await api.post('/api/config', patch);
      S.config = null;
      S.llmPresets = null;
      toast(provRes.hasKey ? '设置已保存' : '设置已保存（还没有 key，填了才会真正回话）');
      await refreshState();
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

/* ---------------- SSE ---------------- */
let ES = null;
function connectSSE() {
  if (ES) { try { ES.close(); } catch (e) {} }
  const es = new EventSource('/events');
  ES = es;
  es.addEventListener('hello', (e) => {
    try { S.state = JSON.parse(e.data); paintChrome(); } catch {}
  });
  es.addEventListener('onebot', (e) => {
    const d = JSON.parse(e.data);
    pushEvent('onebot', d.type + (d.selfId ? ` #${d.selfId}` : '') + (d.code ? ` code=${d.code}` : ''));
    refreshState();
  });
  es.addEventListener('agent', (e) => {
    const d = JSON.parse(e.data);
    const map = {
      thinking: () => `思考中 · ${d.persona || '无'} · ${d.model || ''}`,
      delta: () => `吐字 ${d.text || ''}`,
      sent: () => `已发 ${d.convId}: ${d.text}`,
      silent: () => `选择沉默 ${d.convId}`,
      message: () => `收到 ${d.convId}: ${d.userText}`,
      error: () => `错误 ${d.message}`,
    };
    if (d.type !== 'delta') pushEvent(d.type, (map[d.type] || (() => ''))());
    if (S.page === 'chat' && (d.type === 'sent' || d.type === 'message' || d.type === 'silent')) loadMessages();
    if (S.page === 'dashboard') refreshState();
  });
  es.onerror = () => {
    pushEvent('sse', '连接断开，3 秒后重连');
    setTimeout(connectSSE, 3000);
  };
}

function pushEvent(kind, text) {
  const now = Date.now();
  const last = S.events[S.events.length - 1];
  if (last && last.kind === kind && last.text === text && now - last.ts < 2000) return;
  S.events.push({ kind, text, ts: now });
  if (S.events.length > 200) S.events.shift();
  if (CTX.mounted === 'dashboard') paintDashboardEvents();
}


async function pageAssets(root) {
  let d;
  try {
    d = await api.get('/api/stickers');
  } catch (e) {
    root.innerHTML = '<div class="card"><h3>素材加载失败</h3><div class="hint">' + esc(e.message) + '</div></div>';
    return;
  }
  const all = (d.list || []).map((x) => ({ ...x, status: x.status || 'approved' }));
  const approved = all.filter((x) => x.status === 'approved');
  const pending = all.filter((x) => x.status === 'pending');
  const tab = S.assetsTab === 'pending' ? 'pending' : 'approved';
  const list = tab === 'pending' ? pending : approved;
  const target = S.conv || (S.state && S.state.access && S.state.access.ownerQQ ? 'private:' + S.state.access.ownerQQ : '');

  root.innerHTML = `
    <div class="card">
      <h3 style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <span class="row" style="gap:6px">
          <button class="btn sm ${tab === 'approved' ? 'primary' : ''}" data-tab="approved">已收录 ${approved.length}</button>
          <button class="btn sm ${tab === 'pending' ? 'primary' : ''}" data-tab="pending">待审核 ${pending.length}</button>
        </span>
        <span class="row">
          <button class="btn sm" id="a-import">导入旧库</button>
          <button class="btn sm" id="a-scan">扫描目录</button>
          ${tab === 'approved' ? '<button class="btn sm" id="a-auto">自动打标</button>' : ''}
        </span>
      </h3>
      <div class="hint" style="margin-bottom:10px">
        ${tab === 'approved'
          ? '✎ 改心情词；勾选后可批量删除。'
          : '这些是别人发来、被识别成"有情绪"的图。采纳才进素材库，丢弃会删文件。同情绪最多收 3 张。'}
      </div>
      <div class="row" style="margin-bottom:10px">
        <label class="switch"><input type="checkbox" id="a-all" /> 全选</label>
        <button class="btn sm danger" id="a-del">删除选中</button>
        <span class="muted" id="a-sel" style="font-size:12px">已选 0</span>
      </div>
      <div id="a-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px">
        ${list.map((it) => `
          <div class="asset" data-id="${esc(it.id)}" style="position:relative;background:var(--bg-3);border:1px solid var(--line);border-radius:10px;padding:8px;text-align:center">
            <input type="checkbox" class="asset-check" style="position:absolute;top:5px;left:5px;width:15px;height:15px;cursor:pointer" />
            <img src="/media/stickers/${encodeURIComponent(it.file)}" style="width:100%;height:76px;object-fit:contain;border-radius:6px" loading="lazy" />
            <div class="asset-label" style="font-size:11px;color:var(--fg-dim);margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.desc || '无备注')}</div>
            <div class="asset-edit" style="display:none;margin-top:4px;flex-direction:column;gap:4px">
              <input type="text" class="asset-input" value="${esc(it.desc || '')}" placeholder="心情词" style="font-size:12px;padding:3px 6px" />
              <div class="row" style="gap:4px">
                <button class="btn sm primary" data-save="1" style="flex:1;padding:2px 4px;font-size:11px">存</button>
                <button class="btn sm" data-cancel="1" style="padding:2px 4px;font-size:11px">消</button>
              </div>
            </div>
            ${tab === 'pending'
              ? '<div class="row" style="gap:4px;margin-top:4px"><button class="btn sm primary" data-ok="1" style="flex:1;padding:2px;font-size:11px">采纳</button><button class="btn sm danger" data-no="1" style="flex:1;padding:2px;font-size:11px">丢弃</button></div>'
              : '<button data-note="1" title="改心情词" style="position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;border:0;background:rgba(0,0,0,.62);color:#fff;font-size:12px;cursor:pointer">✎</button>'}
          </div>`).join('') || '<div class="empty">' + (tab === 'pending' ? '没有待审核的图' : '素材库是空的') + '</div>'}
      </div>
    </div>`;

  const grid = document.getElementById('a-grid');
  const selEl = document.getElementById('a-sel');
  const refreshSel = () => {
    const n = document.querySelectorAll('.asset-check:checked').length;
    if (selEl) selEl.textContent = '已选 ' + n;
  };

  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      S.assetsTab = b.dataset.tab;
      render();
    };
  });

  const allBox = document.getElementById('a-all');
  if (allBox) allBox.onchange = () => {
    document.querySelectorAll('.asset-check').forEach((c) => (c.checked = allBox.checked));
    refreshSel();
  };

  const delBtn = document.getElementById('a-del');
  if (delBtn) delBtn.onclick = async () => {
    const ids = [...document.querySelectorAll('.asset-check:checked')].map((c) => c.closest('.asset').dataset.id);
    if (!ids.length) return toast('先勾选要删的', true);
    delBtn.disabled = true;
    delBtn.textContent = '删除中…';
    try {
      const r = await api.post('/api/stickers/delete', { ids });
      toast('已删除 ' + r.deleted + ' 张');
      render();
    } catch (e) {
      toast(e.message, true);
      delBtn.disabled = false;
      delBtn.textContent = '删除选中';
    }
  };

  if (grid) {
    grid.addEventListener('click', async (ev) => {
      const tile = ev.target.closest('.asset');
      if (!tile) return;
      const id = tile.dataset.id;

      if (ev.target.dataset.note) {
        const edit = tile.querySelector('.asset-edit');
        edit.style.display = edit.style.display === 'flex' ? 'none' : 'flex';
        if (edit.style.display === 'flex') tile.querySelector('.asset-input').focus();
        return;
      }
      if (ev.target.dataset.cancel) {
        tile.querySelector('.asset-edit').style.display = 'none';
        return;
      }
      if (ev.target.dataset.save) {
        const val = tile.querySelector('.asset-input').value.trim();
        try {
          await api.post('/api/stickers/remark', { id, desc: val, tags: val ? [val] : [] });
          tile.querySelector('.asset-label').textContent = val || '无备注';
          tile.querySelector('.asset-edit').style.display = 'none';
          toast('已保存：' + (val || '（清空）'));
        } catch (e) {
          toast(e.message, true);
        }
        return;
      }
      if (ev.target.dataset.ok || ev.target.dataset.no) {
        const approve = !!ev.target.dataset.ok;
        try {
          await api.post('/api/stickers/review', { id, action: approve ? 'approve' : 'reject' });
          toast(approve ? '已采纳' : '已丢弃');
          render();
        } catch (e) {
          toast(e.message, true);
        }
        return;
      }
      if (ev.target.classList.contains('asset-check')) return;

    });
    grid.addEventListener('change', (ev) => {
      if (ev.target.classList.contains('asset-check')) refreshSel();
    });
  }

  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };

  bind('a-import', async () => {
    toast('导入中，请稍等…');
    try { const r = await api.post('/api/stickers/import'); toast('新增 ' + r.added + ' 张'); render(); }
    catch (e) { toast(e.message, true); }
  });
  bind('a-scan', async () => {
    try { const r = await api.post('/api/stickers/scan'); toast('新增 ' + r.added + ' 张'); render(); }
    catch (e) { toast(e.message, true); }
  });
  bind('a-auto', async (ev) => {
    const b = ev.target;
    const old = b.textContent;
    b.disabled = true;
    b.textContent = '标注中…';
    try {
      const r = await api.post('/api/stickers/autotag', { limit: 6 });
      toast('标注 ' + r.tagged + ' 张，还剩 ' + r.left);
      render();
    } catch (e) {
      toast(e.message, true);
      b.disabled = false;
      b.textContent = old;
    }
  });
}


async function pageZone(root) {
  let d;
  try {
    d = await api.get('/api/zone/drafts');
  } catch (e) {
    root.innerHTML = '<div class="card"><h3>加载失败</h3><div class="hint">' + esc(e.message) + '</div></div>';
    return;
  }
  const drafts = d.list || [];
  root.innerHTML = `
    <div class="card">
      <h3 style="display:flex;justify-content:space-between;align-items:center">
        <span>说说草稿（${drafts.length}）</span>
        <button class="btn sm primary" id="z-gen">让她写一条</button>
      </h3>
      <div class="hint" style="margin-bottom:12px">
        她按今天的记忆和心情写草稿 → 你看、改 → 点「复制并打开空间」，正文已进剪贴板，你粘上发出去。
        不做自动发布：空间自动发太容易踩风控。
      </div>
      <div id="z-list">
        ${drafts.length ? drafts.map((it) => `
          <div class="card" style="margin-bottom:10px;background:var(--bg-3)">
            <div class="row" style="justify-content:space-between;margin-bottom:8px">
              <span class="tag ${it.status === 'published' ? 'on' : ''}">${it.status === 'published' ? '已发布' : '草稿'}</span>
              <span class="muted" style="font-size:11px">${it.mood ? esc(it.mood) + ' · ' : ''}${new Date(it.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
            </div>
            <textarea data-id="${it.id}" style="height:74px;background:#0a0c11">${esc(it.text)}</textarea>
            ${it.imageHint ? '<div class="hint">配图建议：' + esc(it.imageHint) + '</div>' : ''}
            <div class="row wrap" style="margin-top:8px">
              <button class="btn sm primary" data-pub="${it.id}">复制并打开空间</button>
              <button class="btn sm" data-save="${it.id}">保存修改</button>
              <button class="btn sm danger" data-del="${it.id}">删除</button>
            </div>
          </div>`).join('') : '<div class="empty">还没有草稿。点右上角「让她写一条」。</div>'}
      </div>
    </div>`;

  const gen = document.getElementById('z-gen');
  if (gen) gen.onclick = async () => {
    gen.disabled = true;
    gen.textContent = '正在写…';
    try {
      await api.post('/api/zone/generate', { conv: S.conv });
      toast('草稿写好了');
      render();
    } catch (e) { toast(e.message, true); gen.disabled = false; gen.textContent = '让她写一条'; }
  };
  document.querySelectorAll('[data-pub]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.pub;
      const ta = document.querySelector('textarea[data-id="' + id + '"]');
      try {
        await api.post('/api/zone/publish', { id, text: ta ? ta.value : undefined });
        toast('已复制到剪贴板，去空间粘贴发布');
        render();
      } catch (e) { toast(e.message, true); }
    };
  });
  document.querySelectorAll('[data-save]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.save;
      const ta = document.querySelector('textarea[data-id="' + id + '"]');
      try {
        await api.post('/api/zone/update', { id, text: ta.value });
        toast('已保存');
      } catch (e) { toast(e.message, true); }
    };
  });
  document.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api.post('/api/zone/delete', { id: b.dataset.del });
        render();
      } catch (e) { toast(e.message, true); }
    };
  });
}


const DEFAULT_RULES = "- 你是在 QQ 上打字。一条只发一小句，平均不超过 25 字。\n- 想发几条就换行分开（每行一条），我会隔一两秒逐条发出去，像真的在一句句打。\n- 一次回复通常 1~2 条；情绪上来时可以 3~4 条小碎片，但每条都要短。\n- 不要 Markdown、不要列表、不要加粗、不要小标题。\n- 不要总结、不要升华、不要说\"作为AI\"、不要客服腔、不要每次都反问。\n- 允许只回一个字、一个\"嗯\"、一句\"啊？\"。允许敷衍、允许冷淡、允许不接话。\n- 不是每条都必须回。跟你无关、或者接不上话，就只输出 [SILENT]，我会保持沉默。\n- 不确定的事就说不记得，不要编造记忆。\n- 对方隔了很久才回你，可以像真人一样先反应一下（\"诶 你终于出现了\"）。";

async function pageTune(root) {
  const c = S.config || (S.config = await api.get('/api/config'));
  const b = c.behavior || {};
  const m = c.media || {};
  const t = c.tts || {};
  const md = c.mood || {};
  const wk = c.wake || {};
  const rd = b.readDelayMs || [600, 2200];
  const gap = b.sendGapMs || [800, 2600];
  const quiet = b.quietHours || { enabled: false, start: '01:30', end: '09:00' };
  const rules = (c.prompt && c.prompt.rules) || '';

  root.innerHTML = `
    <div class="grid c2">
      <div class="card">
        <h3>说话节奏</h3>
        <div class="grid c2" style="gap:10px">
          <div class="field"><label>单条最长字数（超过就拆条）</label><input type="number" id="u-split" value="${b.splitMaxChars ?? 32}" /><div class="hint">25~35 最像聊天软件</div></div>
          <div class="field"><label>回不回的阈值（0~1）</label><input type="number" id="u-replyp" step="0.05" min="0" max="1" value="${b.replyProbability ?? 0.85}" /><div class="hint">只影响群里；跟你私聊和被 @ 永远回</div></div>
          <div class="field"><label>群里攒批：安静多久才回 ms</label><input type="number" id="u-batch-quiet" value="${b.groupBatchQuietMs ?? 1500}" /><div class="hint">最后一条之后等这么久，期间再来消息就继续等；0 = 关（回到一条一回）</div></div>
          <div class="field"><label>群里最多攒多久 ms</label><input type="number" id="u-batch-max" value="${b.groupBatchMaxWaitMs ?? 8000}" /><div class="hint">刷屏刷不停也不会一直不回，到点就开口</div></div>
          <div class="field"><label>两次开口最小间隔 ms</label><input type="number" id="u-group-gap" value="${b.groupMinGapMs ?? 4000}" /><div class="hint">说完一句后至少隔这么久才会再接话，只影响群聊</div></div>
          <div class="field"><label>已读延迟下限 ms</label><input type="number" id="u-read-min" value="${rd[0]}" /></div>
          <div class="field"><label>已读延迟上限 ms</label><input type="number" id="u-read-max" value="${rd[1]}" /></div>
          <div class="field"><label>分条间隔下限 ms</label><input type="number" id="u-gap-min" value="${gap[0]}" /></div>
          <div class="field"><label>分条间隔上限 ms</label><input type="number" id="u-gap-max" value="${gap[1]}" /></div>
        </div>
      </div>

      <div class="card">
        <h3>打字与限额</h3>
        <div class="grid c2" style="gap:10px">
          <div class="field"><label>每字打字耗时 ms</label><input type="number" id="u-typing" value="${b.typingMsPerChar ?? 55}" /></div>
          <div class="field"><label>单条最长打字 ms</label><input type="number" id="u-typing-max" value="${b.typingMaxMs ?? 6000}" /></div>
          <div class="field"><label>每分钟最多发送</label><input type="number" id="u-per-min" value="${b.maxSendPerMinute ?? 8}" /></div>
          <div class="field"><label>每小时最多发送</label><input type="number" id="u-per-hour" value="${b.maxSendPerHour ?? 60}" /></div>
        </div>
        <div class="hint">现在真的会拦：达到上限这条就不发了，日志里会写原因。填 0 = 不限。</div>
      </div>

      <div class="card">
        <h3>表情与语音</h3>
        <div class="grid c2" style="gap:10px">
          <div class="field"><label>随机补表情概率</label><input type="number" id="u-sticker-p" step="0.01" min="0" max="1" value="${m.autoStickerProbability ?? 0.05}" /></div>
          <div class="field"><label>表情库上限（张）</label><input type="number" id="u-sticker-max" value="${m.maxStickers ?? 500}" /></div>
        </div>
        <label class="switch" style="margin:6px 0"><input type="checkbox" id="u-collect" ${m.collectIncoming ? 'checked' : ''} /> 自动收集对方发来的图片当素材</label>
        <label class="switch" style="margin:6px 0"><input type="checkbox" id="u-tts" ${t.enabled ? 'checked' : ''} /> 允许她发语音</label>
        <div class="hint">音色、语速、在线 TTS（Breeze）都在「设置 → 语音（TTS）」里改。</div>
        <div class="field"><label>单条语音最长字数</label><input type="number" id="u-tts-max" value="${t.maxChars ?? 200}" /></div>
      </div>

      <div class="card">
        <h3>记忆</h3>
        <div class="field"><label>人格卡注入上限（字）</label><input type="number" id="u-inject" value="${c.persona.maxInjectChars ?? 6000}" /><div class="hint">超出的部分会被截断；3000~5000 比较划算</div></div>
        <div class="hint">
          事实档案不再全量塞：按「和这句话相关度 + 鲜活度 + 重要度」挑 6 条（可调）。
          日记注入最近 3 天；更早的靠滚动摘要。亲密度每回一条 +0.6（上限 100）。
        </div>
      </div>

      <div class="card" style="grid-column: 1 / -1">
        <h3>主动搭话（掷骰子）</h3>
        <div class="hint">
          每轮先本地掷骰（0 token），掷中了才让她走一轮模型。命中线 =
          基础命中线 × 时机因子（刚聊过 ×${wk.nearFactor ?? 0.15} / 冷太久 ×${wk.farFactor ?? 1.5}）× 心情因子 + 连续没中的加成。
          掷中是「给她一个动机」，说不说、怎么说还是她自己决定（可以只输出 [SILENT] 保持沉默）。
        </div>
        <div class="wake-now" id="wake-now">读取中…</div>
        <div class="row wrap" style="gap:18px">
          <label class="switch"><input type="checkbox" id="w-enabled" ${wk.enabled ? 'checked' : ''} /> 启用主动搭话</label>
          <label class="switch"><input type="checkbox" id="w-dry" ${wk.dryRun !== false ? 'checked' : ''} /> 试运行（只记账，不真发）</label>
          <label class="switch"><input type="checkbox" id="w-groups" ${wk.allowGroups ? 'checked' : ''} /> 群聊也允许</label>
        </div>
        <div class="grid c2" style="gap:10px;margin-top:10px">
          <div class="field"><label>检查间隔（秒）</label><input type="number" id="w-tick" value="${wk.tickSec ?? 60}" /></div>
          <div class="field"><label>最短间隔（分钟）</label><input type="number" id="w-gap-min" value="${wk.minGapMin ?? 20}" /></div>
          <div class="field"><label>最长间隔（分钟）</label><input type="number" id="w-gap-max" value="${wk.maxGapMin ?? 90}" /></div>
          <div class="field"><label>基础命中线（%）</label><input type="number" id="w-base" value="${wk.baseHit ?? 18}" /></div>
          <div class="field"><label>搭话冷却（分钟）</label><input type="number" id="w-cool" value="${wk.cooldownMin ?? 30}" /></div>
          <div class="field"><label>每日上限（次）</label><input type="number" id="w-cap" value="${wk.dailyCap ?? 3}" /></div>
          <div class="field"><label>连续没中加成（百分点/次）</label><input type="number" id="w-miss" value="${wk.missBonus ?? 8}" /></div>
          <div class="field"><label>加成上限（百分点）</label><input type="number" id="w-misscap" value="${wk.missCap ?? 30}" /></div>
        </div>
        <div class="field"><label>触发文案（她的动机，不是系统提示）</label><input type="text" id="w-motive" value="${esc(wk.motive || '好久没人跟我说话了，我该主动去打个招呼')}" /></div>
        <div class="field">
          <label>安静时段（这条同时管「收到消息不回」和「不去吵你」）</label>
          <div class="row">
            <label class="switch"><input type="checkbox" id="q-on" style="width:auto" ${quiet.enabled ? 'checked' : ''} /> 启用</label>
            <input type="text" id="q-start" value="${esc(quiet.start || '01:30')}" style="max-width:90px" />
            <span class="muted">~</span>
            <input type="text" id="q-end" value="${esc(quiet.end || '09:00')}" style="max-width:90px" />
            <span class="hint" style="margin:0">跨午夜也行（23:00 ~ 07:00）</span>
          </div>
        </div>
        <div class="field">
          <label>目标会话（不勾 = 只对主人私聊）</label>
          <div class="wake-targets" id="wake-targets">读取中…</div>
        </div>
        <div class="row wrap" style="margin-top:10px">
          <button class="btn sm" id="w-dry-btn">演练一次（不花钱、不真发）</button>
          <button class="btn sm" id="w-send-btn">真发一次（跳过等待）</button>
          <button class="btn sm" id="w-refresh">刷新记录</button>
        </div>
        <div class="wake-log" id="wake-log" style="margin-top:10px">读取中…</div>
      </div>

      <div class="card" style="grid-column: 1 / -1">
        <h3>情绪</h3>
        <div class="hint">
          每轮先在本地判（不花钱）：被夸、被凶、他说累了这类明显信号才会动。
          每 N 轮或遇到强信号时请模型复核一次；模型没底（置信度低于门槛）只记账，不会进她的嘴。
          心情会按半衰期往基线回落，同一次变化只告诉她一次。
        </div>
        <div class="wake-now" id="mood-now">读取中…</div>
        <div class="row wrap" style="gap:18px">
          <label class="switch"><input type="checkbox" id="m-enabled" ${md.enabled !== false ? 'checked' : ''} /> 启用情绪</label>
          <label class="switch"><input type="checkbox" id="m-wake" ${md.influenceWake !== false ? 'checked' : ''} /> 心情影响主动开口概率</label>
        </div>
        <div class="grid c2" style="gap:10px;margin-top:10px">
          <div class="field"><label>基线心情（没情绪时回落到这）</label><input type="number" id="m-base" value="${md.baseline ?? 68}" /></div>
          <div class="field"><label>心情下限</label><input type="number" id="m-floor" value="${md.floor ?? 15}" /></div>
          <div class="field"><label>心情半衰期（分钟）</label><input type="number" id="m-half" value="${md.halfLifeMin ?? 180}" /></div>
          <div class="field"><label>情绪半衰期（分钟）</label><input type="number" id="m-ehalf" value="${md.emotionHalfLifeMin ?? 90}" /></div>
          <div class="field"><label>每几轮请模型复核一次</label><input type="number" id="m-every" value="${md.judgeEvery ?? 5}" /><div class="hint">填 0 = 只在强信号时复核</div></div>
          <div class="field"><label>置信度门槛（低于只记账）</label><input type="number" id="m-gate" value="${md.confidenceGate ?? 55}" /></div>
        </div>
        <div class="field"><label>怎么告诉她</label>
          <select id="m-inject">
            <option value="event" ${md.inject === 'event' ? 'selected' : ''}>只说「刚才心里那一下」（推荐）</option>
            <option value="value" ${md.inject === 'value' ? 'selected' : ''}>只说心情值</option>
            <option value="off" ${md.inject === 'off' ? 'selected' : ''}>不告诉她（只看不注入）</option>
          </select>
        </div>
        <div class="row wrap" style="margin-top:8px">
          <div class="spacer" style="flex:1"></div>
          <button class="btn sm" id="m-reset">重置到基线</button>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:12px">
      <h3>系统提示词 · 说话规则</h3>
      <div class="hint" style="margin-bottom:8px">这一段的优先级高于人格卡。改坏了点右边「恢复默认」。</div>
      <textarea id="u-rules" style="height:210px">${esc(rules)}</textarea>
      <div class="row wrap" style="margin-top:10px">
        <button class="btn" id="u-rules-reset">恢复默认规则</button>
      </div>
    </div>

    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="u-save">保存全部</button>
      <span class="hint" style="margin:0">保存后下一条消息生效；主动搭话/情绪的参数下一轮就用新值</span>
    </div>
  `;

  const n = (id) => Number(document.getElementById(id).value);
  const val = (id) => document.getElementById(id).value.trim();
  const on = (id) => document.getElementById(id).checked;

  // ---------- 主动搭话：状态 / 记录 / 目标会话 ----------
  const loadWake = async () => {
    let w;
    try {
      w = await api.get('/api/wake');
    } catch (e) {
      const box = document.getElementById('wake-now');
      if (box) box.textContent = '读取失败：' + e.message;
      return;
    }
    const box = document.getElementById('wake-now');
    if (box) {
      const t0 = w.targets?.[0];
      const hit = t0?.hit;
      box.innerHTML = `
        <div><span class="k">状态</span>${w.enabled ? '<b class="badge-on">已启用</b>' : '<b class="badge-off">未启用</b>'}${w.dryRun ? ' · 试运行' : ''}</div>
        <div><span class="k">本轮命中线</span><b>${hit ? hit.hit + '%' : '—'}</b></div>
        <div><span class="k">构成</span>${hit ? `${hit.base}% × ${hit.factor} × 心情${hit.moodFactor} + 连续没中 ${hit.bonus}` : '—'}</div>
        <div><span class="k">时机</span>${hit ? esc(hit.tag) : '—'}</div>
        <div><span class="k">今天开口</span>${t0 ? `${t0.count}/${w.dailyCap}` : '—'}</div>
        <div><span class="k">现在</span>${t0?.skip ? esc(t0.skip) : '可以掷骰'}</div>`;
    }
    const targetsBox = document.getElementById('wake-targets');
    if (targetsBox) {
      const picked = new Set(w.configured || wk.targets || []);
      const list = (w.allConvs || []).slice(0, 14);
      targetsBox.innerHTML = list.length
        ? list.map((id) => `<label><input type="checkbox" value="${esc(id)}" ${picked.has(id) ? 'checked' : ''} />${esc(id)}</label>`).join('')
        : '<span class="hint" style="margin:0">还没有会话，先聊两句</span>';
    }
    const logBox = document.getElementById('wake-log');
    if (logBox) {
      logBox.innerHTML = (w.log || []).length
        ? w.log
            .map(
              (r) => `<div class="row-line ${r.fired ? 'fired' : ''}">
                <span class="ts">${fmtTime(r.ts)}</span>
                <span class="cid">${esc(r.convId)}</span>
                <span class="hit">${r.roll == null ? '—' : r.roll.toFixed(1)}</span>
                <span class="txt">${r.fired ? (r.dry ? '[试运行] ' : '开口了 · ') : ''}${esc(r.detail || '')}</span>
              </div>`
            )
            .join('')
        : '<div class="hint" style="margin:0">还没有记录。点「演练一次」就能看到一次掷骰结果。</div>';
    }
  };

  // ---------- 情绪：当前值 ----------
  const loadMood = async () => {
    const box = document.getElementById('mood-now');
    if (!box) return;
    try {
      const d = await api.get('/api/mood');
      const cur = d.current || {};
      const moods = MOOD_ORDER.map((e) => `${e} ${Math.round(cur.moods?.[e] || 0)}`).join(' · ');
      box.innerHTML = `
        <div><span class="k">心情</span><b>${Math.round(cur.score ?? 68)}</b> <span class="muted">${esc(cur.label || '')}</span></div>
        <div><span class="k">情绪</span>${esc(moods)}</div>
        <div><span class="k">上一句心里话</span>${esc(cur.reason || '—')}</div>`;
    } catch (e) {
      box.textContent = '读取失败：' + e.message;
    }
  };

  document.getElementById('u-rules-reset').onclick = () => {
    document.getElementById('u-rules').value = DEFAULT_RULES;
    toast('已填回默认规则，记得点保存');
  };

  const save = async () => {
    const patch = {
      behavior: {
        splitMaxChars: n('u-split'),
        replyProbability: n('u-replyp'),
        groupBatchQuietMs: n('u-batch-quiet'),
        groupBatchMaxWaitMs: n('u-batch-max'),
        groupMinGapMs: n('u-group-gap'),
        readDelayMs: [n('u-read-min'), n('u-read-max')],
        sendGapMs: [n('u-gap-min'), n('u-gap-max')],
        typingMsPerChar: n('u-typing'),
        typingMaxMs: n('u-typing-max'),
        maxSendPerMinute: n('u-per-min'),
        maxSendPerHour: n('u-per-hour'),
        quietHours: { enabled: on('q-on'), start: val('q-start') || '01:30', end: val('q-end') || '09:00' },
      },
      media: {
        autoStickerProbability: n('u-sticker-p'),
        maxStickers: n('u-sticker-max'),
        collectIncoming: on('u-collect'),
      },
      tts: {
        enabled: on('u-tts'),
        maxChars: n('u-tts-max'),
      },
      persona: { maxInjectChars: n('u-inject') },
      prompt: { rules: document.getElementById('u-rules').value },
      mood: {
        enabled: on('m-enabled'),
        influenceWake: on('m-wake'),
        baseline: n('m-base'),
        floor: n('m-floor'),
        halfLifeMin: n('m-half'),
        emotionHalfLifeMin: n('m-ehalf'),
        judgeEvery: n('m-every'),
        confidenceGate: n('m-gate'),
        inject: val('m-inject'),
      },
      wake: {
        enabled: on('w-enabled'),
        dryRun: on('w-dry'),
        allowGroups: on('w-groups'),
        tickSec: n('w-tick'),
        minGapMin: n('w-gap-min'),
        maxGapMin: n('w-gap-max'),
        baseHit: n('w-base'),
        cooldownMin: n('w-cool'),
        dailyCap: n('w-cap'),
        missBonus: n('w-miss'),
        missCap: n('w-misscap'),
        motive: val('w-motive'),
        targets: [...document.querySelectorAll('#wake-targets input:checked')].map((x) => x.value),
      },
    };
    await api.post('/api/config', patch);
    S.config = null;
    toast('调参已保存');
    await refreshState();
    await loadWake();
    await loadMood();
  };

  document.getElementById('u-save').onclick = async () => {
    try {
      await save();
    } catch (e) {
      toast(e.message, true);
    }
  };

  // 自动保存勾选清单（跟 speak-up 一样：勾一下就存，不用再按保存）
  const targetsBox = document.getElementById('wake-targets');
  targetsBox.addEventListener('change', async (e) => {
    if (!e.target.matches('input[type=checkbox]')) return;
    try {
      await api.post('/api/wake/config', { targets: [...document.querySelectorAll('#wake-targets input:checked')].map((x) => x.value) });
      toast('目标会话已保存');
      await loadWake();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById('w-dry-btn').onclick = async (e) => {
    const btn = e.target;
    btn.disabled = true;
    try {
      const r = await api.post('/api/wake/dry', {});
      toast(r.fired ? `掷出 ${r.roll}，命中线 ${r.hit} → 会开口（只记账）` : `掷出 ${r.roll}，命中线 ${r.hit} → 这次不开口`);
      await loadWake();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('w-send-btn').onclick = async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const r = await api.post('/api/wake/send', {});
      const res = r.result || {};
      toast(res.silent ? '她选择不说' : res.dry ? '当前是试运行，只记账没发' : '已经让她开口了', !!res.error);
      await loadWake();
      await refreshState();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '真发一次（跳过等待）';
    }
  };

  document.getElementById('w-refresh').onclick = () => loadWake();

  document.getElementById('m-reset').onclick = async () => {
    try {
      await api.post('/api/mood/reset', {});
      toast('心情已重置到基线');
      await refreshState();
      await loadMood();
    } catch (e) {
      toast(e.message, true);
    }
  };

  await Promise.all([loadWake(), loadMood()]);
}

async function pageSlang(root) {
  let d;
  try {
    d = await api.get('/api/slang');
  } catch (e) {
    root.innerHTML = '<div class="card"><h3>加载失败</h3><div class="hint">' + esc(e.message) + '</div></div>';
    return;
  }
  const list = (d.list || []).slice().sort((a, b) => (b.count || 0) - (a.count || 0));
  root.innerHTML = `
    <div class="card">
      <h3>词库（${list.length} 条）</h3>
      <div class="hint" style="margin-bottom:10px">
        她会在提示词里看到排在前 14 的高频词。改完立刻生效，不用重启。
      </div>
      <div class="row" style="margin-bottom:12px">
        <input type="text" id="w-word" placeholder="词，如：朋友费" style="max-width:160px" />
        <input type="text" id="w-mean" placeholder="含义（她靠这个理解）" />
        <button class="btn sm primary" id="w-add">添加 / 覆盖</button>
      </div>
      <table class="tbl">
        <thead><tr><th style="width:120px">词</th><th>含义</th><th style="width:70px">次数</th><th style="width:60px">操作</th></tr></thead>
        <tbody>
          ${list.map((it) => `
            <tr data-w="${esc(it.content)}">
              <td class="mono">${esc(it.content)}</td>
              <td><input type="text" value="${esc(it.meaning || '')}" data-f="meaning" /></td>
              <td class="muted">${it.count || 0}</td>
              <td><button class="btn sm danger" data-del="${esc(it.content)}">删</button></td>
            </tr>`).join('') || '<tr><td colspan="4" class="empty">词库是空的</td></tr>'}
        </tbody>
      </table>
    </div>`;

  document.getElementById('w-add').onclick = async () => {
    const content = document.getElementById('w-word').value.trim();
    const meaning = document.getElementById('w-mean').value.trim();
    if (!content || !meaning) return toast('词和含义都要填', true);
    try {
      await api.post('/api/slang', { content, meaning });
      toast('已保存');
      render();
    } catch (e) {
      toast(e.message, true);
    }
  };

  document.querySelectorAll('tr[data-w] input').forEach((inp) => {
    inp.onchange = async () => {
      const tr = inp.closest('tr');
      try {
        await api.post('/api/slang', { content: tr.dataset.w, meaning: inp.value.trim() });
        toast('已更新');
      } catch (e) {
        toast(e.message, true);
      }
    };
  });

  document.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删掉「' + b.dataset.del + '」？')) return;
      try {
        await api.post('/api/slang', { action: 'delete', content: b.dataset.del });
        render();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
}

boot();
