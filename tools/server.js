#!/usr/bin/env node
/*
 * 零依赖测试服务器（仅使用 Node 内置模块）：
 *  - HTTP 静态文件服务：http://localhost:8080/
 *  - WebSocket 端点：ws://localhost:8080/ws
 *  - 每 2s 推送带递增 seq 的消息，支持 sync 补偿协议
 *  - 异常注入（客户端发送 {"chaos": "..."} 触发）：
 *      drop       服务端立即断链（客户端走退避重连）
 *      duplicate  下一条推送重复发送一次
 *      reorder    下两条推送交换顺序（制造乱序）
 *      gap        丢弃 3 条消息（客户端重连/补偿）
 *      blackhole  丢弃 3 条且忽略一次 sync 请求（补偿失败重试链路）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.join(__dirname, '..');
const PUSH_INTERVAL_MS = 2000;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/* ---------------- 静态文件 ---------------- */

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- WebSocket 帧编解码 ---------------- */

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(str, opcode = 0x1) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer, onMessage) {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) === 0x80;
    let payloadLen = b1 & 0x7f;
    let headerLen = 2;
    if (payloadLen === 126) {
      if (buffer.length - offset < 4) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (buffer.length - offset < 10) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    let maskKey = null;
    if (masked) {
      if (buffer.length - offset < headerLen + 4) break;
      maskKey = buffer.slice(offset + headerLen, offset + headerLen + 4);
      headerLen += 4;
    }
    if (buffer.length - offset < headerLen + payloadLen) break;
    const payload = buffer.slice(offset + headerLen,
                                offset + headerLen + payloadLen);
    if (masked) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i % 4];
      }
    }
    onMessage(opcode, payload);
    offset += headerLen + payloadLen;
  }
  return buffer.slice(offset);
}

/* ---------------- WebSocket 连接与异常注入 ---------------- */

let globalSeq = 0; // 跨连接递增，便于演示断线后补偿
const serverHistory = []; // 服务器端消息日志，跨重连保留，供 sync 补偿
const HISTORY_CAP = 2000;

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );

  const conn = {
    socket,
    pending: { duplicate: 0, reorder: false, gap: 0, ignoreSync: 0 },
    lastPushedSeq: 0,
    history: serverHistory, // 跨连接共享，重连后仍能补偿断线期间的消息
    alive: true,
  };
  connections.add(conn);
  console.log('[ws] client connected, total=%d', connections.size);

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    buffer = decodeFrames(buffer, (opcode, payload) => {
      if (opcode === 0x8) { // close
        safeEnd(socket);
        return;
      }
      if (opcode === 0x9) { // ping -> pong
        try { socket.write(encodeFrame(payload, 0xA)); } catch (_e) {}
        return;
      }
      if (opcode !== 0x1) return;
      handleClientText(conn, payload.toString('utf8'));
    });
  });

  socket.on('close', () => {
    conn.alive = false;
    connections.delete(conn);
    console.log('[ws] client disconnected, total=%d', connections.size);
  });
  socket.on('error', () => {
    conn.alive = false;
    connections.delete(conn);
  });

  // 新连接：首次连接推欢迎消息；重连后只响应 sync 补偿，不重复推送
  if (globalSeq === 0) {
    sendData(conn, 'connected at ' + new Date().toISOString(), true);
  }
});

const connections = new Set();

function safeEnd(socket) {
  try { socket.end(); } catch (_e) {}
}

function sendData(conn, text, isWelcome) {
  if (!conn.alive) return null;
  globalSeq += 1;
  const msg = { type: 'data', seq: globalSeq, ts: Date.now(), text };
  serverHistory.push(msg);
  if (serverHistory.length > HISTORY_CAP) serverHistory.shift();
  conn.lastPushedSeq = globalSeq;
  try {
    conn.socket.write(encodeFrame(JSON.stringify(msg)));
  } catch (_e) {
    conn.alive = false;
    connections.delete(conn);
    return null;
  }
  console.log('[ws] push #%d%s', globalSeq, isWelcome ? ' (welcome)' : '');
  return msg;
}

function handleClientText(conn, text) {
  let obj = null;
  try { obj = JSON.parse(text); } catch (_e) { obj = null; }

  // chaos 控制指令可能嵌在协议信封的 text 字段里
  let control = null;
  if (obj && obj.type === 'data' && typeof obj.text === 'string') {
    try {
      const inner = JSON.parse(obj.text);
      if (inner && inner.chaos) control = inner;
    } catch (_e) { /* 普通文本消息 */ }
  } else if (obj && obj.chaos) {
    control = obj;
  }

  if (obj && obj.type === 'sync') {
    if (conn.pending.ignoreSync > 0) {
      conn.pending.ignoreSync -= 1;
      console.log('[ws] sync ignored (blackhole) lastSeq=%s', obj.lastSeq);
      return;
    }
    const lastSeq = Number(obj.lastSeq) || 0;
    const items = conn.history.filter((m) => m.seq > lastSeq);
    const reply = { type: 'sync', from: lastSeq, items: items.map((m) => ({
      seq: m.seq, ts: m.ts, text: m.text,
    })) };
    try {
      conn.socket.write(encodeFrame(JSON.stringify(reply)));
    } catch (_e) {}
    console.log('[ws] sync served lastSeq=%d items=%d', lastSeq, items.length);
    return;
  }

  if (control) {
    applyChaos(conn, control.chaos);
    return;
  }

  // 普通消息：回显为带序号的 data 消息
  const plain = obj && obj.type === 'data' && typeof obj.text === 'string'
    ? obj.text : text;
  sendData(conn, 'echo: ' + plain);
}

function applyChaos(conn, action) {
  switch (action) {
    case 'drop':
      console.log('[chaos] force drop');
      conn.alive = false;
      try { conn.socket.destroy(); } catch (_e) {}
      connections.delete(conn);
      break;
    case 'duplicate':
      conn.pending.duplicate += 1;
      console.log('[chaos] next message will duplicate');
      break;
    case 'reorder':
      conn.pending.reorder = true;
      console.log('[chaos] next two messages will swap');
      break;
    case 'gap':
      conn.pending.gap += 3;
      console.log('[chaos] dropping 3 messages');
      break;
    case 'blackhole':
      conn.pending.gap += 3;
      conn.pending.ignoreSync += 1;
      console.log('[chaos] dropping 3 + ignoring 1 sync');
      break;
    default:
      break;
  }
}

/* ---------------- 周期推送（含异常注入效果） ---------------- */

function pushTick() {
  connections.forEach((conn) => {
    if (!conn.alive) return;

    // gap：不发送但仍然占用 seq（history 里保留，供 sync 补偿）
    if (conn.pending.gap > 0) {
      globalSeq += 1;
      const msg = { type: 'data', seq: globalSeq, ts: Date.now(),
                    text: 'silent gap #' + globalSeq };
      conn.history.push(msg);
      conn.pending.gap -= 1;
      console.log('[chaos] silently dropped #%d (remaining=%d)',
                  globalSeq, conn.pending.gap);
      return;
    }

    if (conn.pending.reorder) {
      conn.pending.reorder = false;
      const first = sendData(conn, 'reordered A');
      // 再生成第二条，但先发第二条
      globalSeq += 1;
      const second = { type: 'data', seq: globalSeq, ts: Date.now(),
                       text: 'reordered B #' + globalSeq };
      serverHistory.push(second);
      if (serverHistory.length > HISTORY_CAP) serverHistory.shift();
      try {
        conn.socket.write(encodeFrame(JSON.stringify(second)));
        if (first) conn.socket.write(encodeFrame(JSON.stringify(first)));
      } catch (_e) {}
      console.log('[chaos] sent #%d before #%d', second.seq, first ? first.seq : -1);
      return;
    }

    const msg = sendData(conn, 'tick #' + (globalSeq + 1));
    if (msg && conn.pending.duplicate > 0) {
      conn.pending.duplicate -= 1;
      try {
        conn.socket.write(encodeFrame(JSON.stringify(msg)));
      } catch (_e) {}
      console.log('[chaos] duplicated #%d', msg.seq);
    }
  });
}

setInterval(pushTick, PUSH_INTERVAL_MS);

server.listen(PORT, "127.0.0.1", () => {
  console.log('==============================================');
  console.log(' 页面:       http://localhost:%d/', PORT);
  console.log(' WebSocket:  ws://localhost:%d/ws', PORT);
  console.log(' 推送间隔:    %dms', PUSH_INTERVAL_MS);
  console.log('==============================================');
});
