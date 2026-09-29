// Node 集成测试：序号分析逻辑 + 连接管理（非法地址/超时/重连退避/上限/补偿）
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. 序号分析 Worker ----------
function testSequencer() {
  console.log('[sequencer]');
  const results = [];
  const self = { postMessage: (m) => results.push(m) };
  const src = fs.readFileSync(path.join(ROOT, 'js/sequencer-worker.js'), 'utf8');
  new Function('self', src)(self);
  const ingest = (seq) => {
    self.onmessage({ data: { type: 'ingest', id: 'x', seq } });
    return results.pop();
  };
  assert(ingest(1).tags.length === 0, 'seq=1 正常');
  assert(ingest(2).tags.length === 0, 'seq=2 正常');
  const dup = ingest(2);
  assert(dup.tags.includes('dup') && dup.drop === true, 'seq=2 重复被检测并去重');
  const gap = ingest(4);
  assert(gap.tags.length === 0 && gap.stats.lost === 1, 'seq=4 检测到缺口(3丢失)');
  const fill = ingest(3);
  assert(fill.tags.includes('comp') && fill.tags.includes('oos'), 'seq=3 迟到：标记乱序+补回');
  assert(fill.stats.lost === 0 && fill.stats.compensated === 1, '补回后丢失数归零');
  const oos = ingest(5) && ingest(7) && ingest(6);
  assert(oos.tags.includes('oos'), 'seq=6 在 7 之后到达：乱序');
  assert(oos.stats.duplicate === 1, '重复统计正确');
  const noSeq = ingest(null);
  assert(noSeq.tags.length === 0, '无序号消息跳过分析');
}

// ---------- 2. 连接管理 ----------
function loadConnection(WSCtor) {
  global.window = { addEventListener() {}, removeEventListener() {} };
  const src = fs.readFileSync(path.join(ROOT, 'js/connection.js'), 'utf8');
  return new Function('window', 'WebSocket', `${src}; return WSConnection;`)
    (global.window, WSCtor || WebSocket);
}

async function testConnection() {
  const WSConnection = loadConnection();
  console.log('[connection] 地址校验');
  {
    const errs = [];
    const c = new WSConnection({ onError: (e) => errs.push(e), onState() {}, onMessage() {}, onReconnect() {}, onCompensate() {} });
    assert(c.connect('') === false && errs[0].kind === 'invalid', '空地址 -> invalid');
    assert(c.connect('not-a-url') === false && errs[1].kind === 'invalid', '无法解析 -> invalid');
    assert(c.connect('http://a.com') === false && errs[2].kind === 'invalid', 'http 协议 -> invalid');
    assert(c.connect('ws://127.0.0.1:8901/ws') === true, '合法 ws 地址通过校验');
    c.destroy();
  }

  console.log('[connection] 连接超时（注入永不响应的假 WebSocket）');
  {
    class HungWS {
      constructor() { this.readyState = 0; }
      close() { this.readyState = 3; }
      send() {}
    }
    HungWS.OPEN = 1;
    const HungConn = loadConnection(HungWS);
    const events = { errors: [], reconnects: [] };
    const c = new HungConn({
      onError: (e) => events.errors.push(e),
      onState() {}, onMessage() {},
      onReconnect: (n, delay) => events.reconnects.push({ n, delay }),
      onCompensate() {},
    });
    c.connectTimeout = 300;
    c.maxReconnect = 1;
    c.connect('ws://127.0.0.1:1/');
    await sleep(1500);
    assert(events.errors.filter((e) => e.kind === 'timeout').length === 2, '超时处理器触发（首次+重连各一次）');
    assert(events.errors.some((e) => e.kind === 'max-reconnect'), '超时场景同样受重连上限约束');
    c.destroy();
  }

  console.log('[connection] 连接失败 + 退避重连 + 上限');
  {
    const events = { errors: [], reconnects: [], states: [] };
    const c = new WSConnection({
      onError: (e) => events.errors.push(e),
      onState: (s) => events.states.push(s),
      onMessage() {},
      onReconnect: (n, delay) => events.reconnects.push({ n, delay, t: Date.now() }),
      onCompensate() {},
    });
    c.connectTimeout = 400;
    c.maxReconnect = 2;
    c.connect('ws://127.0.0.1:1/'); // 未监听端口 -> 连接被拒绝
    await sleep(6000);
    assert(events.errors.some((e) => e.kind === 'failed'), '拒绝连接触发 failed 错误');
    assert(events.reconnects.length === 2, `重连次数=上限(2)，实际 ${events.reconnects.length}`);
    assert(events.errors.some((e) => e.kind === 'max-reconnect'), '达到上限后停止并报 max-reconnect');
    assert(events.states.includes('failed'), '最终状态为 failed');
    const d1 = events.reconnects[0].delay, d2 = events.reconnects[1].delay;
    assert(d1 >= 500 && d1 <= 1100 && d2 >= 1000 && d2 <= 2100 && d2 > d1,
      `退避递增 (${d1}ms -> ${d2}ms)`);
    c.destroy();
  }
}

async function testServerFlow() {
  const WSConnection = loadConnection();
  console.log('[connection] 正常收发 + 断线重连 + 补偿请求');
  {
    const got = { msgs: [], comps: [], reconnects: 0, states: [] };
    let lastSeq = -1;
    const c = new WSConnection({
      onState: (s) => got.states.push(s),
      onMessage: (d) => {
        try { const m = JSON.parse(d); got.msgs.push(m.seq); if (m.seq > lastSeq) lastSeq = m.seq; } catch {}
      },
      onError() {},
      onReconnect: () => got.reconnects++,
      onCompensate: (attempt, after, err) => got.comps.push({ attempt, after, err }),
    });
    c.getLastSeq = () => lastSeq;
    c.connectTimeout = 3000;
    c.maxReconnect = 5;
    c.connect('ws://127.0.0.1:8901/ws');
    await sleep(2500);
    assert(got.states.includes('open'), '连接成功打开');
    assert(got.msgs.length >= 10, `收到消息流 (${got.msgs.length} 条)`);
    // 服务器 6s 后断线 -> 等重连与补偿
    await sleep(7000);
    assert(got.reconnects >= 1, '断线后自动重连');
    assert(got.comps.length >= 1, '重连后发起补偿请求');
    assert(got.comps[0].after >= 0, `补偿携带断点序号 after=${got.comps[0].after}`);
    c.destroy();
    assert(true, 'destroy 清理无异常');
  }
}

(async () => {
  testSequencer();
  await testConnection();
  // 沙箱环境可能禁止监听端口，服务器流程测试在不可用时跳过
  const server = spawn('node', [path.join(__dirname, 'ws-server.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let serverUp = false;
  server.stdout.on('data', (d) => { if (d.toString().includes('ws server on')) serverUp = true; });
  await sleep(800);
  try {
    if (serverUp) await testServerFlow();
    else console.log('[connection] 跳过服务器流程测试（当前环境禁止监听端口，请在本地运行）');
  } finally {
    server.kill();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
