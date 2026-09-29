/*
 * 主线程：DOM 渲染、与 Worker 通信、IndexedDB 持久化、统计汇总、
 * Canvas 数据供给、页面卸载清理。无任何框架。
 */
(function () {
  'use strict';

  const els = {
    url: document.getElementById('wsUrl'),
    btnConnect: document.getElementById('btnConnect'),
    btnDisconnect: document.getElementById('btnDisconnect'),
    btnClear: document.getElementById('btnClear'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    statusHint: document.getElementById('statusHint'),
    reconnectCount: document.getElementById('reconnectCount'),
    compensationCount: document.getElementById('compensationCount'),
    compensatedMsgCount: document.getElementById('compensatedMsgCount'),
    outOfOrderCount: document.getElementById('outOfOrderCount'),
    duplicateCount: document.getElementById('duplicateCount'),
    backoffInfo: document.getElementById('backoffInfo'),
    backoffSec: document.getElementById('backoffSec'),
    list: document.getElementById('messageList'),
    sendForm: document.getElementById('sendForm'),
    sendInput: document.getElementById('sendInput'),
    btnSend: document.getElementById('btnSend'),
    filterRecv: document.getElementById('filterRecv'),
    filterSend: document.getElementById('filterSend'),
    filterEvent: document.getElementById('filterEvent'),
    filterAnomaly: document.getElementById('filterAnomaly'),
    canvas: document.getElementById('timelineCanvas'),
    tooltip: document.getElementById('canvasTooltip'),
    followTimeline: document.getElementById('followTimeline'),
    btnZoomIn: document.getElementById('btnZoomIn'),
    btnZoomOut: document.getElementById('btnZoomOut'),
    btnZoomReset: document.getElementById('btnZoomReset'),
    chaosButtons: document.querySelectorAll('.chaos-buttons button'),
  };

  const STATE_META = {
    idle: { label: '未连接', dot: 'idle' },
    connecting: { label: '连接中…', dot: 'connecting' },
    open: { label: '已连接', dot: 'open' },
    reconnecting: { label: '重连中…', dot: 'reconnecting' },
    closed: { label: '已断开', dot: 'closed' },
    error: { label: '连接错误', dot: 'error' },
  };

  const WARN_EVENTS = new Set(['backoff', 'sync_retry', 'sync_incomplete', 'sync_timeout',
    'reconnect_attempt', 'connect_timeout', 'socket_error']);
  const ERR_EVENTS = new Set(['connect_invalid', 'connect_failed', 'connect_error',
    'disconnect', 'disconnect_timeout', 'sync_failed', 'sync_send_failed',
    'reconnect_exhausted', 'send_failed']);
  const OK_EVENTS = new Set(['open', 'reconnected', 'sync_done', 'closed']);

  let worker = null;
  let timeline = null;
  const records = []; // 统一的展示/存储记录：data 与 event
  const stats = {
    reconnects: 0,
    compensationRounds: 0,
    compensatedMsgs: 0,
    outOfOrder: 0,
    duplicate: 0,
  };
  let currentState = 'idle';
  let backoffEndAt = 0;
  let backoffTimer = null;
  let listRenderQueued = false;

  /* ---------------- 初始化 ---------------- */

  function init() {
    timeline = new Timeline(els.canvas, els.tooltip);
    timeline.onUserNavigate = (following) => {
      els.followTimeline.checked = following;
    };
    els.followTimeline.addEventListener('change', () =>
      timeline.setFollow(els.followTimeline.checked));
    els.btnZoomIn.addEventListener('click', () => timeline.zoomBy(1 / 1.25));
    els.btnZoomOut.addEventListener('click', () => timeline.zoomBy(1.25));
    els.btnZoomReset.addEventListener('click', () => {
      timeline.reset();
      els.followTimeline.checked = true;
    });

    startWorker();
    bindUI();
    loadHistory();
    installUnloadCleanup();
  }

  function startWorker() {
    try {
      worker = new Worker('js/ws-worker.js');
    } catch (err) {
      setHint('Web Worker 启动失败：' + err.message, 'err');
      return;
    }
    worker.onmessage = onWorkerMessage;
    worker.onerror = (err) => {
      setHint('Worker 错误：' + (err.message || '未知错误'), 'err');
    };
  }

  async function loadHistory() {
    if (!DB.isAvailable()) {
      setHint('IndexedDB 不可用，消息不会持久化', 'warn');
      return;
    }
    try {
      const saved = await DB.getRecent(1000);
      saved.forEach((row) => {
        const record = storageToRecord(row);
        records.push(record);
        countRecord(record);
      });
      const lastUrl = await DB.getMeta('lastUrl', '');
      if (lastUrl) els.url.value = lastUrl;
      if (saved.length) {
        setHint('已恢复 ' + saved.length + ' 条本地历史消息', 'ok');
      }
      refreshTimeline();
      scheduleListRender();
      updateStats();
    } catch (err) {
      setHint('历史加载失败：' + err.message, 'warn');
    }
  }

  /* ---------------- Worker 消息处理 ---------------- */

  function onWorkerMessage(evt) {
    const msg = evt.data || {};
    if (msg.kind === 'state') {
      applyState(msg);
      return;
    }
    if (msg.kind === 'event') {
      addRecord({
        kind: 'event',
        type: msg.type,
        ts: msg.ts,
        text: msg.text,
        detail: msg.detail === undefined ? null : msg.detail,
      });
      reflectEventHint(msg);
      return;
    }
    if (msg.kind === 'data') {
      const record = {
        kind: 'data',
        dir: msg.dir,
        ts: msg.ts,
        recvTs: msg.recvTs || msg.ts,
        seq: msg.seq,
        clientSeq: msg.clientSeq,
        text: msg.text,
        guessed: !!msg.guessed,
        flags: msg.flags || { outOfOrder: false, duplicate: false,
                             compensated: false, gap: false },
        note: msg.note || null,
      };
      countRecord(record);
      addRecord(record);
      updateStats();
    }
  }

  function applyState(snap) {
    currentState = snap.state;
    stats.reconnects = snap.totalReconnects || 0;
    stats.compensationRounds = snap.compensationRounds || 0;
    stats.compensatedMsgs = snap.compensatedMessages || 0;
    const meta = STATE_META[currentState] || STATE_META.idle;
    els.statusText.textContent = meta.label;
    els.statusDot.className = 'dot ' + meta.dot;

    const connected = currentState === 'open';
    els.btnSend.disabled = !connected;
    els.sendInput.disabled = !connected;
    els.btnDisconnect.disabled = currentState === 'closed' || currentState === 'error' ||
                                currentState === 'idle';
    els.btnConnect.disabled = currentState === 'connecting' ||
                              currentState === 'open' ||
                              currentState === 'reconnecting';
    setChaosEnabled(connected);

    if (typeof snap.nextBackoffMs === 'number' && snap.nextBackoffMs > 0) {
      backoffEndAt = Date.now() + snap.nextBackoffMs;
      els.backoffInfo.hidden = false;
      tickBackoff();
    } else if (currentState !== 'reconnecting') {
      els.backoffInfo.hidden = true;
      backoffEndAt = 0;
      if (backoffTimer) { clearInterval(backoffTimer); backoffTimer = null; }
    }
    updateStats();
  }

  function tickBackoff() {
    if (backoffTimer) clearInterval(backoffTimer);
    const render = () => {
      const remain = Math.max(0, backoffEndAt - Date.now());
      els.backoffSec.textContent = (remain / 1000).toFixed(1);
      if (remain <= 0) {
        clearInterval(backoffTimer);
        backoffTimer = null;
      }
    };
    render();
    backoffTimer = setInterval(render, 100);
  }

  function reflectEventHint(msg) {
    if (ERR_EVENTS.has(msg.type)) setHint(msg.text, 'err');
    else if (WARN_EVENTS.has(msg.type)) setHint(msg.text, 'warn');
    else if (OK_EVENTS.has(msg.type)) setHint(msg.text, 'ok');
  }

  /* ---------------- 记录 / 存储 / 统计 ---------------- */

  function addRecord(record) {
    records.push(record);
    if (records.length > 5000) records.shift();
    if (DB.isAvailable()) {
      DB.putMessage(recordToStorage(record)).catch((err) => {
        setHint('消息持久化失败：' + err.message, 'warn');
      });
    }
    scheduleListRender();
    refreshTimeline();
  }

  function countRecord(record) {
    if (record.kind !== 'data') return;
    if (record.flags.outOfOrder) stats.outOfOrder += 1;
    if (record.flags.duplicate) stats.duplicate += 1;
  }

  function recordToStorage(r) {
    return {
      ts: r.ts,
      dir: r.kind === 'event' ? 'event' : r.dir,
      kind: r.kind,
      seq: r.seq === undefined ? null : r.seq,
      clientSeq: r.clientSeq || null,
      sessionId: sessionKey(),
      text: r.text || '',
      flags: r.flags || null,
      note: r.note || null,
      type: r.type || null,
      detail: r.detail === undefined ? null : r.detail,
    };
  }

  function storageToRecord(row) {
    if (row.kind === 'event' || (!row.kind && row.dir === 'event')) {
      return { kind: 'event', type: row.type, ts: row.ts, text: row.text,
               detail: row.detail === undefined ? null : row.detail };
    }
    return {
      kind: 'data',
      dir: row.dir,
      ts: row.ts,
      recvTs: row.ts,
      seq: row.seq === undefined ? null : row.seq,
      clientSeq: row.clientSeq || null,
      text: row.text,
      guessed: false,
      flags: row.flags || { outOfOrder: false, duplicate: false,
                            compensated: false, gap: false },
      note: row.note || null,
    };
  }

  let _sessionKey = null;
  function sessionKey() {
    if (!_sessionKey) _sessionKey = 'sess-' + Date.now().toString(36);
    return _sessionKey;
  }

  function updateStats() {
    els.reconnectCount.textContent = stats.reconnects;
    els.compensationCount.textContent = stats.compensationRounds;
    els.compensatedMsgCount.textContent = stats.compensatedMsgs;
    els.outOfOrderCount.textContent = stats.outOfOrder;
    els.duplicateCount.textContent = stats.duplicate;
  }

  function setHint(text, level) {
    els.statusHint.textContent = text || '';
    els.statusHint.className = 'hint' + (level ? ' ' + level : '');
  }

  function refreshTimeline() {
    if (!timeline) return;
    const data = records.filter((r) => r.kind === 'data');
    const events = records.filter((r) => r.kind === 'event');
    timeline.setData(data, events);
  }

  /* ---------------- 消息列表渲染（增量 + 过滤） ---------------- */

  function scheduleListRender() {
    if (listRenderQueued) return;
    listRenderQueued = true;
    requestAnimationFrame(() => {
      listRenderQueued = false;
      renderList();
    });
  }

  function rowVisible(r) {
    const anomalyOnly = els.filterAnomaly.checked;
    if (r.kind === 'event') {
      if (!els.filterEvent.checked) return false;
      if (anomalyOnly && !ERR_EVENTS.has(r.type) && !WARN_EVENTS.has(r.type)) return false;
      return true;
    }
    if (r.dir === 'recv' && !els.filterRecv.checked) return false;
    if (r.dir === 'send' && !els.filterSend.checked) return false;
    if (anomalyOnly) {
      const f = r.flags || {};
      if (!f.outOfOrder && !f.duplicate && !f.gap && !f.compensated) return false;
    }
    return true;
  }

  function renderList() {
    const list = els.list;
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
    const frag = document.createDocumentFragment();

    records.forEach((r, idx) => {
      if (!rowVisible(r)) return;
      frag.appendChild(buildRow(r, idx));
    });

    list.replaceChildren(frag);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  function buildRow(r, idx) {
    const row = document.createElement('div');
    if (r.kind === 'event') {
      row.className = 'msg-row event';
      const seq = document.createElement('span');
      seq.className = 'm-seq';
      seq.textContent = '·';
      const time = document.createElement('span');
      time.className = 'm-time';
      time.textContent = formatTime(r.ts);
      const body = document.createElement('span');
      body.className = 'm-body';
      const badge = document.createElement('span');
      badge.className = 'badge ' + (ERR_EVENTS.has(r.type) ? 'err' :
        WARN_EVENTS.has(r.type) ? 'ooo' : 'info');
      badge.textContent = eventLabel(r.type);
      body.appendChild(badge);
      body.appendChild(document.createTextNode(' ' + r.text));
      const badges = document.createElement('span');
      badges.className = 'badges';
      row.appendChild(seq);
      row.appendChild(time);
      row.appendChild(body);
      row.appendChild(badges);
      row.dataset.idx = String(idx);
      return row;
    }

    const f = r.flags || {};
    row.className = 'msg-row ' + r.dir;
    const seq = document.createElement('span');
    seq.className = 'm-seq';
    seq.textContent = r.seq !== null && r.seq !== undefined ? '#' + r.seq : '—';
    const time = document.createElement('span');
    time.className = 'm-time';
    time.textContent = formatTime(r.ts);
    const body = document.createElement('span');
    body.className = 'm-body';
    body.textContent = r.text;
    const badges = document.createElement('span');
    badges.className = 'badges';
    if (f.gap) addBadge(badges, 'gap', '缺口');
    if (f.outOfOrder) addBadge(badges, 'ooo', '乱序');
    if (f.duplicate) addBadge(badges, 'dup', '重复·去重');
    if (f.compensated) addBadge(badges, 'comp', '补偿');
    if (r.note) body.title = r.note;

    row.appendChild(seq);
    row.appendChild(time);
    row.appendChild(body);
    row.appendChild(badges);
    row.dataset.idx = String(idx);
    return row;
  }

  function addBadge(parent, cls, text) {
    const b = document.createElement('span');
    b.className = 'badge ' + cls;
    b.textContent = text;
    parent.appendChild(b);
  }

  const EVENT_LABELS = {
    worker_ready: '系统',
    connecting: '连接中',
    open: '已连接',
    connect_invalid: '地址非法',
    connect_error: '连接错误',
    connect_failed: '连接失败',
    connect_timeout: '连接超时',
    disconnect: '断线',
    disconnect_timeout: '超时断线',
    socket_error: '错误',
    reconnect_attempt: '重连',
    backoff: '退避',
    reconnected: '重连成功',
    reconnect_exhausted: '重连上限',
    sync_request: '请求补偿',
    sync_done: '补偿完成',
    sync_timeout: '补偿超时',
    sync_retry: '补偿重试',
    sync_incomplete: '补偿不完整',
    sync_send_failed: '补偿失败',
    sync_failed: '补偿失败',
    closed: '已断开',
    send_failed: '发送失败',
  };

  function eventLabel(type) {
    return EVENT_LABELS[type] || type;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
           '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  ['filterRecv', 'filterSend', 'filterEvent', 'filterAnomaly'].forEach((key) => {
    els[key].addEventListener('change', renderList);
  });

  /* ---------------- 交互绑定 ---------------- */

  function bindUI() {
    els.url.addEventListener('input', () => els.url.classList.remove('invalid'));

    els.btnConnect.addEventListener('click', doConnect);
    els.url.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doConnect();
    });

    els.btnDisconnect.addEventListener('click', () => {
      post({ cmd: 'disconnect' });
      setHint('正在断开…', null);
    });

    els.sendForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = els.sendInput.value;
      if (!text || currentState !== 'open') return;
      post({ cmd: 'send', text });
      els.sendInput.value = '';
      els.sendInput.focus();
    });

    els.btnClear.addEventListener('click', async () => {
      records.length = 0;
      stats.outOfOrder = 0;
      stats.duplicate = 0;
      updateStats();
      renderList();
      refreshTimeline();
      if (DB.isAvailable()) {
        try { await DB.clearMessages(); } catch (err) {
          setHint('清空历史失败：' + err.message, 'warn');
        }
      }
      setHint('本地消息历史已清空', 'ok');
    });

    els.chaosButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.chaos;
        post({ cmd: 'send', text: JSON.stringify({ chaos: action }) });
      });
    });
  }

  function doConnect() {
    const raw = els.url.value.trim();
    const result = Protocol.validateUrl(raw);
    if (!result.ok) {
      els.url.classList.add('invalid');
      setHint('地址非法：' + invalidText(result.reason), 'err');
      // 与 Worker 的异常链路保持一致：也记录一条事件
      addRecord({
        kind: 'event',
        type: 'connect_invalid',
        ts: Date.now(),
        text: '地址非法：' + invalidText(result.reason) + '（' + raw + '）',
        detail: result.reason,
      });
      return;
    }
    els.url.classList.remove('invalid');
    if (DB.isAvailable()) DB.setMeta('lastUrl', result.url).catch(() => {});
    // 新一轮连接：重置当前会话的异常计数展示（重连/补偿仍由 Worker 累计）
    stats.reconnects = 0;
    stats.compensationRounds = 0;
    stats.compensatedMsgs = 0;
    updateStats();
    setHint('正在连接…', null);
    post({ cmd: 'connect', url: result.url });
  }

  function invalidText(reason) {
    switch (reason) {
      case 'empty': return '地址不能为空';
      case 'invalid-url': return 'URL 格式错误';
      case 'invalid-scheme': return '协议必须是 ws:// 或 wss://';
      case 'invalid-host': return '主机名缺失';
      default: return '地址不合法';
    }
  }

  function setChaosEnabled(enabled) {
    els.chaosButtons.forEach((btn) => { btn.disabled = !enabled; });
  }

  function post(message) {
    if (worker) worker.postMessage(message);
  }

  /* ---------------- 页面卸载清理 ---------------- */

  let disposed = false;
  function installUnloadCleanup() {
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      try {
        if (worker) worker.postMessage({ cmd: 'dispose' });
      } catch (_e) { /* worker 已终止 */ }
      try { if (worker) worker.terminate(); } catch (_e) {}
    };

    // pagehide 是现代浏览器页面真正被丢弃时最可靠的信号
    global.addEventListener('pagehide', cleanup);
    // beforeunload 兜底（部分桌面浏览器）
    global.addEventListener('beforeunload', cleanup);
    // 标签切后台不清理；仅当文档被丢弃（bfcache 不适用）时 pagehide 已处理
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        // 尝试同步发送一帧 dispose（页面可能很快被回收）
        try {
          if (worker && !disposed) {
            worker.postMessage({ cmd: 'dispose' });
          }
        } catch (_e) {}
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
