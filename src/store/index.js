import { createLocalStore } from './localStore.js';

export async function createStore(config) {
  if (config.dummy) return createLocalStore();
  const { createFirestoreStore } = await import('./firestoreStore.js');
  return createFirestoreStore(config.firebase);
}
