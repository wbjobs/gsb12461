/*
 * 验收冒烟测试（零依赖，Node >= 22）。
 *
 * 不监听真实端口：使用内存中的 FakeWebSocket 服务器驱动【真实】的
 * js/ws-worker.js，完整覆盖异常链路，快速且确定性强：
 *   node test/smoke.mjs           # 主链路（约 20s，含一次 4s 补偿超时）
 *   node test/smoke.mjs --cap     # 额外验证重连上限（约 +70s）
 *
 * tools/server.js 是供浏览器手动验收的真实服务器（语法在本测试中一并检查）。
 */
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NORMAL_URL = 'ws://fake.test/ws';
const REFUSED_URL = 'ws://refused.test/ws';
const TIMEOUT_URL = 'ws://timeout.test/ws';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  \u2713 ' + name);
  } catch (err) {
    console.error('  \u2717 ' + name);
    throw err;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 内存假服务器 + 假 WebSocket ---------------- */

class FakeServer {
  constructor() {
    this.globalSeq = 0;
    this.sockets = new Set();
    this.history = []; // 服务器端消息日志，跨重连保留，供 sync 补偿
  }

  attach(sock, url) {
    sock.url = url;
    sock.ignoreSync = 0;
    if (url === REFUSED_URL) {
      setTimeout(() => {
        if (sock.onclose) sock.onclose({ code: 1006, reason: '', wasClean: false });
      }, 2);
      return;
    }
    if (url === TIMEOUT_URL) {
      // 永远不 open，也不 close：用于触发连接超时
      return;
    }
    setTimeout(() => {
      sock.readyState = 1; // OPEN
      this.sockets.add(sock);
      if (sock.onopen) sock.onopen({});
      // 重连不重复发 welcome，只同步服务器已有水位之上的消息（由 sync 补偿）
      if (this.globalSeq === 0) this.push(sock, 'connected (fake)');
    }, 2);
  }

  detach(sock) {
    this.sockets.delete(sock);
  }

  nextMsg(text) {
    this.globalSeq += 1;
    const msg = { type: 'data', seq: this.globalSeq, ts: Date.now(), text };
    this.history.push(msg);
    return msg;
  }

  push(sock, text) {
    if (sock.readyState !== 1) return null;
    const msg = this.nextMsg(text);
    if (sock.onmessage) sock.onmessage({ data: JSON.stringify(msg) });
    return msg;
  }

  drop(sock) {
    sock.readyState = 3;
    this.detach(sock);
    if (sock.onerror) sock.onerror(new Event('error'));
    if (sock.onclose) sock.onclose({ code: 1006, reason: 'forced drop', wasClean: false });
  }

  handleMessage(sock, raw) {
    let obj = null;
    try { obj = JSON.parse(raw); } catch (_e) { obj = null; }

    // 客户端协议信封：{type:'data', text:'<原始文本>'}，chaos 指令在 text 内
    let control = null;
    if (obj && obj.type === 'data' && typeof obj.text === 'string') {
      try {
        const inner = JSON.parse(obj.text);
        if (inner && inner.chaos) control = inner;
      } catch (_e) { /* 普通文本 */ }
    } else if (obj && obj.chaos) {
      control = obj;
    }

    if (obj && obj.type === 'sync') {
      if (sock.ignoreSync > 0) {
        sock.ignoreSync -= 1;
        return; // blackhole：吞掉补偿请求
      }
      const lastSeq = Number(obj.lastSeq) || 0;
      const items = this.history
        .filter((m) => m.seq > lastSeq)
        .map((m) => ({ seq: m.seq, ts: m.ts, text: m.text }));
      const reply = { type: 'sync', from: lastSeq, items };
      if (sock.onmessage) sock.onmessage({ data: JSON.stringify(reply) });
      return;
    }

    if (control) {
      this.applyChaos(sock, control.chaos);
      return;
    }

    const text = obj && obj.type === 'data' && typeof obj.text === 'string'
      ? obj.text : raw;
    this.push(sock, 'echo: ' + text);
  }

  applyChaos(sock, action) {
    switch (action) {
      case 'drop':
        this.drop(sock);
        break;
      case 'duplicate': {
        const msg = this.push(sock, 'dup tick');
        if (msg && sock.onmessage) sock.onmessage({ data: JSON.stringify(msg) });
        break;
      }
      case 'reorder': {
        const a = this.nextMsg('reordered A');
        const b = this.nextMsg('reordered B');
        // 先发大序号，再发小序号
        if (sock.onmessage) sock.onmessage({ data: JSON.stringify(b) });
        if (sock.onmessage) sock.onmessage({ data: JSON.stringify(a) });
        break;
      }
      case 'gap':
        for (let i = 0; i < 3; i += 1) {
          this.nextMsg('silent #' + (this.globalSeq + 1));
        }
        break;
      case 'blackhole':
        for (let i = 0; i < 3; i += 1) {
          this.nextMsg('silent #' + (this.globalSeq + 1));
        }
        sock.ignoreSync = 1;
        break;
      default:
        break;
    }
  }
}

function makeWebSocketCtor(server) {
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      server.attach(this, url);
    }
    send(data) {
      if (this.readyState === 1) server.handleMessage(this, String(data));
    }
    close() {
      this.readyState = 3;
      server.detach(this);
      if (this.onclose) {
        const cb = this.onclose;
        this.onclose = null;
        setTimeout(() => cb({ code: 1000, reason: '', wasClean: true }), 0);
      }
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  return FakeWebSocket;
}

/* ---------------- Worker 沙箱 ---------------- */

function createWorkerHarness(FakeWebSocket) {
  const events = [];
  const stateSnapshots = [];
  const waiters = [];

  const sandbox = {
    WebSocket: FakeWebSocket,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Number, Array, Object, String, Boolean, Map, Set,
    ArrayBuffer, URL, console,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = () => {};
  sandbox.postMessage = (msg) => {
    if (msg.kind === 'state') stateSnapshots.push(msg);
    events.push(msg);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(msg)) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  };
  vm.createContext(sandbox);

  const protocolSrc = fs.readFileSync(path.join(ROOT, 'js', 'protocol.js'), 'utf8');
  vm.runInContext(protocolSrc, sandbox, { filename: 'protocol.js' });
  const workerSrc = fs.readFileSync(path.join(ROOT, 'js', 'ws-worker.js'), 'utf8');
  vm.runInContext(workerSrc, sandbox, { filename: 'ws-worker.js' });

  function send(msg) { sandbox.self.onmessage({ data: msg }); }
  function waitFor(pred, timeoutMs = 15000, label) {
    for (const ev of events) if (pred(ev)) return Promise.resolve(ev);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error('等待超时: ' + (label || 'event') +
          '，最近事件: ' + events.slice(-6).map((e) => e.type || e.kind + ':' + (e.dir || '')).join(', ')));
      }, timeoutMs);
      waiters.push({ pred, resolve, reject, timer });
    });
  }
  return { send, waitFor, events, stateSnapshots,
           dispose: () => send({ cmd: 'dispose' }) };
}

const isData = (dir) => (m) => m.kind === 'data' && (!dir || m.dir === dir);
const isEvent = (type) => (m) => m.kind === 'event' && m.type === type;

/* ---------------- Protocol 纯函数 ---------------- */

async function testProtocol() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'protocol.js'), 'utf8');
  const ctx = { console, URL, ArrayBuffer };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const P = ctx.Protocol;

  await test('合法 ws/wss 地址通过校验', () => {
    assert.equal(P.validateUrl('ws://localhost:8080/ws').ok, true);
    assert.equal(P.validateUrl('wss://a.b/c').ok, true);
  });
  await test('空地址 / 非 ws 协议 / 畸形 URL 分别拒绝', () => {
    assert.equal(P.validateUrl('').reason, 'empty');
    assert.equal(P.validateUrl('http://x/').reason, 'invalid-scheme');
    assert.equal(P.validateUrl('not a url').reason, 'invalid-url');
  });
  await test('解析带 seq 的协议数据消息', () => {
    const r = P.parseIncoming(JSON.stringify({ type: 'data', seq: 7, ts: 1, text: 'hi' }));
    assert.equal(r.protocol, true);
    assert.equal(r.seq, 7);
  });
  await test('解析 sync 响应并排序无关（调用方排序）', () => {
    const r = P.parseIncoming(JSON.stringify({
      type: 'sync', from: 5, items: [{ seq: 6, ts: 2, text: 'a' }, { seq: 7 }],
    }));
    assert.equal(r.type, 'sync');
    assert.equal(r.items.length, 2);
  });
  await test('二进制消息被识别', () => {
    const r = P.parseIncoming(new ArrayBuffer(4));
    assert.equal(r.binary, true);
  });
  await test('相同内容哈希相同（无序号去重基础）', () => {
    assert.equal(P.contentHash('abc'), P.contentHash('abc'));
    assert.notEqual(P.contentHash('abc'), P.contentHash('abd'));
  });
  await test('纯文本无协议消息 seq 为 null', () => {
    const r = P.parseIncoming('hello world');
    assert.equal(r.protocol, false);
    assert.equal(r.seq, null);
  });
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('0) 语法检查全部 JS 文件');
  for (const rel of ['js/protocol.js', 'js/db.js', 'js/timeline.js',
                     'js/app.js', 'js/ws-worker.js', 'tools/server.js']) {
    new vm.Script(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel });
  }
  console.log('  \u2713 6 个 JS 文件语法正确');

  console.log('1) Protocol 纯函数');
  await testProtocol();

  console.log('2) 连接与基础收发');
  const server = new FakeServer();
  const FakeWS = makeWebSocketCtor(server);
  const w = createWorkerHarness(FakeWS);
  w.send({ cmd: 'connect', url: NORMAL_URL });
  await w.waitFor(isEvent('open'), 5000, 'open');
  const welcome = await w.waitFor(
    (m) => isData('recv')(m) && m.text.includes('connected'), 5000, 'welcome');
  assert.equal(welcome.seq, 1);

  await test('发送文本后收到 echo 且记录为发送/接收两条', async () => {
    w.send({ cmd: 'send', text: 'hello' });
    const sent = w.events.find((m) => isData('send')(m) && m.text === 'hello');
    assert.ok(sent, '存在发送记录');
    assert.equal(sent.clientSeq, 1);
    const echo = await w.waitFor(
      (m) => isData('recv')(m) && m.text === 'echo: hello', 5000, 'echo');
    assert.equal(echo.flags.outOfOrder, false);
  });

  console.log('3) 异常：重复与乱序');
  await test('重复消息标记 duplicate（界面负责去重展示）', async () => {
    w.send({ cmd: 'send', text: JSON.stringify({ chaos: 'duplicate' }) });
    const dup = await w.waitFor(
      (m) => isData('recv')(m) && m.text === 'dup tick' && m.flags.duplicate === true,
      5000, 'dup tick duplicate');
    assert.equal(dup.flags.duplicate, true);
    assert.match(dup.note, /重复/);
    // 同一序号确实到达两次，第二次被标记重复
    const sameSeq = w.events.filter((m) => isData('recv')(m) && m.seq === dup.seq);
    assert.equal(sameSeq.length, 2);
    assert.equal(sameSeq[0].flags.duplicate, false);
    assert.equal(sameSeq[1].flags.duplicate, true);
  });

  await test('乱序消息标记 outOfOrder', async () => {
    w.send({ cmd: 'send', text: JSON.stringify({ chaos: 'reorder' }) });
    const ooo = await w.waitFor(
      (m) => isData('recv')(m) && m.flags.outOfOrder === true, 5000, 'outOfOrder');
    assert.equal(ooo.flags.outOfOrder, true);
    const a = w.events.filter((m) => isData('recv')(m) && m.text === 'reordered A')[0];
    assert.equal(a.flags.outOfOrder, false, '后到的小序号补齐水位，自身不重复');
  });

  console.log('4) 异常：断线 -> 退避重连 -> 补偿');
  await test('drop 后指数退避重连，sync 补偿全部缺失并打 compensated 标记', async () => {
    // 独立服务器/Worker，保证序号从 1 开始，缺口恰好 3 条
    const srvGap = new FakeServer();
    const wGap = createWorkerHarness(makeWebSocketCtor(srvGap));
    wGap.send({ cmd: 'connect', url: NORMAL_URL });
    await wGap.waitFor(isEvent('open'), 5000);
    await wGap.waitFor((m) => isData('recv')(m) && m.seq === 1, 5000, 'welcome');
    wGap.send({ cmd: 'send', text: JSON.stringify({ chaos: 'gap' }) });
    wGap.send({ cmd: 'send', text: JSON.stringify({ chaos: 'drop' }) });
    await wGap.waitFor(isEvent('disconnect'), 5000, 'disconnect');
    const backoffEv = await wGap.waitFor(isEvent('backoff'), 5000, 'backoff');
    assert.ok(backoffEv.detail.delayMs >= 1000, '首次退避约 1s');
    await wGap.waitFor(isEvent('reconnect_attempt'), 5000, 'attempt');
    await wGap.waitFor(isEvent('reconnected'), 40000, 'reconnected');
    await wGap.waitFor(isEvent('sync_request'), 5000, 'sync request');
    const done = await wGap.waitFor(isEvent('sync_done'), 15000, 'sync done');
    assert.equal(done.detail.accepted, 3);
    const comps = wGap.events.filter(
      (m) => isData('recv')(m) && m.flags.compensated === true);
    assert.equal(comps.length, 3);
    assert.deepEqual(comps.map((m) => m.seq).sort((a, b) => a - b), [2, 3, 4]);
    const lastState = wGap.stateSnapshots[wGap.stateSnapshots.length - 1];
    assert.ok(lastState.totalReconnects >= 1);
    assert.ok(lastState.compensatedMessages >= 3);
    assert.equal(done.detail.missing, 0, '补偿后缺口归零');
  });

  console.log('5) 异常：补偿失败 -> 退避重试 -> 成功（blackhole）');
  await test('首次 sync 超时并重试，第二次拿到补偿', async () => {
    const srv2 = new FakeServer();
    const w2 = createWorkerHarness(makeWebSocketCtor(srv2));
    w2.send({ cmd: 'connect', url: NORMAL_URL });
    await w2.waitFor(isEvent('open'), 5000);
    w2.send({ cmd: 'send', text: JSON.stringify({ chaos: 'blackhole' }) });
    w2.send({ cmd: 'send', text: JSON.stringify({ chaos: 'drop' }) });
    await w2.waitFor(isEvent('disconnect'), 5000);
    await w2.waitFor(isEvent('reconnected'), 40000);
    await w2.waitFor(isEvent('sync_timeout'), 8000, 'sync timeout');
    await w2.waitFor(isEvent('sync_retry'), 8000, 'sync retry');
    const done = await w2.waitFor(isEvent('sync_done'), 15000, 'sync done retry');
    assert.equal(done.detail.accepted, 3);
    assert.equal(done.detail.missing, 0);
  });

  console.log('6) 异常：地址非法 / 连接失败 / 连接超时');
  await test('http:// 地址立即 connect_invalid 且不触发任何重连', async () => {
    const w3 = createWorkerHarness(FakeWS);
    w3.send({ cmd: 'connect', url: 'http://localhost:1/' });
    const ev = await w3.waitFor(isEvent('connect_invalid'), 3000);
    assert.equal(ev.detail, 'invalid-scheme');
    await sleep(300);
    assert.equal(w3.events.filter(isEvent('backoff')).length, 0);
  });

  await test('空地址被拒绝', async () => {
    const w3 = createWorkerHarness(FakeWS);
    w3.send({ cmd: 'connect', url: '   ' });
    const ev = await w3.waitFor(isEvent('connect_invalid'), 3000);
    assert.equal(ev.detail, 'empty');
  });

  await test('服务不可达时走 connect_failed + 退避重连', async () => {
    const w4 = createWorkerHarness(FakeWS);
    w4.send({ cmd: 'connect', url: REFUSED_URL });
    await w4.waitFor(isEvent('connect_failed'), 5000, 'connect failed');
    const backoff = await w4.waitFor(isEvent('backoff'), 5000);
    assert.ok(backoff.detail.attempt === 1);
    w4.dispose();
  });

  await test('建连超时触发 connect_timeout', async () => {
    const w5 = createWorkerHarness(FakeWS);
    w5.send({ cmd: 'connect', url: TIMEOUT_URL });
    await w5.waitFor(isEvent('connecting'), 3000);
    const t0 = Date.now();
    await w5.waitFor(isEvent('connect_timeout'), 10000, 'connect timeout');
    assert.ok(Date.now() - t0 < 10000, '超时阈值 8s');
    await w5.waitFor(isEvent('backoff'), 10000, 'timeout->backoff');
    w5.dispose();
  }, );

  console.log('7) 页面卸载清理');
  await test('dispose 后关闭连接且不再产生任何事件', async () => {
    const srv3 = new FakeServer();
    const w6 = createWorkerHarness(makeWebSocketCtor(srv3));
    w6.send({ cmd: 'connect', url: NORMAL_URL });
    await w6.waitFor(isEvent('open'), 5000);
    w6.dispose();
    const count = w6.events.length;
    await sleep(1200);
    assert.equal(w6.events.length, count);
  });

  if (process.argv.includes('--cap')) {
    console.log('8) 重连上限（约 60-70s）');
    await test('持续拒绝连接时第 6 次重连后 reconnect_exhausted', async () => {
      const w7 = createWorkerHarness(FakeWS);
      w7.send({ cmd: 'connect', url: REFUSED_URL });
      await w7.waitFor(isEvent('reconnect_exhausted'), 120000);
      assert.equal(
        w7.events.filter(isEvent('reconnect_attempt')).length, 6);
      assert.equal(w7.events.filter(isEvent('backoff')).length, 6);
    });
  }

  console.log('\\n全部通过：' + passed + ' 组测试');
}

main().catch((err) => {
  console.error('\\n测试失败：', err);
  process.exit(1);
});
