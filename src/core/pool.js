import { SEAT_IDS, isValidSeatId } from './layout.js';

export const SLOT_MIN = 30;
export const MAX_DURATION_MIN = 120;
export const DURATION_OPTIONS = [30, 60, 90, 120];
/** 같은 사람이 같은 자리를 다시 배정받기까지의 텀 (일단 5분, 추후 조정) */
export const SAME_SEAT_COOLDOWN_MIN = 5;
const MIN_MS = 60 * 1000;

export class PoolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 상태 구조 (Firestore 문서 reservationPool/current 와 동일)
 * {
 *   seats: { [seatId]: Assignment | null },
 *   queue: Waiting[],      // 등록 순서(createdAt) 유지
 *   seq: number,           // id 발급용 카운터
 *   recent: Ended[],       // 최근 종료 기록 (같은 자리 재배정 텀 계산용, 텀이 지나면 삭제)
 * }
 * Ended      = { email, seatId, endedAt }
 * Assignment = { id, nickname, email, seatId, seatPref, durationMin, startAt, endAt, createdAt }
 * Waiting    = { id, nickname, email, seatPref(null=무관), durationMin, createdAt }
 */
export function createEmptyState() {
  return {
    seats: Object.fromEntries(SEAT_IDS.map((id) => [id, null])),
    queue: [],
    seq: 0,
    recent: [],
  };
}

function normalize(state) {
  const base = createEmptyState();
  if (!state) return base;
  const s = structuredClone(state);
  return {
    seats: { ...base.seats, ...(s.seats || {}) },
    queue: Array.isArray(s.queue) ? s.queue : [],
    seq: Number.isFinite(s.seq) ? s.seq : 0,
    recent: Array.isArray(s.recent) ? s.recent : [],
  };
}

const keyOf = (email) => String(email).trim().toLowerCase();
const sameUser = (a, b) => keyOf(a.email) === keyOf(b.email);

function validateRequest({ durationMin, seatPref }) {
  if (!DURATION_OPTIONS.includes(durationMin)) {
    throw new PoolError('INVALID_DURATION', `이용 시간은 ${SLOT_MIN}분 단위, 최대 ${MAX_DURATION_MIN}분입니다.`);
  }
  if (seatPref != null && !isValidSeatId(seatPref)) {
    throw new PoolError('INVALID_SEAT', '존재하지 않는 자리입니다.');
  }
}

const COOLDOWN_MS = SAME_SEAT_COOLDOWN_MIN * MIN_MS;

function endAssignment(state, seatId, endedAt) {
  const a = state.seats[seatId];
  if (!a) return;
  state.recent.push({ email: keyOf(a.email), seatId, endedAt });
  state.seats[seatId] = null;
}

/** 같은 사람이 방금 쓰고 나간 자리면 텀 동안 배정 불가 */
export function inCooldown(state, user, seatId, now) {
  return (state.recent || []).some(
    (r) => r.seatId === seatId && r.email === keyOf(user.email) && now - r.endedAt < COOLDOWN_MS,
  );
}

function canTake(state, user, seatId, now) {
  return !state.seats[seatId] && !inCooldown(state, user, seatId, now);
}

/** 이 사용자가 지금 바로 받을 수 있는 빈 자리 목록 */
export function freeSeatsFor(input, user, now) {
  const state = normalize(input);
  return SEAT_IDS.filter((id) => canTake(state, user, id, now));
}

function assign(state, waiting, seatId, now) {
  state.seats[seatId] = {
    id: waiting.id,
    nickname: waiting.nickname,
    email: waiting.email,
    seatId,
    seatPref: waiting.seatPref ?? null,
    durationMin: waiting.durationMin,
    startAt: now,
    endAt: now + waiting.durationMin * MIN_MS,
    createdAt: waiting.createdAt,
  };
}

/**
 * 만료된 예약을 비우고 대기자를 배정한다.
 * 1) 자리 지정 대기자: 등록순으로, 원하는 자리가 비어 있으면 배정 (지정 자리 우선권)
 * 2) 무관 대기자: 등록순으로, 남은 빈 자리 중 앞 번호부터 배정
 */
export function reconcile(input, now) {
  const state = normalize(input);
  for (const id of SEAT_IDS) {
    const a = state.seats[id];
    if (a && a.endAt <= now) endAssignment(state, id, a.endAt);
  }
  state.recent = state.recent.filter((r) => now - r.endedAt < COOLDOWN_MS);

  // 중복 배정 방지: 이미 자리를 가진 사람은 대기열에서 배정 대상 제외 (한 사람 = 한 자리)
  const seated = new Set(Object.values(state.seats).filter(Boolean).map((a) => keyOf(a.email)));
  const assigned = new Set();
  const take = (w, seatId) => {
    assign(state, w, seatId, now);
    assigned.add(w.id);
    seated.add(keyOf(w.email));
  };
  for (const w of state.queue) {
    if (w.seatPref && !seated.has(keyOf(w.email)) && canTake(state, w, w.seatPref, now)) take(w, w.seatPref);
  }
  for (const w of state.queue) {
    if (w.seatPref || assigned.has(w.id) || seated.has(keyOf(w.email))) continue;
    const free = SEAT_IDS.find((id) => canTake(state, w, id, now));
    if (free) take(w, free);
  }
  state.queue = state.queue.filter((w) => !assigned.has(w.id) && !seated.has(keyOf(w.email)));
  return state;
}

export function recentlyEnded(state, user, now) {
  return (state.recent || []).some((r) => r.email === keyOf(user.email) && now - r.endedAt < COOLDOWN_MS);
}

/** 가장 최근에 끝난 내 이용 기록 (재배정 신청 버튼용) */
export function lastEnded(input, user, now) {
  const mine = normalize(input).recent.filter((r) => r.email === keyOf(user.email) && now - r.endedAt < COOLDOWN_MS);
  return mine.length ? mine[mine.length - 1] : null;
}

export function findMine(state, user) {
  const s = normalize(state);
  const active = Object.values(s.seats).find((a) => a && sameUser(a, user));
  if (active) return { status: 'active', entry: active };
  const idx = s.queue.findIndex((w) => sameUser(w, user));
  if (idx >= 0) return { status: 'waiting', entry: s.queue[idx], position: idx + 1 };
  return null;
}

export function register(input, user, request, now) {
  validateRequest(request);
  const state = reconcile(input, now);
  if (findMine(state, user)) {
    throw new PoolError('ALREADY_REGISTERED', '이미 이용 중이거나 대기 중인 예약이 있습니다.');
  }
  // 재배정 신청: 방금 이용을 마친 사람은 텀 동안 '바로 앉을 수 있는 빈 자리'가 있을 때만 신청 가능
  // (대기자가 있는데 다시 줄 서서 자리를 이어 쓰는 것 방지)
  if (recentlyEnded(state, user, now)) {
    const free = freeSeatsFor(state, user, now);
    const ok = request.seatPref ? free.includes(request.seatPref) : free.length > 0;
    if (!ok) {
      throw new PoolError(
        'REAPPLY_NO_SEAT',
        request.seatPref && inCooldown(state, user, request.seatPref, now)
          ? `같은 자리는 종료 후 ${SAME_SEAT_COOLDOWN_MIN}분이 지나야 다시 배정됩니다.`
          : '재배정 신청은 바로 배정 가능한 빈 자리가 있을 때만 가능합니다.',
      );
    }
  }
  state.seq += 1;
  const entry = {
    id: `r${state.seq}`,
    nickname: user.nickname,
    email: user.email,
    seatPref: request.seatPref ?? null,
    durationMin: request.durationMin,
    createdAt: now,
  };
  state.queue.push(entry);
  return reconcile(state, now);
}

export function cancel(input, user, entryId, now) {
  const state = reconcile(input, now);
  const seatId = SEAT_IDS.find((id) => state.seats[id]?.id === entryId);
  if (seatId) {
    if (!sameUser(state.seats[seatId], user)) throw new PoolError('FORBIDDEN', '본인 예약만 취소할 수 있습니다.');
    endAssignment(state, seatId, now);
    return reconcile(state, now);
  }
  const idx = state.queue.findIndex((w) => w.id === entryId);
  if (idx < 0) throw new PoolError('NOT_FOUND', '예약을 찾을 수 없습니다.');
  if (!sameUser(state.queue[idx], user)) throw new PoolError('FORBIDDEN', '본인 예약만 취소할 수 있습니다.');
  state.queue.splice(idx, 1);
  return reconcile(state, now);
}

/**
 * 변경
 * - 대기 중: 이용 시간 / 자리 지정 변경 가능 (대기 순번 유지)
 * - 이용 중: 이용 시간만 변경 가능 (시작 시각 기준 최대 2시간, 이미 지난 시간으로 줄일 수 없음)
 */
export function change(input, user, entryId, request, now) {
  validateRequest(request);
  const state = reconcile(input, now);
  const seatId = SEAT_IDS.find((id) => state.seats[id]?.id === entryId);
  if (seatId) {
    const a = state.seats[seatId];
    if (!sameUser(a, user)) throw new PoolError('FORBIDDEN', '본인 예약만 변경할 수 있습니다.');
    if (request.seatPref !== undefined && (request.seatPref ?? null) !== (a.seatPref ?? null)) {
      throw new PoolError('SEAT_LOCKED', '이용 중에는 자리를 바꿀 수 없습니다. 취소 후 다시 등록해 주세요.');
    }
    const endAt = a.startAt + request.durationMin * MIN_MS;
    if (endAt <= now) throw new PoolError('INVALID_DURATION', '이미 지난 시간으로는 줄일 수 없습니다.');
    a.durationMin = request.durationMin;
    a.endAt = endAt;
    return reconcile(state, now);
  }
  const w = state.queue.find((q) => q.id === entryId);
  if (!w) throw new PoolError('NOT_FOUND', '예약을 찾을 수 없습니다.');
  if (!sameUser(w, user)) throw new PoolError('FORBIDDEN', '본인 예약만 변경할 수 있습니다.');
  w.durationMin = request.durationMin;
  w.seatPref = request.seatPref ?? null;
  return reconcile(state, now);
}

/** 대기자가 지정한 자리가 비는 예상 시각 (무관이면 가장 빨리 비는 자리 기준). 참고용. */
export function estimateWaitUntil(input, waiting) {
  const state = normalize(input);
  if (waiting.seatPref) return state.seats[waiting.seatPref]?.endAt ?? null;
  const ends = Object.values(state.seats).filter(Boolean).map((a) => a.endAt);
  return ends.length ? Math.min(...ends) : null;
}

/** 키 순서와 무관한 비교용 직렬화 (Firestore 는 필드 순서를 보장하지 않음) */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
