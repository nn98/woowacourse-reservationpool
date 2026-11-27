import { describe, it, expect } from 'vitest';
import { createEmptyState, register, cancel, change, reconcile, findMine, PoolError } from '../src/core/pool.js';
import { SEAT_IDS, SEATS } from '../src/core/layout.js';
import { matchMember } from '../src/core/auth.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1, 1, 0);
const u = (n) => ({ nickname: `u${n}`, email: `u${n}@ex.com` });
const fill = (state, count, now = T0, durationMin = 60) => {
  let s = state;
  for (let i = 1; i <= count; i++) s = register(s, u(i), { durationMin, seatPref: null }, now);
  return s;
};

describe('layout', () => {
  it('4라인 × 3책상 = 12석, 모니터는 우/좌/우/좌', () => {
    expect(SEATS).toHaveLength(12);
    expect([1, 2, 3, 4].map((l) => SEATS.find((s) => s.line === l).monitorSide)).toEqual(['right', 'left', 'right', 'left']);
  });
});

describe('register', () => {
  it('무관이면 빈 자리에 즉시 배정된다', () => {
    const s = register(createEmptyState(), u(1), { durationMin: 90, seatPref: null }, T0);
    const mine = findMine(s, u(1));
    expect(mine.status).toBe('active');
    expect(mine.entry.seatId).toBe(SEAT_IDS[0]);
    expect(mine.entry.endAt).toBe(T0 + 90 * MIN);
  });

  it('지정 자리가 비어 있으면 그 자리에 배정된다', () => {
    const s = register(createEmptyState(), u(1), { durationMin: 30, seatPref: 'L3-2' }, T0);
    expect(s.seats['L3-2'].email).toBe('u1@ex.com');
  });

  it('지정 자리가 사용 중이면 다른 자리가 비어 있어도 대기한다', () => {
    let s = register(createEmptyState(), u(1), { durationMin: 30, seatPref: 'L1-1' }, T0);
    s = register(s, u(2), { durationMin: 30, seatPref: 'L1-1' }, T0);
    expect(findMine(s, u(2))).toMatchObject({ status: 'waiting', position: 1 });
  });

  it('30분 단위 최대 2시간만 허용', () => {
    expect(() => register(createEmptyState(), u(1), { durationMin: 150, seatPref: null }, T0)).toThrow(PoolError);
    expect(() => register(createEmptyState(), u(1), { durationMin: 45, seatPref: null }, T0)).toThrow(PoolError);
  });

  it('한 사람은 하나의 예약만', () => {
    const s = register(createEmptyState(), u(1), { durationMin: 30, seatPref: null }, T0);
    expect(() => register(s, { ...u(1), email: 'U1@EX.COM' }, { durationMin: 30, seatPref: null }, T0)).toThrow(/이미/);
  });

  it('만석이면 대기열에 들어간다', () => {
    let s = fill(createEmptyState(), 12);
    s = register(s, u(13), { durationMin: 30, seatPref: null }, T0);
    expect(findMine(s, u(13)).status).toBe('waiting');
  });
});

describe('reconcile', () => {
  it('만료되면 자리 지정 대기자가 무관 대기자보다 먼저 해당 자리를 받는다', () => {
    let s = fill(createEmptyState(), 12); // L1-1 = u1
    s = register(s, u(13), { durationMin: 30, seatPref: null }, T0 + 1);   // 먼저 온 무관
    s = register(s, u(14), { durationMin: 30, seatPref: 'L1-1' }, T0 + 2); // 나중 온 지정
    s = cancel(s, u(1), s.seats['L1-1'].id, T0 + 10 * MIN);
    expect(s.seats['L1-1'].email).toBe('u14@ex.com');
    expect(findMine(s, u(13)).status).toBe('waiting');
  });

  it('무관 대기자는 등록 순서대로 남는 자리를 받는다', () => {
    let s = fill(createEmptyState(), 12, T0, 30);
    s = register(s, u(13), { durationMin: 60, seatPref: null }, T0 + 1);
    s = register(s, u(14), { durationMin: 60, seatPref: null }, T0 + 2);
    s = reconcile(s, T0 + 30 * MIN);
    expect(findMine(s, u(13)).entry.seatId).toBe(SEAT_IDS[0]);
    expect(findMine(s, u(14)).entry.seatId).toBe(SEAT_IDS[1]);
    expect(findMine(s, u(13)).entry.startAt).toBe(T0 + 30 * MIN);
  });

  it('지정 대기자는 다른 자리가 비어도 배정되지 않는다', () => {
    let s = register(createEmptyState(), u(1), { durationMin: 120, seatPref: 'L2-2' }, T0);
    s = register(s, u(2), { durationMin: 30, seatPref: 'L2-2' }, T0);
    s = reconcile(s, T0 + 60 * MIN);
    expect(findMine(s, u(2)).status).toBe('waiting');
  });
});

describe('cancel / change', () => {
  it('본인 예약만 취소 가능', () => {
    const s = register(createEmptyState(), u(1), { durationMin: 30, seatPref: null }, T0);
    const id = findMine(s, u(1)).entry.id;
    expect(() => cancel(s, u(2), id, T0)).toThrow(/본인/);
    expect(findMine(cancel(s, u(1), id, T0), u(1))).toBeNull();
  });

  it('대기 중에는 자리/시간 변경 가능, 순번 유지', () => {
    let s = fill(createEmptyState(), 12);
    s = register(s, u(13), { durationMin: 30, seatPref: null }, T0);
    s = register(s, u(14), { durationMin: 30, seatPref: null }, T0);
    s = change(s, u(13), findMine(s, u(13)).entry.id, { durationMin: 120, seatPref: 'L4-3' }, T0);
    expect(findMine(s, u(13))).toMatchObject({ status: 'waiting', position: 1, entry: { durationMin: 120, seatPref: 'L4-3' } });
  });

  it('이용 중에는 시간만 변경, 시작 기준 최대 2시간', () => {
    let s = register(createEmptyState(), u(1), { durationMin: 30, seatPref: null }, T0);
    const id = findMine(s, u(1)).entry.id;
    s = change(s, u(1), id, { durationMin: 120 }, T0 + 20 * MIN);
    expect(findMine(s, u(1)).entry.endAt).toBe(T0 + 120 * MIN);
    expect(() => change(s, u(1), id, { durationMin: 30 }, T0 + 40 * MIN)).toThrow(/지난/);
  });

  it('이용 중 빈 자리로 이동 가능, 남은 시간 유지, 기존 자리는 대기자에게', () => {
    let s = register(createEmptyState(), u(1), { durationMin: 60, seatPref: 'L1-1' }, T0);
    s = register(s, u(2), { durationMin: 30, seatPref: 'L1-1' }, T0); // L1-1 대기
    const id = findMine(s, u(1)).entry.id;
    s = change(s, u(1), id, { durationMin: 60, seatPref: 'L4-1' }, T0 + 10 * MIN);
    expect(findMine(s, u(1)).entry).toMatchObject({ seatId: 'L4-1', startAt: T0, endAt: T0 + 60 * MIN });
    expect(s.seats['L1-1'].email).toBe('u2@ex.com');
    expect(s.recent).toHaveLength(0); // 이동은 종료가 아니므로 텀 없음
  });

  it('이용 중 사용 중인 자리로는 이동 불가', () => {
    let s = register(createEmptyState(), u(1), { durationMin: 60, seatPref: 'L1-1' }, T0);
    s = register(s, u(2), { durationMin: 60, seatPref: 'L1-2' }, T0);
    expect(() => change(s, u(1), findMine(s, u(1)).entry.id, { durationMin: 60, seatPref: 'L1-2' }, T0)).toThrow(/비어 있는 자리/);
  });

  it('반납하면 대기자가 즉시 배정된다', () => {
    let s = fill(createEmptyState(), 12);
    s = register(s, u(13), { durationMin: 30, seatPref: null }, T0);
    s = cancel(s, u(5), findMine(s, u(5)).entry.id, T0 + 5 * MIN);
    expect(findMine(s, u(13))).toMatchObject({ status: 'active', entry: { seatId: SEAT_IDS[4], startAt: T0 + 5 * MIN } });
  });
});

describe('auth', () => {
  const members = [{ nickname: '네오', email: 'neo@example.com' }];
  it('닉네임+이메일이 모두 일치해야 로그인', () => {
    expect(matchMember(members, ' 네오 ', 'NEO@example.com ')).toEqual({ nickname: '네오', email: 'neo@example.com' });
    expect(matchMember(members, '네오', 'other@example.com')).toBeNull();
    expect(matchMember(members, '브라운', 'neo@example.com')).toBeNull();
  });
});

describe('중복 배정 방지 / 재배정 / 같은 자리 텀', () => {
  it('상태가 꼬여 같은 사람이 대기열과 자리에 동시에 있어도 두 자리를 받지 않는다', () => {
    let s = register(createEmptyState(), u(1), { durationMin: 30, seatPref: null }, T0);
    s.queue.push({ id: 'dup', nickname: 'u1', email: 'u1@ex.com', seatPref: null, durationMin: 30, createdAt: T0 });
    s = reconcile(s, T0 + MIN);
    const seats = Object.values(s.seats).filter((a) => a && a.email === 'u1@ex.com');
    expect(seats).toHaveLength(1);
    expect(s.queue).toHaveLength(0);
  });

  it('동시 등록을 순서대로 적용해도 같은 자리는 한 명만 받는다', () => {
    let s = createEmptyState();
    for (let i = 1; i <= 3; i++) s = register(s, u(i), { durationMin: 30, seatPref: 'L1-1' }, T0);
    expect(s.seats['L1-1'].email).toBe('u1@ex.com');
    expect(s.queue.map((w) => w.email)).toEqual(['u2@ex.com', 'u3@ex.com']);
  });

  it('끝난 뒤 빈 자리가 있으면 재배정 신청 가능 (다른 자리)', () => {
    let s = register(createEmptyState(), u(1), { durationMin: 30, seatPref: null }, T0);
    s = reconcile(s, T0 + 30 * MIN);
    s = register(s, u(1), { durationMin: 30, seatPref: null }, T0 + 31 * MIN);
    expect(findMine(s, u(1)).entry.seatId).toBe('L1-2'); // L1-1 은 텀
  });

  it('같은 자리는 종료 후 5분 텀, 지나면 가능', () => {
    let s = register(createEmptyState(), u(1), { durationMin: 30, seatPref: 'L2-2' }, T0);
    const id = findMine(s, u(1)).entry.id;
    s = cancel(s, u(1), id, T0 + 10 * MIN);
    expect(() => register(s, u(1), { durationMin: 30, seatPref: 'L2-2' }, T0 + 12 * MIN)).toThrow(/5분/);
    s = register(s, u(1), { durationMin: 30, seatPref: 'L2-2' }, T0 + 15 * MIN);
    expect(s.seats['L2-2'].email).toBe('u1@ex.com');
  });

  it('텀 동안 빈 자리가 없으면 재신청(대기열 진입) 불가', () => {
    let s = fill(createEmptyState(), 12, T0, 30);
    s = register(s, u(13), { durationMin: 30, seatPref: null }, T0); // 대기
    s = cancel(s, u(1), findMine(s, u(1)).entry.id, T0 + 5 * MIN); // u13 이 L1-1 받음 → 빈 자리 0
    expect(findMine(s, u(13)).entry.seatId).toBe('L1-1');
    expect(() => register(s, u(1), { durationMin: 30, seatPref: null }, T0 + 6 * MIN)).toThrow(/빈 자리/);
  });

  it('텀이 지나면 일반 신청과 동일 (대기열 진입 가능)', () => {
    let s = fill(createEmptyState(), 12, T0, 60);
    s = cancel(s, u(1), findMine(s, u(1)).entry.id, T0);
    s = register(s, u(13), { durationMin: 30, seatPref: null }, T0);
    s = register(s, u(1), { durationMin: 30, seatPref: null }, T0 + 6 * MIN);
    expect(findMine(s, u(1)).status).toBe('waiting');
  });

  it('지정 대기자는 자신의 텀 자리는 텀이 끝날 때 배정된다', () => {
    let s = register(createEmptyState(), u(1), { durationMin: 30, seatPref: 'L3-3' }, T0);
    s = reconcile(s, T0 + 30 * MIN); // 종료, 텀 시작
    s = reconcile(s, T0 + 36 * MIN); // 텀 종료
    expect(s.recent).toHaveLength(0);
  });
});

describe('테스트 계정', () => {
  it('글렌 / 1234@test.com 로그인', async () => {
    const { readFileSync } = await import('node:fs');
    const { members } = JSON.parse(readFileSync(new URL('../public/config/members.json', import.meta.url), 'utf-8'));
    expect(matchMember(members, '글렌', '1234@test.com')).toEqual({ nickname: '글렌', email: '1234@test.com' });
  });
});
