// 主线程对 sequencer-worker 的封装（Promise 化）
class Sequencer {
  constructor() {
    this.worker = new Worker('js/sequencer-worker.js');
    this.pending = new Map();
    this.onState = null;
    this.worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'result') {
        const resolve = this.pending.get(d.id);
        if (resolve) { this.pending.delete(d.id); resolve(d); }
      } else if (d.type === 'state' && this.onState) {
        this.onState(d);
      }
    };
  }
  ingest(id, seq) {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ type: 'ingest', id, seq });
    });
  }
  reset() { this.worker.postMessage({ type: 'reset' }); }
  requestState() { this.worker.postMessage({ type: 'getState' }); }
  terminate() { this.worker.terminate(); }
}
