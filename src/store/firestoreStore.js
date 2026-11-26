// 실제 모드: Firestore 문서 하나(reservationPool/current)에 전체 상태를 두고 트랜잭션으로 갱신
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, onSnapshot, runTransaction } from 'firebase/firestore';
import { createEmptyState, stableStringify } from '../core/pool.js';

export function createFirestoreStore(firebaseConfig) {
  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const ref = doc(db, 'reservationPool', 'current');

  return {
    mode: 'firebase',
    subscribe(cb, onError) {
      return onSnapshot(
        ref,
        (snap) => cb(snap.exists() ? snap.data() : createEmptyState()),
        (err) => onError?.(err),
      );
    },
    transact(fn) {
      return runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const prev = snap.exists() ? snap.data() : createEmptyState();
        const next = fn(prev);
        if (stableStringify(prev) !== stableStringify(next)) tx.set(ref, next);
        return next;
      });
    },
  };
}
