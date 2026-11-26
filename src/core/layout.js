// 좌석 배치: 수직 정렬된 책상 4라인 × 라인당 3개 = 12석
// 모니터 위치: 제일 좌측 라인부터 우 / 좌 / 우 / 좌
export const LINE_COUNT = 4;
export const DESKS_PER_LINE = 3;
export const MONITOR_SIDES = ['right', 'left', 'right', 'left'];

export const SEATS = Array.from({ length: LINE_COUNT }, (_, li) =>
  Array.from({ length: DESKS_PER_LINE }, (_, di) => ({
    id: `L${li + 1}-${di + 1}`,
    line: li + 1,
    position: di + 1,
    monitorSide: MONITOR_SIDES[li],
  })),
).flat();

export const SEAT_IDS = SEATS.map((s) => s.id);

export function isValidSeatId(id) {
  return SEAT_IDS.includes(id);
}
