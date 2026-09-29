// 主逻辑：串联 UI、连接管理、序号分析、持久化与时序图
const $ = (id) => document.getElementById(id);
const els = {
  url: $('ws-url'), seqField: $('seq-field'), timeout: $('connect-timeout'),
  maxReconnect: $('max-reconnect'), btnConnect: $('btn-connect'), btnDisconnect: $('btn-disconnect'),
  connError: $('conn-error'), compTemplate: $('comp-template'), compEnabled: $('comp-enabled'),
  sendInput: $('send-input'), sendAutoSeq: $('send-auto-seq'), btnSend: $('btn-send'),
  state: $('conn-state'), statReconnect: $('stat-reconnect'), statCompensate: $('stat-compensate'),
  statCompensated: $('stat-compensated'), statOos: $('stat-oos'), statDup: $('stat-dup'),
  statLost: $('stat-lost'), msgBody: $('msg-body'), btnClear: $('btn-clear'),
  filterDup: $('filter-dup'),
};

const store = new MessageStore();
const sequencer = new Sequencer();
const timeline = new Timeline($('timeline'));
let conn = null;
let sendSeq = 0;       // 本端发送自增序号
let maxRecvSeq = -1;   // 已收到的最大对端序号（补偿起点）
let rowCount = 0;

const STATE_TEXT = {
  idle: '未连接', connecting: '连接中…', open: '已连接',
  reconnecting: '重连中…', closed: '已断开', failed: '连接失败',
};

function setState(s) {
  els.state.textContent = STATE_TEXT[s] || s;
  els.state.className = 'badge state-' + s;
  const open = s === 'open';
  els.btnSend.disabled = !open;
  els.btnConnect.disabled = open || s === 'connecting' || s === 'reconnecting';
  els.btnDisconnect.disabled = !(open || s === 'connecting' || s === 'reconnecting');
}

function showError(kind, message) {
  const prefix = { invalid: '[地址非法]', timeout: '[连接超时]', failed: '[连接失败]',
    dropped: '[断线]', 'max-reconnect': '[重连上限]', send: '[发送]' }[kind] || '[错误]';
  els.connError.hidden = false;
  els.connError.textContent = `${new Date().toLocaleTimeString()} ${prefix} ${message}`;
  setTimeout(() => { els.connError.hidden = true; }, 8000);
}

function extractSeq(payload) {
  try {
    const obj = JSON.parse(payload);
    const v = obj[els.seqField.value.trim() || 'seq'];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

function renderRow(rec) {
  const tr = document.createElement('tr');
  if (rec.tags.includes('dup')) {
    tr.classList.add('row-dup');
    if (!els.filterDup.checked) tr.classList.add('hidden-row');
  }
  const tagHtml = rec.tags.map((t) => {
    const label = { oos: '乱序', dup: '重复', comp: '补偿补回' }[t] || t;
    return `<span class="tag tag-${t}">${label}</span>`;
  }).join('');
  tr.innerHTML =
    `<td>${++rowCount}</td>` +
    `<td>${rec.seq ?? '-'}</td>` +
    `<td>${new Date(rec.ts).toLocaleTimeString('zh-CN', { hour12: false })}.${String(rec.ts % 1000).padStart(3, '0')}</td>` +
    `<td class="dir-${rec.dir}">${rec.dir === 'send' ? '发送 ↑' : '接收 ↓'}</td>` +
    `<td>${tagHtml}</td>` +
    `<td class="content" title="${rec.payload.replace(/"/g, '&quot;')}">${rec.payload}</td>`;
  els.msgBody.appendChild(tr);
  tr.scrollIntoView({ block: 'nearest' });
}

function updateStats(s) {
  els.statOos.textContent = s.outOfOrder;
  els.statDup.textContent = s.duplicate;
  els.statLost.textContent = s.lost;
  els.statCompensated.textContent = s.compensated;
}

async function recordMessage(dir, payload) {
  const seq = extractSeq(payload);
  const rec = { ts: Date.now(), dir, seq, payload, tags: [] };
  if (dir === 'recv' && seq !== null) {
    const res = await sequencer.ingest(rec.ts + '-' + Math.random(), seq);
    rec.tags = res.tags;
    updateStats(res.stats);
    if (seq > maxRecvSeq) maxRecvSeq = seq;
    if (res.drop) {
      // 重复消息：去重——仍记录到历史并标记，但默认在表格中隐藏
      rec.tags = ['dup'];
    }
  }
  rec.id = await store.add(rec);
  renderRow(rec);
  timeline.addEvent({ ts: rec.ts, dir, tags: rec.tags });
}

function buildConnection() {
  conn = new WSConnection({
    onState: (s) => setState(s),
    onMessage: (data) => recordMessage('recv', typeof data === 'string' ? data : '[二进制消息]'),
    onError: (e) => showError(e.kind, e.message),
    onReconnect: (n, delay) => {
      els.statReconnect.textContent = n;
      showError('dropped', `第 ${n} 次重连，${delay}ms 后发起（退避）`);
    },
    onCompensate: (attempt, after, err) => {
      els.statCompensate.textContent = conn.compensateCount;
      if (err) showError('dropped', err);
    },
  });
  conn.getLastSeq = () => maxRecvSeq;
  return conn;
}

els.btnConnect.onclick = () => {
  els.connError.hidden = true;
  const c = buildConnection();
  c.connectTimeout = Math.max(1000, Number(els.timeout.value) || 8000);
  c.maxReconnect = Math.max(0, Number(els.maxReconnect.value) || 0);
  c.compEnabled = els.compEnabled.checked;
  c.compTemplate = els.compTemplate.value || c.compTemplate;
  c.connect(els.url.value);
};

els.btnDisconnect.onclick = () => { if (conn) conn.disconnect(); };

els.btnSend.onclick = () => {
  let text = els.sendInput.value;
  if (!text) return;
  if (els.sendAutoSeq.checked) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const field = els.seqField.value.trim() || 'seq';
        if (typeof obj[field] !== 'number') obj[field] = ++sendSeq;
        text = JSON.stringify(obj);
      }
    } catch { /* 非 JSON 原文发送 */ }
  }
  if (conn && conn.send(text)) {
    recordMessage('send', text);
    els.sendInput.value = '';
  }
};
els.sendInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.btnSend.click(); });

els.btnClear.onclick = async () => {
  await store.clear();
  sequencer.reset();
  timeline.clear();
  els.msgBody.innerHTML = '';
  rowCount = 0; maxRecvSeq = -1;
  updateStats({ outOfOrder: 0, duplicate: 0, lost: 0, compensated: 0 });
  els.statReconnect.textContent = '0';
  els.statCompensate.textContent = '0';
};

els.filterDup.onchange = () => {
  document.querySelectorAll('#msg-body tr.row-dup').forEach((tr) =>
    tr.classList.toggle('hidden-row', !els.filterDup.checked));
};

// 页面卸载清理：关闭连接、终止 Worker、关闭数据库
window.addEventListener('pagehide', () => {
  if (conn) conn.destroy();
  sequencer.terminate();
  store.close();
});

(async function init() {
  setState('idle');
  await store.open();
  const history = await store.getAll();
  history.sort((a, b) => a.ts - b.ts);
  for (const rec of history) {
    if (rec.dir === 'recv' && typeof rec.seq === 'number') {
      const res = await sequencer.ingest('hist-' + rec.id, rec.seq);
      updateStats(res.stats);
      if (rec.seq > maxRecvSeq) maxRecvSeq = rec.seq;
    }
    renderRow(rec);
    timeline.addEvent({ ts: rec.ts, dir: rec.dir, tags: rec.tags || [] });
  }
})();
