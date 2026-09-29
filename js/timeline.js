// Canvas 消息时序图：横轴时间，上泳道发送、下泳道接收；标记乱序/重复/补偿
class Timeline {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.events = [];        // { ts, dir, tags }
    this.windowMs = 60000;   // 显示最近 60s
    this._colors = { send: '#6fd38a', recv: '#7cc7ff', oos: '#e8a33d', dup: '#e05555', comp: '#a97fe0' };
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(canvas);
    this._resize();
  }
  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
    this.canvas.width = w * dpr;
    this.canvas.height = 120 * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  addEvent(ev) { this.events.push(ev); this.draw(); }
  clear() { this.events = []; this.draw(); }
  draw() {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth, H = 120;
    ctx.clearRect(0, 0, W, H);
    const now = Date.now();
    const t0 = now - this.windowMs;
    // 泳道分隔与轴
    ctx.strokeStyle = '#35363c';
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
    ctx.fillStyle = '#66686e';
    ctx.font = '10px sans-serif';
    ctx.fillText('发送', 4, 14);
    ctx.fillText('接收', 4, H / 2 + 14);
    ctx.fillText('-60s', 4, H - 6);
    ctx.fillText('现在', W - 26, H - 6);
    for (const ev of this.events) {
      if (ev.ts < t0) continue;
      const x = ((ev.ts - t0) / this.windowMs) * W;
      const y = ev.dir === 'send' ? H * 0.25 : H * 0.75;
      let color = this._colors[ev.dir];
      if (ev.tags.includes('dup')) color = this._colors.dup;
      else if (ev.tags.includes('oos')) color = this._colors.oos;
      else if (ev.tags.includes('comp')) color = this._colors.comp;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, ev.dir === 'send' ? y - 14 : y + 14, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }
}
