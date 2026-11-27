import { loadConfig } from './config.js';
import { createStore } from './store/index.js';
import { matchMember } from './core/auth.js';
import {
  reconcile, register, cancel, change, findMine, estimateWaitUntil,
  lastEnded, freeSeatsFor, inCooldown,
  DURATION_OPTIONS, SAME_SEAT_COOLDOWN_MIN, PoolError,
} from './core/pool.js';
import { SEATS, LINE_COUNT } from './core/layout.js';

const SESSION_KEY = 'rp/session';
const TICK_MS = 15_000;
const app = document.getElementById('app');

// edit: 변경 모드일 때 선택 중인 값 { durationMin, seat } (null 이면 변경 모드 아님)
const ui = { config: null, store: null, user: null, raw: null, error: '', selectedSeat: null, edit: null };

// ---------- helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hhmm = (ms) => (ms ? new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-');
const durLabel = (m) => (m % 60 === 0 ? `${m / 60}시간` : m > 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`);
const seatLabel = (id) => (id ? id : '무관');

function saveSession(user) {
  try { user ? localStorage.setItem(SESSION_KEY, JSON.stringify(user)) : localStorage.removeItem(SESSION_KEY); } catch { /* noop */ }
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

let busy = false;
async function run(mutator) {
  if (busy) return; // 버튼 연타로 인한 중복 요청 방지
  busy = true;
  ui.error = '';
  try {
    await ui.store.transact((s) => mutator(s, Date.now()));
    ui.edit = null;
  } catch (e) {
    ui.error = e instanceof PoolError ? e.message : `처리 실패: ${e.message}`;
    if (!(e instanceof PoolError)) console.error(e);
  } finally {
    busy = false;
  }
  render();
}

// ---------- views ----------
function renderLogin(prefill = {}) {
  app.innerHTML = `
    <form class="login" id="login-form">
      <section>
        <h2>공용공간 예약 로그인</h2>
        ${ui.config.dummy ? '<p class="badge">더미 모드 (Firebase 미연결)</p>' : ''}
        <label>닉네임<input name="nickname" required autocomplete="nickname" value="${esc(prefill.nickname)}" /></label>
        <label>이메일<input name="email" type="email" required autocomplete="email" value="${esc(prefill.email)}" /></label>
        <div class="row"><button type="submit">로그인</button></div>
        <p class="error">${esc(ui.error)}</p>
      </section>
    </form>`;
  app.querySelector('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const user = matchMember(ui.config.members, fd.get('nickname'), fd.get('email'));
    if (!user) {
      ui.error = '등록된 닉네임/이메일과 일치하지 않습니다.';
      return renderLogin({ nickname: fd.get('nickname'), email: fd.get('email') });
    }
    ui.error = '';
    ui.user = user;
    saveSession(user);
    startPool();
  });
}

function durationOptions(selected, filter = () => true) {
  return DURATION_OPTIONS.filter(filter)
    .map((m) => `<option value="${m}" ${m === selected ? 'selected' : ''}>${durLabel(m)}</option>`).join('');
}
function seatOptions(selected, allowed = null) {
  return [`<option value="" ${!selected ? 'selected' : ''}>무관 (남는 자리 배정)</option>`]
    .concat(SEATS.map((s) => {
      const disabled = allowed && !allowed.includes(s.id);
      return `<option value="${s.id}" ${s.id === selected && !disabled ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${s.id} (모니터 ${s.monitorSide === 'left' ? '좌' : '우'})</option>`;
    }))
    .join('');
}

function renderMyPanel(state, mine, now) {
  if (!mine) {
    const ended = lastEnded(state, ui.user, now);
    if (ended) {
      // 재배정 신청: 바로 앉을 수 있는 빈 자리가 있을 때만 가능, 같은 자리는 텀 적용
      const free = freeSeatsFor(state, ui.user, now);
      const until = ended.endedAt + SAME_SEAT_COOLDOWN_MIN * 60000;
      return `
      <section>
        <h2>재배정 신청</h2>
        <p>${esc(ended.seatId)} 이용 종료 (${hhmm(ended.endedAt)})</p>
        <p class="muted">빈 자리가 있을 때만 재신청할 수 있습니다. 같은 자리(${esc(ended.seatId)})는 ${hhmm(until)} 이후 가능합니다.</p>
        <form id="register-form">
          <label>이용 시간<select name="duration">${durationOptions(60)}</select></label>
          <label>자리 지정<select name="seat">${seatOptions(free.includes(ui.selectedSeat) ? ui.selectedSeat : null, free)}</select></label>
          <div class="row"><button type="submit" ${free.length ? '' : 'disabled'}>재배정 신청</button></div>
          ${free.length ? '' : '<p class="muted">지금은 빈 자리가 없습니다.</p>'}
        </form>
        <p class="error">${esc(ui.error)}</p>
      </section>`;
    }
    return `
      <section>
        <h2>예약 등록</h2>
        <form id="register-form">
          <label>이용 시간<select name="duration">${durationOptions(60)}</select></label>
          <label>자리 지정<select name="seat">${seatOptions(ui.selectedSeat)}</select></label>
          <p class="muted">지정한 자리는 우선 배정되며, 사용 중이면 빌 때까지 대기합니다.</p>
          <div class="row"><button type="submit">등록</button></div>
        </form>
        <p class="error">${esc(ui.error)}</p>
      </section>`;
  }
  const e = mine.entry;
  const isActive = mine.status === 'active';
  const head = isActive
    ? `<p><b>${esc(e.seatId)}</b> 이용 중<br/>${hhmm(e.startAt)} ~ ${hhmm(e.endAt)} (${durLabel(e.durationMin)})</p>`
    : `<p><b>대기 ${mine.position}번째</b><br/>자리: ${esc(seatLabel(e.seatPref))} · ${durLabel(e.durationMin)}<br/>
       <span class="muted">예상 배정: ${hhmm(estimateWaitUntil(state, e))} 이후</span></p>`;
  // 이용 중이면 현재 자리 + 지금 빈 자리로만 이동 가능, 대기 중이면 아무 자리나 무관
  const movable = isActive ? [e.seatId, ...SEATS.map((d) => d.id).filter((id) => !state.seats[id])] : null;
  const editForm = !ui.edit ? '' : `
    <form id="change-form">
      <label>이용 시간<select name="duration">${durationOptions(ui.edit.durationMin, (m) => !isActive || e.startAt + m * 60000 > now)}</select></label>
      <label>${isActive ? '자리 이동' : '자리 지정'}<select name="seat">${isActive ? seatOptions(ui.edit.seat, movable).replace(/^<option value="" [^>]*>[^<]*<\/option>/, '') : seatOptions(ui.edit.seat)}</select></label>
      <p class="muted">좌석 배치도에서 자리를 눌러도 선택됩니다.${isActive ? ' 이용 중에는 비어 있는 자리로만 옮길 수 있습니다.' : ''}</p>
      <div class="row"><button type="submit">변경 저장</button><button type="button" id="edit-cancel">닫기</button></div>
      <div class="row"><button type="button" id="cancel-btn">${isActive ? '반납' : '대기 취소'}</button></div>
    </form>`;
  return `
    <section>
      <h2>내 예약</h2>
      ${head}
      ${editForm}
      ${ui.edit ? '' : `<div class="row"><button id="edit-btn">변경</button><button id="cancel-btn">${isActive ? '반납' : '대기 취소'}</button></div>`}
      <p class="error">${esc(ui.error)}</p>
    </section>`;
}

function renderRoom(state, now) {
  const lines = Array.from({ length: LINE_COUNT }, (_, i) => SEATS.filter((s) => s.line === i + 1));
  return `
    <section>
      <h2>좌석 현황</h2>
      <div class="room">
        ${lines.map((desks, i) => `
          <div class="line">
            <div class="line-title">${i + 1}라인</div>
            ${desks.map((d) => {
              const a = state.seats[d.id];
              const mine = a && a.email === ui.user.email;
              const picked = ui.edit ? ui.edit.seat === d.id : ui.selectedSeat === d.id;
              const cls = ['desk', a ? 'busy' : '', mine ? 'mine' : '', picked ? 'selected' : ''].join(' ');
              return `<div class="${cls}" data-seat="${d.id}" title="클릭해서 자리 선택">
                <span class="monitor ${d.monitorSide}"></span>
                <div class="seat-id">${d.id}</div>
                ${a ? `<div>${esc(a.nickname)}</div><div class="muted">~ ${hhmm(a.endAt)}</div>`
                    : inCooldown(state, ui.user, d.id, now) ? '<div class="muted">비어 있음<br/>(내 재배정 텀)</div>' : '<div class="muted">비어 있음</div>'}
              </div>`;
            }).join('')}
          </div>`).join('')}
      </div>
    </section>`;
}

function renderWaitlist(state) {
  return `
    <section>
      <h2>대기 목록 (${state.queue.length})</h2>
      ${state.queue.length === 0 ? '<p class="muted">대기자가 없습니다.</p>' : `
      <ol class="waitlist">
        ${state.queue.map((w, i) => `
          <li class="${w.email === ui.user.email ? 'mine' : ''}">
            ${i + 1}. <b>${esc(w.nickname)}</b> · 자리 ${esc(seatLabel(w.seatPref))} · ${durLabel(w.durationMin)}
          </li>`).join('')}
      </ol>`}
    </section>`;
}

function renderPool() {
  const now = Date.now();
  const state = reconcile(ui.raw, now); // 화면은 항상 현재 시각 기준으로 계산
  const mine = findMine(state, ui.user);
  app.innerHTML = `
    <header>
      <h1 style="font-size:20px;margin:0">공용공간 예약</h1>
      <div>
        ${ui.config.dummy ? '<span class="badge">더미 모드</span>' : ''}
        ${ui.config.dummy
          ? `<select id="user-switch" title="더미 모드 전용: 사용자 전환">${ui.config.members.map((m) => `<option value="${esc(m.email)}" ${m.email.trim().toLowerCase() === ui.user.email ? 'selected' : ''}>${esc(m.nickname)} (${esc(m.email)})</option>`).join('')}</select>`
          : `<b>${esc(ui.user.nickname)}</b> <span class="muted">${esc(ui.user.email)}</span>`}
        <button id="logout-btn">로그아웃</button>
        ${ui.config.dummy ? '<button id="reset-btn">더미 데이터 초기화</button>' : ''}
      </div>
    </header>
    <div class="layout">
      <div>${renderMyPanel(state, mine, now)}</div>
      <div>${renderRoom(state, now)}</div>
      <div>${renderWaitlist(state)}</div>
    </div>`;
  bindPool(mine);
}

function bindPool(mine) {
  const $ = (sel) => app.querySelector(sel);
  $('#logout-btn').onclick = () => { saveSession(null); ui.user = null; stopPool(); renderLogin(); };
  $('#reset-btn') && ($('#reset-btn').onclick = () => ui.store.reset());
  $('#user-switch')?.addEventListener('change', (e) => {
    const m = ui.config.members.find((x) => x.email === e.target.value);
    ui.user = matchMember(ui.config.members, m.nickname, m.email);
    saveSession(ui.user);
    Object.assign(ui, { edit: null, selectedSeat: null, error: '' });
    render();
  });
  app.querySelectorAll('.desk').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.seat;
      if (ui.edit) {
        // 변경 모드: 이동/지정할 자리 선택 (다시 누르면 선택 해제 → 대기 중이면 무관, 이용 중이면 현재 자리)
        const isActive = mine?.status === 'active';
        if (isActive && ui.raw && reconcile(ui.raw, Date.now()).seats[id] && id !== mine.entry.seatId) {
          ui.error = '이용 중에는 비어 있는 자리로만 옮길 수 있습니다.';
        } else {
          ui.error = '';
          ui.edit.seat = ui.edit.seat === id ? (isActive ? mine.entry.seatId : null) : id;
        }
      } else {
        ui.selectedSeat = ui.selectedSeat === id ? null : id;
      }
      render();
    };
  });
  $('#register-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const request = { durationMin: Number(fd.get('duration')), seatPref: fd.get('seat') || null };
    ui.selectedSeat = null;
    run((s, now) => register(s, ui.user, request, now));
  });
  if (!mine) return;
  const id = mine.entry.id;
  $('#cancel-btn') && ($('#cancel-btn').onclick = () => {
    if (confirm('예약을 취소(반납)할까요?')) run((s, now) => cancel(s, ui.user, id, now));
  });
  $('#edit-btn') && ($('#edit-btn').onclick = () => {
    const e = mine.entry;
    ui.edit = { durationMin: e.durationMin, seat: mine.status === 'active' ? e.seatId : e.seatPref };
    ui.error = '';
    render();
  });
  $('#edit-cancel') && ($('#edit-cancel').onclick = () => { ui.edit = null; ui.error = ''; render(); });
  const form = $('#change-form');
  if (form) {
    form.duration.onchange = () => { ui.edit.durationMin = Number(form.duration.value); };
    form.seat.onchange = () => { ui.edit.seat = form.seat.value || null; render(); };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const request = { durationMin: ui.edit.durationMin, seatPref: ui.edit.seat ?? null };
      run((s, now) => change(s, ui.user, id, request, now));
    });
  }
}

function render() {
  if (!ui.user) return renderLogin();
  if (!ui.raw) { app.textContent = '예약 현황 불러오는 중…'; return; }
  // 편집 중에는 폼 입력이 날아가지 않도록 주기적 재렌더를 건너뜀
  renderPool();
}

// ---------- lifecycle ----------
let unsubscribe = null;
let timer = null;

function startPool() {
  render();
  unsubscribe = ui.store.subscribe(
    (data) => { ui.raw = data; if (!ui.edit) render(); },
    (err) => { ui.error = `실시간 연결 오류: ${err.message}`; render(); },
  );
  const tick = () => {
    // 만료 정리 + 대기자 배정을 저장소에 반영 (변경이 있을 때만 쓰기)
    ui.store.transact((s) => reconcile(s, Date.now())).catch((e) => console.warn('reconcile 실패', e));
    if (!ui.edit) render();
  };
  tick();
  timer = setInterval(tick, TICK_MS);
}
function stopPool() {
  unsubscribe?.();
  clearInterval(timer);
  unsubscribe = null;
  ui.raw = null;
}

(async function boot() {
  try {
    ui.config = await loadConfig();
  } catch (e) {
    app.textContent = `설정 파일 오류: ${e.message}`;
    return;
  }
  ui.store = await createStore(ui.config);
  const saved = loadSession();
  ui.user = saved ? matchMember(ui.config.members, saved.nickname, saved.email) : null;
  if (ui.user) startPool(); else renderLogin();
})();
