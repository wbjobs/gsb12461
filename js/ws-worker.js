/*
 * WebSocket 核心状态机（运行在 Web Worker 中）。
 *
 * 职责：
 *  - 连接 / 断开，区分地址非法、连接失败、连接超时三类错误
 *  - 断线后指数退避自动重连，重连次数受上限约束
 *  - 接收消息：序号乱序检测、重复消息检测与去重
 *  - 重连成功后发送补偿(sync)请求，失败按退避重试，重试有上限
 *  - 页面卸载 / 手动断开时彻底清理定时器与底层连接
 *
 * Worker 不直接写 IndexedDB；所有消息与事件先 postMessage 给主线程，
 * 由主线程持久化并渲染，保证 UI、Canvas、存储使用同一份数据。
 */
'use strict';

importScripts('protocol.js');

const CONNECT_TIMEOUT_MS = 8000;   // 建连超时
const MAX_RECONNECT = 6;           // 每次断线最多重连 6 次
const BASE_BACKOFF_MS = 1000;      // 退避基数
const MAX_BACKOFF_MS = 30000;      // 退避上限
const MAX_SYNC_RETRY = 3;          // 补偿请求最多重试 3 次（共 4 次）
const SYNC_WAIT_MS = 4000;         // 等待补偿响应的超时
const UNORDERED_TTL_MS = 300000;   // 无序号消息去重窗口 5 分钟

const CONNECTING = 'connecting';
const OPEN = 'open';
const RECONNECTING = 'reconnecting';
const CLOSED = 'closed';
const ERROR_STATE = 'error';

let ws = null;
let url = null;
let sessionId = null;

let state = CLOSED;
let manualClose = true;

let connectTimer = null;
let backoffTimer = null;
let syncTimer = null;
let syncRetryTimer = null;
let openTimer = null;

let reconnectAttempt = 0;       // 本次断线内的重连计数
let totalReconnects = 0;        // 累计重连成功/尝试次数（成功次数，见下）
let compensationRounds = 0;     // 累计补偿成功轮次
let compensatedMessages = 0;    // 累计补偿到的消息数

let clientSendSeq = 0;
let maxContiguousSeq = 0;       // 已连续接收到的最大序号
const seenSeqs = new Set();     // 已见序号（用于重复判定）
const missingSeqs = new Set();  // 当前缺口序号集合（用于 gap 标记与补偿对账）
const recentTextMap = new Map();// 无序号消息内容哈希 -> 时间戳，去重窗口

function nowTs() { return Date.now(); }

function postEvent(type, payload) {
  const ev = {
    kind: 'event',
    type,
    ts: nowTs(),
    text: (payload && payload.text) || '',
    detail: payload && payload.detail !== undefined ? payload.detail : null,
  };
  self.postMessage(ev);
}

function postState(extra) {
  const snap = {
    kind: 'state',
    state,
    url,
    reconnectAttempt,
    totalReconnects,
    compensationRounds,
    compensatedMessages,
  };
  if (extra) Object.assign(snap, extra);
  self.postMessage(snap);
}

function postData(dir, parsed, flags, note) {
  self.postMessage({
    kind: 'data',
    dir,
    ts: parsed.ts || nowTs(),
    recvTs: nowTs(),
    seq: parsed.seq,
    clientSeq: parsed.clientSeq || null,
    text: parsed.text,
    guessed: !!parsed.guessed,
    flags: Object.assign({ outOfOrder: false, duplicate: false,
                          compensated: false, gap: false }, flags || {}),
    note: note || null,
  });
}

function clearTimer(name) {
  if (name === 'connect' && connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  if (name === 'backoff' && backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
  if (name === 'sync' && syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (name === 'syncRetry' && syncRetryTimer) { clearTimeout(syncRetryTimer); syncRetryTimer = null; }
  if (name === 'open' && openTimer) { clearTimeout(openTimer); openTimer = null; }
}

function clearAllTimers() {
  ['connect', 'backoff', 'sync', 'syncRetry', 'open'].forEach(clearTimer);
}

/* ---------------- 连接生命周期 ---------------- */

function connect(targetUrl) {
  const result = Protocol.validateUrl(targetUrl);
  url = targetUrl;
  if (!result.ok) {
    state = ERROR_STATE;
    postEvent('connect_invalid', {
      text: '地址非法：' + describeInvalid(result.reason) + '（' + String(targetUrl) + '）',
      detail: result.reason,
    });
    postState();
    return;
  }
  url = result.url;
  manualClose = false;
  reconnectAttempt = 0;
  // 全新的手动连接：重置上一会话的序号追踪与累计计数
  totalReconnects = 0;
  compensationRounds = 0;
  compensatedMessages = 0;
  maxContiguousSeq = 0;
  seenSeqs.clear();
  missingSeqs.clear();
  recentTextMap.clear();
  syncAttempts = 0;
  clearTimer('sync');
  clearTimer('syncRetry');
  openSocket(false);
}

function describeInvalid(reason) {
  switch (reason) {
    case 'empty': return '地址不能为空';
    case 'invalid-url': return 'URL 格式错误';
    case 'invalid-scheme': return '协议必须是 ws:// 或 wss://';
    case 'invalid-host': return '主机名缺失';
    default: return '地址不合法';
  }
}

function openSocket(isReconnect) {
  if (ws) {
    try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); } catch (_e) {}
    ws = null;
  }
  clearTimer('connect');
  clearTimer('open');

  state = isReconnect ? RECONNECTING : CONNECTING;
  postState({ nextBackoffMs: null });
  if (isReconnect) {
    postEvent('reconnect_attempt', {
      text: '尝试第 ' + reconnectAttempt + '/' + MAX_RECONNECT + ' 次重连…',
      detail: reconnectAttempt,
    });
  } else {
    postEvent('connecting', { text: '正在连接 ' + url });
  }

  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    // 例如 SecurityError：被浏览器策略阻止
    state = ERROR_STATE;
    postEvent('connect_error', {
      text: '无法创建连接：' + (err && err.message ? err.message : String(err)),
    });
    postState();
    return;
  }
  ws = socket;

  const timedOut = { value: false };
  openTimer = setTimeout(() => {
    timedOut.value = true;
    postEvent('connect_timeout', {
      text: '连接超时（' + CONNECT_TIMEOUT_MS + 'ms 内未建立）',
    });
    try { socket.close(); } catch (_e) {}
  }, CONNECT_TIMEOUT_MS);

  socket.onopen = () => {
    if (timedOut.value) return; // 超时后姗姗来迟的 open 不采用
    clearTimer('open');
    handleOpen(isReconnect);
  };

  socket.onmessage = (evt) => {
    if (state !== OPEN && state !== RECONNECTING) return;
    handleMessage(evt.data);
  };

  socket.onerror = () => {
    // 浏览器不提供具体错误信息；随后通常会触发 onclose
    if (state === CONNECTING) {
      postEvent('connect_error', { text: '连接失败（网络错误或服务不可达）' });
    } else {
      postEvent('socket_error', { text: '连接发生错误，等待关闭事件…' });
    }
  };

  socket.onclose = (evt) => {
    clearTimer('open');
    if (timedOut.value) {
      handleUnexpectedClose('timeout');
      return;
    }
    if (state === CONNECTING) {
      // 建连阶段就被关闭 => 连接失败
      handleConnectFailure(evt);
      return;
    }
    if (manualClose) {
      handleManualClose(evt);
      return;
    }
    handleUnexpectedClose('drop', evt);
  };
}

function handleConnectFailure(evt) {
  state = ERROR_STATE;
  postEvent('connect_failed', {
    text: '连接失败：服务端拒绝或不可达' +
          (evt && 'code' in evt ? '（code=' + evt.code + '）' : ''),
  });
  // 初次连接失败也允许自动重连（属于"连接失败"异常链路）
  scheduleReconnect('connect');
}

function handleOpen(isReconnect) {
  state = OPEN;
  if (isReconnect) {
    totalReconnects += 1;
    postEvent('reconnected', {
      text: '重连成功（累计重连 ' + totalReconnects + ' 次），开始请求补偿…',
    });
    requestSync(true);
  } else {
    postEvent('open', { text: '连接已建立：' + url });
  }
  postState({ nextBackoffMs: null });
}

function handleManualClose(evt) {
  state = CLOSED;
  clearAllTimers();
  destroySocket();
  resetSessionTracking();
  postEvent('closed', {
    text: '已手动断开' + (evt && evt.code ? '（code=' + evt.code + '）' : ''),
  });
  postState();
}

function handleUnexpectedClose(reason, evt) {
  destroySocket();
  const suffix = evt && evt.code ? '（code=' + evt.code +
    (evt.reason ? ' ' + evt.reason : '') + '）' : '';
  if (reason === 'timeout') {
    postEvent('disconnect_timeout', { text: '连接超时后关闭' + suffix });
  } else {
    post('disconnect', { text: '连接已断开' + suffix });
  }
  scheduleReconnect(reason);
}

function post(type, payload) { postEvent(type, payload); }

function destroySocket() {
  if (ws) {
    try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close(); } catch (_e) {}
    ws = null;
  }
}

function computeBackoff(attempt) {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
  // ±20% 抖动，避免多个客户端同时重连
  const jitter = exp * 0.2 * (Math.random() * 2 - 1);
  return Math.round(Math.max(BASE_BACKOFF_MS, exp + jitter));
}

function scheduleReconnect(_reason) {
  clearTimer('backoff');
  if (reconnectAttempt >= MAX_RECONNECT) {
    state = ERROR_STATE;
    postEvent('reconnect_exhausted', {
      text: '已达到重连上限 ' + MAX_RECONNECT + ' 次，停止重连。请检查服务后手动连接。',
      detail: MAX_RECONNECT,
    });
    postState();
    return;
  }
  reconnectAttempt += 1;
  const delay = computeBackoff(reconnectAttempt);
  state = RECONNECTING;
  postEvent('backoff', {
    text: '将在 ' + (delay / 1000).toFixed(1) + 's 后第 ' +
          reconnectAttempt + '/' + MAX_RECONNECT + ' 次重连',
    detail: { attempt: reconnectAttempt, delayMs: delay },
  });
  postState({ nextBackoffMs: delay });
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    openSocket(true);
  }, delay);
}

/* ---------------- 发送 ---------------- */

function sendText(text) {
  if (!ws || state !== OPEN) {
    postEvent('send_failed', { text: '发送失败：当前连接未就绪' });
    return false;
  }
  clientSendSeq += 1;
  const seq = clientSendSeq;
  const payload = Protocol.buildData(seq, text);
  try {
    ws.send(payload);
  } catch (err) {
    postEvent('send_failed', {
      text: '发送失败：' + (err && err.message ? err.message : String(err)),
    });
    return false;
  }
  postData('send', {
    seq,
    clientSeq: seq,
    ts: nowTs(),
    text,
  });
  return true;
}

/* ---------------- 接收：乱序 / 重复 / 缺口 ---------------- */

function pruneTextMap() {
  const cutoff = nowTs() - UNORDERED_TTL_MS;
  recentTextMap.forEach((ts, key) => {
    if (ts < cutoff) recentTextMap.delete(key);
  });
}

function isTextDuplicate(text) {
  pruneTextMap();
  const hash = Protocol.contentHash(text);
  if (recentTextMap.has(hash)) return true;
  recentTextMap.set(hash, nowTs());
  return false;
}

function handleMessage(rawData) {
  const parsed = Protocol.parseIncoming(rawData);

  if (parsed.binary) {
    postData('recv', parsed, {});
    return;
  }

  if (parsed.protocol && parsed.type === 'sync') {
    handleSyncResponse(parsed);
    return;
  }

  classifyAndPost(parsed, false);
}

/**
 * @param parsed 解析后的消息
 * @param compensated 是否来自补偿响应
 */
function classifyAndPost(parsed, compensated) {
  const seq = parsed.seq;
  const flags = { outOfOrder: false, duplicate: false, compensated: false, gap: false };
  let note = null;

  if (seq !== null && seq !== undefined) {
    const duplicate = seenSeqs.has(seq);
    if (duplicate) {
      flags.duplicate = true;
      note = '重复帧：序号 #' + seq + ' 已接收过，标记并去重（不计入新消息水位）';
    } else {
      seenSeqs.add(seq);
      if (seq <= maxContiguousSeq) {
        flags.outOfOrder = true;
        note = '乱序：序号 ' + seq + ' 已小于连续水位 ' + maxContiguousSeq;
      } else if (seq === maxContiguousSeq + 1) {
        advanceContiguous();
      } else {
        // seq > maxContiguousSeq + 1：出现缺口
        flags.gap = true;
        for (let s = maxContiguousSeq + 1; s < seq; s += 1) {
          if (!seenSeqs.has(s)) missingSeqs.add(s);
        }
        flags.outOfOrder = true;
        note = '乱序/缺口：收到 #' + seq + '，期望 #' + (maxContiguousSeq + 1) +
               '，缺失 ' + missingSeqs.size + ' 条';
        // 保持水位不动，等待缺失序号到达后由 advanceContiguous 连续推进
      }
    }
  } else {
    // 无序号消息：仅按内容哈希做重复检测（5 分钟窗口）
    if (isTextDuplicate(parsed.text)) {
      flags.duplicate = true;
      note = '无序号消息内容重复，已按内容哈希去重';
    }
  }

  if (compensated) {
    flags.compensated = true;
    missingSeqs.delete(seq);
    // 补偿回填后推进水位（补偿数据按 seq 升序传入）
    if (seq === maxContiguousSeq + 1) {
      advanceContiguous();
    } else if (seq > maxContiguousSeq + 1) {
      for (let s = maxContiguousSeq + 1; s < seq; s += 1) {
        if (!seenSeqs.has(s)) missingSeqs.add(s);
      }
      if (!flags.gap) flags.gap = missingSeqs.size > 0;
    }
  }

  postData('recv', parsed, flags, note);
}

/** 从当前水位开始逐个推进，只在真正连续时上升；补齐的序号移出缺口集合 */
function advanceContiguous() {
  let seq = maxContiguousSeq + 1;
  while (seenSeqs.has(seq)) {
    maxContiguousSeq = seq;
    missingSeqs.delete(seq);
    seq += 1;
  }
}

/* ---------------- 补偿（断线重连后同步缺失消息） ---------------- */

let syncAttempts = 0;

function requestSync(isNewReconnect) {
  if (isNewReconnect) syncAttempts = 0;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return; // 连接已不在，交给关闭事件重新走重连
  }
  clearTimer('sync');
  try {
    ws.send(Protocol.buildSync(maxContiguousSeq));
  } catch (err) {
    postEvent('sync_send_failed', {
      text: '补偿请求发送失败：' + (err && err.message ? err.message : String(err)),
    });
    scheduleSyncRetry();
    return;
  }
  postEvent('sync_request', {
    text: '已发送补偿请求：请求 seq > ' + maxContiguousSeq +
          ' 的消息（缺口 ' + missingSeqs.size + ' 条，' +
          (syncAttempts === 0 ? '第 1 次' : '第 ' + (syncAttempts + 1) + ' 次））'),
    detail: { lastSeq: maxContiguousSeq, attempt: syncAttempts + 1,
              missing: missingSeqs.size },
  });

  syncTimer = setTimeout(() => {
    syncTimer = null;
    postEvent('sync_timeout', {
      text: '补偿响应超时（' + SYNC_WAIT_MS + 'ms）',
    });
    scheduleSyncRetry();
  }, SYNC_WAIT_MS);
}

function scheduleSyncRetry() {
  clearTimer('sync');
  clearTimer('syncRetry');
  if (syncAttempts >= MAX_SYNC_RETRY) {
    postEvent('sync_failed', {
      text: '补偿失败：已重试 ' + MAX_SYNC_RETRY +
            ' 次仍无完整响应，放弃本次自动补偿（缺口 ' + missingSeqs.size + ' 条）',
      detail: { missing: missingSeqs.size },
    });
    return;
  }
  syncAttempts += 1;
  const delay = computeBackoff(syncAttempts);
  postEvent('sync_retry', {
    text: (delay / 1000).toFixed(1) + 's 后重试补偿（第 ' + (syncAttempts + 1) +
          '/' + (MAX_SYNC_RETRY + 1) + ' 次）',
    detail: { attempt: syncAttempts + 1, delayMs: delay },
  });
  syncRetryTimer = setTimeout(() => {
    syncRetryTimer = null;
    requestSync(false);
  }, delay);
}

function handleSyncResponse(parsed) {
  clearTimer('sync');
  clearTimer('syncRetry');

  if (!parsed.items.length) {
    finishSync(0, parsed.from);
    return;
  }

  const sortedItems = parsed.items.slice().sort((a, b) => a.seq - b.seq);
  let accepted = 0;
  let skipped = 0;
  sortedItems.forEach((item) => {
    if (seenSeqs.has(item.seq)) {
      skipped += 1;
      return;
    }
    accepted += 1;
    classifyAndPost({
      seq: item.seq,
      ts: item.ts,
      recvTs: nowTs(),
      text: item.text,
      protocol: true,
    }, true);
  });

  compensatedMessages += accepted;
  finishSync(accepted, parsed.from, skipped, sortedItems.length);
}

function finishSync(accepted, from, skipped, total) {
  compensationRounds += 1;
  const stillMissing = missingSeqs.size;
  let text = '补偿完成：收到 ' + accepted + ' 条补偿消息';
  if (skipped) text += '，' + skipped + ' 条已存在自动跳过';
  if (stillMissing > 0) text += '；仍有 ' + stillMissing + ' 条缺口';
  postEvent('sync_done', {
    text,
    detail: { accepted, skipped: skipped || 0, total: total || 0,
              from: from === undefined ? null : from, missing: stillMissing },
  });

  if (stillMissing > 0 && syncAttempts < MAX_SYNC_RETRY) {
    // 服务端给的补偿不完整：按"补偿失败"链路重试
    postEvent('sync_incomplete', {
      text: '补偿数据不完整，稍后重试请求剩余缺口…',
    });
    scheduleSyncRetry();
  } else if (stillMissing > 0) {
    postEvent('sync_failed', {
      text: '补偿失败：重试次数用尽，仍有 ' + stillMissing + ' 条缺口',
      detail: { missing: stillMissing },
    });
  }
  postState();
}

/* ---------------- 断开 / 清理 ---------------- */

function resetSessionTracking() {
  clientSendSeq = 0;
  maxContiguousSeq = 0;
  seenSeqs.clear();
  missingSeqs.clear();
  recentTextMap.clear();
  syncAttempts = 0;
  clearTimer('sync');
  clearTimer('syncRetry');
}

function disconnect() {
  manualClose = true;
  clearAllTimers();
  if (ws) {
    try {
      state = CLOSED;
      ws.close(1000, 'client disconnect');
    } catch (_e) {}
  } else {
    state = CLOSED;
    postState();
  }
  resetSessionTracking();
}

/**
 * 页面卸载清理（pagehide / beforeunload 都会下发）：
 * 立即关闭底层 socket 并清空全部定时器，阻止任何重连。
 */
function dispose() {
  manualClose = true;
  clearAllTimers();
  destroySocket();
  state = CLOSED;
}

self.onmessage = (evt) => {
  const msg = evt.data || {};
  switch (msg.cmd) {
    case 'connect':
      connect(msg.url);
      break;
    case 'send':
      sendText(String(msg.text == null ? '' : msg.text));
      break;
    case 'disconnect':
      disconnect();
      break;
    case 'dispose':
      dispose();
      break;
    default:
      break;
  }
};

postEvent('worker_ready', { text: 'WebSocket Worker 已就绪' });
