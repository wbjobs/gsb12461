/*
 * Canvas 消息时序图。
 * 两条泳道：上=发送，下=接收；按真实时间戳定位。
 * 标记：乱序(黄) / 重复(紫) / 补偿(青) / 接收缺口区间(红色底纹)。
 * 支持滚轮缩放、拖拽平移、悬停 tooltip、跟随最新。
 */
(function (global) {
  'use strict';

  const COLORS = {
    send: '#4f8cff',
    recv: '#37c46d',
    ooo: '#f0b429',
    dup: '#b07cf0',
    comp: '#2ec8d9',
    axis: '#3a4763',
    grid: '#232e47',
    text: '#8d9bb8',
    lane: '#141b2c',
    gap: 'rgba(239, 83, 80, 0.18)',
    gapBorder: 'rgba(239, 83, 80, 0.55)',
  };

  const PAD = { top: 26, right: 14, bottom: 30, left: 54 };
  const RADIUS = 5;
  const VIEW_MS_INITIAL = 60000; // 初始窗口 60s
  const MIN_VIEW_MS = 1000;
  const MAX_VIEW_MS = 24 * 3600 * 1000;

  function Timeline(canvas, tooltipEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltipEl = tooltipEl;
    this.messages = [];
    this.events = [];
    this.dpr = global.devicePixelRatio || 1;
    this.viewMs = VIEW_MS_INITIAL;
    this.viewEnd = null; // 视窗右端时间；null 表示跟随最新
    this.follow = true;
    this.dragging = false;
    this.dragStartX = 0;
    this.dragStartViewEnd = 0;
    this.hoverIndex = -1;
    this.rafQueued = false;

    this.bindEvents();
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas.parentElement);
    }
    this.animate();
  }

  Timeline.prototype.bindEvents = function () {
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('mousedown', (e) => this.onDown(e));
    global.addEventListener('mousemove', (e) => this.onMove(e));
    global.addEventListener('mouseup', (e) => this.onUp(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverIndex = -1;
      this.hideTooltip();
      this.requestDraw();
    });
  };

  Timeline.prototype.resize = function () {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.w = Math.max(320, rect.width);
    this.h = Math.max(200, rect.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.requestDraw();
  };

  Timeline.prototype.setFollow = function (follow) {
    this.follow = follow;
    if (follow) this.viewEnd = null;
    this.requestDraw();
  };

  Timeline.prototype.zoomBy = function (factor) {
    this.viewMs = clamp(this.viewMs * factor, MIN_VIEW_MS, MAX_VIEW_MS);
    this.follow = false;
    this.requestDraw();
  };

  Timeline.prototype.reset = function () {
    this.viewMs = VIEW_MS_INITIAL;
    this.viewEnd = null;
    this.follow = true;
    this.requestDraw();
  };

  Timeline.prototype.setData = function (messages, events) {
    this.messages = messages;
    this.events = events || [];
    this.requestDraw();
  };

  Timeline.prototype.requestDraw = function () {
    if (this.rafQueued) return;
    this.rafQueued = true;
    requestAnimationFrame(() => {
      this.rafQueued = false;
      this.draw();
    });
  };

  Timeline.prototype.animate = function () {
    if (this.follow) this.requestDraw();
    requestAnimationFrame(() => this.animate());
  };

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  /* ---------- 交互 ---------- */

  Timeline.prototype.onWheel = function (e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const oldView = this.currentView();
    const tAtMouse = oldView.start + (mouseX - PAD.left) / this.plotWidth() * this.viewMs;
    this.viewMs = clamp(this.viewMs * factor, MIN_VIEW_MS, MAX_VIEW_MS);
    // 缩放后保持鼠标位置对应的时间点不动
    const ratio = (mouseX - PAD.left) / this.plotWidth();
    this.viewEnd = tAtMouse + (1 - ratio) * this.viewMs;
    this.follow = false;
    this.requestDraw();
    if (this.onUserNavigate) this.onUserNavigate(false);
  };

  Timeline.prototype.onDown = function (e) {
    this.dragging = true;
    this.dragStartX = e.clientX;
    const view = this.currentView();
    this.dragStartViewEnd = view.end;
    this.canvas.style.cursor = 'grabbing';
  };

  Timeline.prototype.onMove = function (e) {
    const rect = this.canvas.getBoundingClientRect();
    if (this.dragging) {
      const dx = e.clientX - this.dragStartX;
      const dt = (dx / this.plotWidth()) * this.viewMs;
      this.viewEnd = this.dragStartViewEnd - dt;
      this.follow = false;
      if (this.onUserNavigate) this.onUserNavigate(false);
      this.requestDraw();
      return;
    }
    if (e.target !== this.canvas) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = this.hitTest(x, y);
    if (hit !== this.hoverIndex) {
      this.hoverIndex = hit;
      this.requestDraw();
    }
    if (hit >= 0) this.showTooltip(hit, e.clientX - rect.left, e.clientY - rect.top);
    else this.hideTooltip();
  };

  Timeline.prototype.onUp = function () {
    if (this.dragging) {
      this.dragging = false;
      this.canvas.style.cursor = '';
    }
  };

  Timeline.prototype.plotWidth = function () {
    return Math.max(10, this.w - PAD.left - PAD.right);
  };

  Timeline.prototype.currentView = function () {
    const end = this.follow || this.viewEnd === null ? Date.now() : this.viewEnd;
    return { start: end - this.viewMs, end };
  };

  Timeline.prototype.xForTs = function (ts, view) {
    return PAD.left + ((ts - view.start) / this.viewMs) * this.plotWidth();
  };

  Timeline.prototype.laneY = function (dir) {
    const top = PAD.top + 12;
    const laneH = (this.h - PAD.top - PAD.bottom - 24 - 12) / 2;
    return { send: top + laneH / 2, recv: top + laneH + laneH / 2,
             laneH, sendTop: top, recvTop: top + laneH };
  };

  Timeline.prototype.hitTest = function (x, y) {
    const view = this.currentView();
    const lanes = this.laneY();
    let best = -1;
    let bestDist = RADIUS * 3;
    this.messages.forEach((m, i) => {
      if (m.dir !== 'send' && m.dir !== 'recv') return;
      if (m.ts < view.start || m.ts > view.end) return;
      const cx = this.xForTs(m.ts, view);
      const cy = m.dir === 'send' ? lanes.send : lanes.recv;
      const dist = Math.hypot(cx - x, cy - y);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
  };

  Timeline.prototype.showTooltip = function (index, x, y) {
    const m = this.messages[index];
    if (!m) return;
    const flags = [];
    if (m.flags.outOfOrder) flags.push('乱序');
    if (m.flags.duplicate) flags.push('重复');
    if (m.flags.compensated) flags.push('补偿');
    if (m.flags.gap) flags.push('缺口');
    const time = new Date(m.ts).toLocaleTimeString('zh-CN', { hour12: false }) +
                 '.' + String(m.ts % 1000).padStart(3, '0');
    const seqLabel = m.seq !== null && m.seq !== undefined ? '#' + m.seq : '无序号';
    const body = String(m.text).length > 120 ? String(m.text).slice(0, 120) + '…' : String(m.text);
    this.tooltipEl.textContent =
      (m.dir === 'send' ? '发送' : '接收') + ' ' + seqLabel + '  ' + time +
      (flags.length ? '\n[' + flags.join(' / ') + ']' : '') + '\n' + body;
    this.tooltipEl.hidden = false;
    const px = Math.min(x + 12, this.w - 310);
    const py = Math.max(4, y - 60);
    this.tooltipEl.style.left = px + 'px';
    this.tooltipEl.style.top = py + 'px';
  };

  Timeline.prototype.hideTooltip = function () {
    this.tooltipEl.hidden = true;
  };

  /* ---------- 绘制 ---------- */

  Timeline.prototype.computeGaps = function () {
    // 按 seq 排序的接收消息（含补偿），找出非连续区间
    const withSeq = this.messages
      .filter((m) => m.dir === 'recv' && Number.isFinite(m.seq))
      .slice()
      .sort((a, b) => a.seq - b.seq);
    const gaps = [];
    const bySeq = new Map();
    withSeq.forEach((m) => { if (!bySeq.has(m.seq)) bySeq.set(m.seq, m); });
    const seqs = Array.from(bySeq.keys()).sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i += 1) {
      const prevSeq = seqs[i - 1];
      const curSeq = seqs[i];
      if (curSeq > prevSeq + 1) {
        const before = bySeq.get(prevSeq);
        const after = bySeq.get(curSeq);
        gaps.push({
          fromTs: before.ts,
          toTs: after.ts,
          fromSeq: prevSeq,
          toSeq: curSeq,
          missing: curSeq - prevSeq - 1,
        });
      }
    }
    return gaps;
  };

  Timeline.prototype.draw = function () {
    const ctx = this.ctx;
    const view = this.currentView();
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';

    this.drawLanes(view);
    this.drawGrid(view);
    this.drawEvents(view);
    this.drawGaps(view);
    this.drawMessages(view);
    this.drawNowLine(view);
  };

  Timeline.prototype.drawLanes = function (view) {
    const ctx = this.ctx;
    const lanes = this.laneY();
    ctx.fillStyle = COLORS.lane;
    ctx.fillRect(PAD.left, lanes.sendTop - 6, this.plotWidth(), lanes.laneH);
    ctx.fillRect(PAD.left, lanes.recvTop - 6, this.plotWidth(), lanes.laneH);

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.send;
    ctx.fillText('发送 ▸', PAD.left - 8, lanes.send);
    ctx.fillStyle = COLORS.recv;
    ctx.fillText('◂ 接收', PAD.left - 8, lanes.recv);
  };

  Timeline.prototype.chooseTick = function () {
    const targetPx = 110;
    const msPerPx = this.viewMs / this.plotWidth();
    const candidates = [100, 250, 500, 1000, 2000, 5000, 10000, 30000,
      60000, 120000, 300000, 600000, 900000, 1800000, 3600000,
      6 * 3600000, 12 * 3600000, 24 * 3600000];
    for (let i = 0; i < candidates.length; i += 1) {
      if (candidates[i] / msPerPx >= targetPx) return candidates[i];
    }
    return 24 * 3600000;
  };

  Timeline.prototype.formatTick = function (t, tickMs) {
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    if (tickMs < 1000) return hm + '.' + String(d.getMilliseconds()).padStart(3, '0');
    if (tickMs < 60000) return hm;
    return hm;
  };

  Timeline.prototype.drawGrid = function (view) {
    const ctx = this.ctx;
    const tickMs = this.chooseTick();
    const first = Math.ceil(view.start / tickMs) * tickMs;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = first; t <= view.end; t += tickMs) {
      const x = Math.round(this.xForTs(t, view)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, this.h - PAD.bottom);
      ctx.stroke();
      ctx.fillText(this.formatTick(t, tickMs), x, this.h - PAD.bottom + 7);
    }
    // 底轴
    ctx.strokeStyle = COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(PAD.left, this.h - PAD.bottom + 0.5);
    ctx.lineTo(this.w - PAD.right, this.h - PAD.bottom + 0.5);
    ctx.stroke();
  };

  Timeline.prototype.drawEvents = function (view) {
    const ctx = this.ctx;
    const relevant = {
      open: { color: '#37c46d', label: '连接' },
      reconnected: { color: '#2ec8d9', label: '重连' },
      disconnect: { color: '#ef5350', label: '断线' },
      disconnect_timeout: { color: '#f0b429', label: '超时断线' },
      sync_done: { color: '#2ec8d9', label: '补偿完成' },
      sync_failed: { color: '#ef5350', label: '补偿失败' },
      reconnect_exhausted: { color: '#ef5350', label: '重连上限' },
      closed: { color: '#8d9bb8', label: '断开' },
    };
    (this.events || []).forEach((ev) => {
      const cfg = relevant[ev.type];
      if (!cfg) return;
      if (ev.ts < view.start - 500 || ev.ts > view.end + 500) return;
      const x = this.xForTs(ev.ts, view);
      if (x < PAD.left - 2 || x > this.w - PAD.right + 2) return;
      ctx.strokeStyle = cfg.color;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, this.h - PAD.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.save();
      ctx.translate(x + 3, PAD.top + 2);
      ctx.fillStyle = cfg.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(cfg.label, 0, 0);
      ctx.restore();
    });
  };

  Timeline.prototype.drawGaps = function (view) {
    const ctx = this.ctx;
    const lanes = this.laneY();
    this.computeGaps().forEach((gap) => {
      if (gap.toTs < view.start || gap.fromTs > view.end) return;
      const x1 = this.xForTs(Math.max(gap.fromTs, view.start), view);
      const x2 = this.xForTs(Math.min(gap.toTs, view.end), view);
      if (x2 - x1 < 2) return;
      ctx.fillStyle = COLORS.gap;
      ctx.strokeStyle = COLORS.gapBorder;
      ctx.lineWidth = 1;
      const y = lanes.recvTop - 6;
      ctx.fillRect(x1, y, x2 - x1, lanes.laneH);
      ctx.strokeRect(x1 + 0.5, y, x2 - x1, lanes.laneH);
      if (x2 - x1 > 34) {
        ctx.fillStyle = COLORS.gapBorder;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('缺 ' + gap.missing, (x1 + x2) / 2, y + lanes.laneH / 2);
      }
    });
  };

  Timeline.prototype.drawMessages = function (view) {
    const ctx = this.ctx;
    const lanes = this.laneY();
    this.messages.forEach((m, i) => {
      if (m.dir !== 'send' && m.dir !== 'recv') return;
      if (m.ts < view.start || m.ts > view.end) return;
      const x = this.xForTs(m.ts, view);
      if (x < PAD.left - 10 || x > this.w - PAD.right + 10) return;
      const y = m.dir === 'send' ? lanes.send : lanes.recv;

      let color = m.dir === 'send' ? COLORS.send : COLORS.recv;
      if (m.flags.duplicate) color = COLORS.dup;
      else if (m.flags.outOfOrder) color = COLORS.ooo;
      if (m.flags.compensated) {
        ctx.strokeStyle = COLORS.comp;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, RADIUS + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      if (m.flags.duplicate) {
        ctx.rect(x - RADIUS + 1, y - RADIUS + 1, (RADIUS - 1) * 2, (RADIUS - 1) * 2);
      } else {
        ctx.arc(x, y, RADIUS, 0, Math.PI * 2);
      }
      ctx.fill();

      if (i === this.hoverIndex) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, RADIUS + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 有空间时标注序号
      if (Number.isFinite(m.seq)) {
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = m.dir === 'send' ? 'top' : 'bottom';
        const labelY = m.dir === 'send' ? y + RADIUS + 2 : y - RADIUS - 2;
        if (this.viewMs / this.plotWidth() < 400) {
          ctx.fillText(String(m.seq), x, labelY);
        }
      }
    });
  };

  Timeline.prototype.drawNowLine = function (view) {
    if (view.end < Date.now() - 50) return;
    const ctx = this.ctx;
    const x = this.xForTs(view.end, view);
    ctx.strokeStyle = 'rgba(79,140,255,.7)';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, PAD.top);
    ctx.lineTo(x + 0.5, this.h - PAD.bottom);
    ctx.stroke();
  };

  global.Timeline = Timeline;
})(window);
