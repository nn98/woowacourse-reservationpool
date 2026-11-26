// 더미 모드용 저장소: localStorage + BroadcastChannel 로 같은 브라우저의 탭끼리 동기화
import { createEmptyState, stableStringify } from '../core/pool.js';

const KEY = 'reservationPool/current';

export function createLocalStore() {
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(KEY) : null;
  const listeners = new Set();
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) ?? createEmptyState();
    } catch {
      return createEmptyState();
    }
  };
  const emit = () => listeners.forEach((cb) => cb(read()));
  channel?.addEventListener('message', emit);
  window.addEventListener('storage', (e) => e.key === KEY && emit());

  return {
    mode: 'dummy',
    subscribe(cb) {
      listeners.add(cb);
      cb(read());
      return () => listeners.delete(cb);
    },
    async transact(fn) {
      const prev = read();
      const next = fn(prev);
      if (stableStringify(prev) === stableStringify(next)) return next;
      localStorage.setItem(KEY, JSON.stringify(next));
      channel?.postMessage('changed');
      emit();
      return next;
    },
    async reset() {
      localStorage.removeItem(KEY);
      channel?.postMessage('changed');
      emit();
    },
  };
}
