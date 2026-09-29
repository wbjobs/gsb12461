// 序号分析 Worker：检测乱序、重复、缺口；重复消息在此去重。
let seen = new Set();        // 已见的接收序号
let maxSeen = -1;            // 目前见过的最大接收序号
let pendingGaps = new Set(); // 出现过缺口、尚未被补回的序号
let stats = { outOfOrder: 0, duplicate: 0, lost: 0, compensated: 0 };

function ingest(msg) {
  const { id, seq } = msg;
  if (typeof seq !== 'number' || !Number.isFinite(seq)) {
    return { id, tags: [], stats };
  }
  if (seen.has(seq)) {
    stats.duplicate++;
    return { id, tags: ['dup'], stats, drop: true };
  }
  seen.add(seq);
  const tags = [];
  if (maxSeen >= 0 && seq < maxSeen) {
    // 比更小的序号晚到 => 乱序
    stats.outOfOrder++;
    tags.push('oos');
  }
  if (seq > maxSeen) {
    // 新缺口：(maxSeen, seq) 之间的序号暂时丢失
    if (maxSeen >= 0) {
      for (let s = maxSeen + 1; s < seq; s++) {
        if (!seen.has(s)) { pendingGaps.add(s); stats.lost++; }
      }
    }
    maxSeen = seq;
  }
  if (pendingGaps.has(seq)) {
    // 补回了之前丢失的序号（可能来自补偿或乱序迟到）
    pendingGaps.delete(seq);
    stats.lost--;
    stats.compensated++;
    tags.push('comp');
  }
  return { id, tags, stats };
}

self.onmessage = (e) => {
  const data = e.data;
  if (data.type === 'ingest') {
    self.postMessage({ type: 'result', ...ingest(data) });
  } else if (data.type === 'reset') {
    seen = new Set(); maxSeen = -1; pendingGaps = new Set();
    stats = { outOfOrder: 0, duplicate: 0, lost: 0, compensated: 0 };
    self.postMessage({ type: 'reset-done' });
  } else if (data.type === 'getState') {
    self.postMessage({ type: 'state', maxSeen, stats });
  }
};
