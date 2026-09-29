// 无依赖 WebSocket 测试服务器：模拟乱序/重复/丢包/断线，支持补偿请求
// 用法: node test/ws-server.js [port]
const http = require('http');
const crypto = require('crypto');
const net = require('net');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}
function encodeFrame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
// 逐条解析客户端帧（文本/关闭/ping），返回 {messages, rest}
function decodeFrames(buf, onMessage, onClose) {
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let len = buf[offset + 1] & 0x7f;
    let pos = offset + 2;
    if (len === 126) { if (pos + 2 > buf.length) break; len = buf.readUInt16BE(pos); pos += 2; }
    else if (len === 127) { if (pos + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(pos)); pos += 8; }
    const maskLen = masked ? 4 : 0;
    if (pos + maskLen + len > buf.length) break;
    let payload = buf.slice(pos + maskLen, pos + maskLen + len);
    if (masked) {
      const mask = buf.slice(pos, pos + 4);
      payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    }
    if (opcode === 0x1) onMessage(payload.toString());
    else if (opcode === 0x8) onClose();
    else if (opcode === 0x9) {} // ping 忽略
    offset = pos + maskLen + len;
  }
  return buf.slice(offset);
}

const server = http.createServer();
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  socket.setNoDelay(true);

  let seq = 0;
  const sent = new Map();       // seq -> payload，用于补偿
  let closed = false;
  const send = (obj) => {
    if (closed) return;
    const s = JSON.stringify(obj);
    sent.set(obj.seq, s);
    socket.write(encodeFrame(s));
  };
  const interval = setInterval(() => {
    if (closed) return;
    seq++;
    const r = Math.random();
    if (r < 0.08) return;                       // 8% 丢包（不发送）
    if (r < 0.13) { send({ seq }); send({ seq }); return; } // 5% 重复
    if (r < 0.20) {                             // 7% 乱序：先发 seq+1 再发 seq
      const a = seq, b = ++seq;
      send({ seq: b }); send({ seq: a });
      return;
    }
    send({ seq });
  }, 100);
  // 每 ~6s 模拟断线
  const killer = setTimeout(() => { cleanup(); socket.destroy(); }, 6000);
  const cleanup = () => { closed = true; clearInterval(interval); clearTimeout(killer); };

  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = decodeFrames(Buffer.concat([buf, d]), (text) => {
      let msg; try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === 'compensate') {
        // 补偿：重发 after 之后所有丢失的消息
        for (const [s, payload] of [...sent.entries()].sort((a, b) => a[0] - b[0])) {
          if (s > msg.after && !closed) socket.write(encodeFrame(payload));
        }
      }
    }, cleanup);
  });
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

// 静默 TCP 服务器（接受连接但不响应），用于测试连接超时
const silent = net.createServer((s) => s.on('error', () => {}));

const port = Number(process.argv[2]) || 8901;
server.listen(port, () => console.log(`ws server on :${port}`));
silent.listen(port + 1, () => console.log(`silent server on :${port + 1}`));
