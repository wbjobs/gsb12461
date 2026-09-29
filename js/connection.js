// WebSocket 连接管理：地址校验、连接超时、指数退避重连、重连上限、补偿请求与重试、卸载清理
class WSConnection {
  constructor(handlers) {
    this.h = handlers;            // { onState, onMessage, onError, onReconnect, onCompensate }
    this.ws = null;
    this.intentionalClose = false;
    this.reconnectCount = 0;
    this.compensateCount = 0;
    this.maxReconnect = 10;
    this.connectTimeout = 8000;
    this.maxCompRetries = 3;
    this.compEnabled = true;
    this.compTemplate = '{"type":"compensate","after":{{afterSeq}}}';
    this.getLastSeq = () => -1;  // 由外部提供：当前已连续接收到的最大序号
    this._connectTimer = null;
    this._reconnectTimer = null;
    this._compTimer = null;
    this._url = null;
    this._boundCleanup = () => this.destroy();
    window.addEventListener('pagehide', this._boundCleanup);
    window.addEventListener('beforeunload', this._boundCleanup);
  }

  static validateUrl(url) {
    if (!url || !url.trim()) return { ok: false, reason: '地址为空' };
    let u;
    try { u = new URL(url.trim()); }
    catch { return { ok: false, reason: '地址非法：无法解析为 URL' }; }
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:')
      return { ok: false, reason: `地址非法：协议必须是 ws:// 或 wss://（当前 ${u.protocol}）` };
    if (!u.hostname) return { ok: false, reason: '地址非法：缺少主机名' };
    return { ok: true, url: u.href };
  }

  connect(rawUrl) {
    const v = WSConnection.validateUrl(rawUrl);
    if (!v.ok) { this.h.onError({ kind: 'invalid', message: v.reason }); return false; }
    this._url = v.url;
    this.intentionalClose = false;
    this.reconnectCount = 0;
    this._openSocket(false);
    return true;
  }

  _openSocket(isReconnect) {
    this._clearTimers();
    this.h.onState(isReconnect ? 'reconnecting' : 'connecting');
    let settled = false;
    let opened = false;
    let reconnectScheduled = false;
    const scheduleOnce = () => {
      if (!reconnectScheduled) { reconnectScheduled = true; this._scheduleReconnect(); }
    };
    let ws;
    try { ws = new WebSocket(this._url); }
    catch (err) {
      this.h.onError({ kind: 'invalid', message: '创建连接失败：' + err.message });
      scheduleOnce();
      return;
    }
    this.ws = ws;

    this._connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      this.h.onError({ kind: 'timeout', message: `连接超时（${this.connectTimeout}ms 内未建立）` });
      scheduleOnce();
    }, this.connectTimeout);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      opened = true;
      clearTimeout(this._connectTimer);
      this.h.onState('open');
      if (isReconnect) this._requestCompensation(1);
    };
    ws.onmessage = (e) => this.h.onMessage(e.data);
    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(this._connectTimer);
        this.h.onError({ kind: 'failed', message: '连接失败（服务器不可达或拒绝连接）' });
        scheduleOnce();
      }
    };
    ws.onclose = (e) => {
      clearTimeout(this._connectTimer);
      if (this.intentionalClose) { this.h.onState('closed'); return; }
      if (!settled) {
        settled = true;
        this.h.onError({ kind: 'failed', message: '连接失败（服务器不可达或拒绝连接）' });
      } else if (opened) {
        this.h.onError({ kind: 'dropped', message: `连接断开（code=${e.code}${e.reason ? ' ' + e.reason : ''}）` });
      }
      scheduleOnce();
    };
  }

  _scheduleReconnect() {
    if (this.intentionalClose) return;
    if (this.reconnectCount >= this.maxReconnect) {
      this.h.onState('failed');
      this.h.onError({ kind: 'max-reconnect', message: `已达重连上限（${this.maxReconnect} 次），停止重连` });
      return;
    }
    this.reconnectCount++;
    // 指数退避 + 抖动：1s, 2s, 4s ... 上限 30s
    const base = Math.min(30000, 1000 * 2 ** (this.reconnectCount - 1));
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    this.h.onReconnect(this.reconnectCount, delay);
    this.h.onState('reconnecting');
    this._reconnectTimer = setTimeout(() => this._openSocket(true), delay);
  }

  _requestCompensation(attempt) {
    if (!this.compEnabled || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const after = this.getLastSeq();
    const payload = this.compTemplate.replace(/\{\{\s*afterSeq\s*\}\}/g, String(after));
    try {
      this.ws.send(payload);
      this.compensateCount++;
      this.h.onCompensate(attempt, after, null);
    } catch (err) {
      if (attempt <= this.maxCompRetries) {
        const delay = 500 * 2 ** (attempt - 1);
        this.h.onCompensate(attempt, after, `补偿请求失败，${delay}ms 后重试（${attempt}/${this.maxCompRetries}）`);
        this._compTimer = setTimeout(() => this._requestCompensation(attempt + 1), delay);
      } else {
        this.h.onCompensate(attempt, after, '补偿请求重试次数耗尽，放弃本次补偿');
      }
    }
  }

  send(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.h.onError({ kind: 'send', message: '发送失败：连接未处于打开状态' });
      return false;
    }
    try { this.ws.send(text); return true; }
    catch (err) { this.h.onError({ kind: 'send', message: '发送失败：' + err.message }); return false; }
  }

  disconnect() {
    this.intentionalClose = true;
    this._clearTimers();
    if (this.ws) { try { this.ws.close(1000, 'client disconnect'); } catch {} }
    this.h.onState('closed');
  }

  _clearTimers() {
    clearTimeout(this._connectTimer);
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._compTimer);
  }

  // 页面卸载时调用：停止重连、关闭连接、移除监听
  destroy() {
    this.intentionalClose = true;
    this._clearTimers();
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      try { this.ws.close(1000, 'page unload'); } catch {}
      this.ws = null;
    }
    window.removeEventListener('pagehide', this._boundCleanup);
    window.removeEventListener('beforeunload', this._boundCleanup);
  }
}
