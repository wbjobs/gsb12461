/*
 * 协议工具：URL 校验、消息编解码、序号识别、内容哈希。
 * 同时供主线程（<script>）与 Web Worker（importScripts）使用，
 * 因此不依赖任何全局对象之外的东西。
 */
(function (global) {
  'use strict';

  const PROTOCOL_TYPE_DATA = 'data';
  const PROTOCOL_TYPE_SYNC = 'sync';

  /**
   * 校验 WebSocket 地址。
   * 区分两类错误：非法地址（不重试）由调用方按 'invalid' 处理。
   */
  function validateUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      return { ok: false, reason: 'empty' };
    }
    let url;
    try {
      url = new URL(rawUrl.trim());
    } catch (_err) {
      return { ok: false, reason: 'invalid-url' };
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return { ok: false, reason: 'invalid-scheme' };
    }
    if (!url.hostname) {
      return { ok: false, reason: 'invalid-host' };
    }
    return { ok: true, url: url.href };
  }

  /**
   * 构造发送数据包。
   */
  function buildData(seq, text) {
    return JSON.stringify({ type: PROTOCOL_TYPE_DATA, seq, ts: Date.now(), text });
  }

  function buildSync(lastSeq) {
    return JSON.stringify({ type: PROTOCOL_TYPE_SYNC, lastSeq, ts: Date.now() });
  }

  /**
   * 解析收到的数据。
   * 返回:
   *  { protocol:true, type:'data'|'sync', seq, ts, text, from, items }
   *  或 { protocol:false, seq:number|null, ts:number|null, text:string }
   * binary 输入返回 { binary:true, size, text:'[binary N bytes]' }
   */
  function parseIncoming(data) {
    if (data instanceof ArrayBuffer) {
      return { binary: true, protocol: false, seq: null, ts: null, size: data.byteLength,
               text: '[binary ' + data.byteLength + ' bytes]' };
    }
    let text;
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      return { binary: true, protocol: false, seq: null, ts: null, size: data.size,
               text: '[binary ' + data.size + ' bytes]' };
    }
    if (typeof data !== 'string') {
      text = String(data);
    } else {
      text = data;
    }

    let obj = null;
    if (text.length > 0 && (text[0] === '{' || text[0] === '[')) {
      try { obj = JSON.parse(text); } catch (_e) { obj = null; }
    }

    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const type = typeof obj.type === 'string' ? obj.type : null;
      if (type === PROTOCOL_TYPE_DATA && Number.isFinite(obj.seq)) {
        return {
          protocol: true, type: 'data',
          seq: normalizeSeq(obj.seq),
          ts: Number.isFinite(obj.ts) ? obj.ts : null,
          text: obj.text === undefined ? text : String(obj.text),
        };
      }
      if (type === PROTOCOL_TYPE_SYNC && Array.isArray(obj.items)) {
        return {
          protocol: true, type: 'sync',
          from: normalizeSeq(obj.from),
          items: obj.items
            .filter((it) => it && Number.isFinite(it.seq))
            .map((it) => ({
              seq: normalizeSeq(it.seq),
              ts: Number.isFinite(it.ts) ? it.ts : null,
              text: it.text === undefined ? '' : String(it.text),
            })),
        };
      }
      // 非标准协议，但带常见序号字段：尽力识别乱序/重复
      const guessedSeq = guessSeqField(obj);
      if (guessedSeq !== null) {
        return { protocol: false, seq: guessedSeq, ts: guessTsField(obj),
                 text, guessed: true };
      }
    }

    return { protocol: false, seq: null, ts: null, text };
  }

  function guessSeqField(obj) {
    const keys = ['seq', 'sequence', 'id', 'messageId', 'msgId', 'index'];
    for (const key of keys) {
      if (Number.isFinite(obj[key])) return normalizeSeq(obj[key]);
    }
    return null;
  }

  function guessTsField(obj) {
    const keys = ['ts', 'timestamp', 'time'];
    for (const key of keys) {
      if (Number.isFinite(obj[key])) return Number(obj[key]);
    }
    return null;
  }

  function normalizeSeq(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : Math.trunc(n);
  }

  /** 32 位 FNV-1a 内容哈希，用于无序号消息的重复检测 */
  function contentHash(text) {
    let hash = 0x811c9dc5;
    const str = String(text);
    for (let i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  const api = {
    validateUrl,
    buildData,
    buildSync,
    parseIncoming,
    contentHash,
    normalizeSeq,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.Protocol = api;
})(typeof self !== 'undefined' ? self : this);
