# woowacourse-reservationpool

공용공간(책상 12석) 자동 배정 예약 시스템. Vite + 바닐라 JS + Firebase(Firestore).

> 현재 단계: **구조와 기능 우선**. 디자인/스타일은 추후 다듬을 예정입니다.

## 빠른 시작

```bash
npm install
npm run dev      # http://localhost:5173 (기본값은 더미 모드, Firebase 없이 동작)
npm test         # 배정 로직 / 로그인 단위 테스트
npm run build    # dist/ 생성
```

더미 모드에서는 상태가 브라우저 `localStorage` 에 저장되고 같은 브라우저의 탭끼리 실시간 동기화됩니다.
상단의 **더미 데이터 초기화** 버튼으로 비울 수 있습니다.
더미 계정: `글렌 / 1234`, `테스트1 / test1@example.com` ~ `테스트4 / test4@example.com`

---

## 실제값 붙여넣기 가이드 ⭐

실제값은 **아래 두 정적 파일만 교체**하면 됩니다. 실행할 때 `fetch` 로 읽기 때문에 코드 수정이 필요 없고,
배포본(`dist/config/`)에서 직접 교체하면 다시 빌드할 필요도 없습니다.

| 파일 | 용도 |
| --- | --- |
| `public/config/firebase-config.json` | Firebase 웹 앱 설정 |
| `public/config/members.json` | 로그인 허용 명단 (닉네임 + 이메일) |

### 1. `public/config/firebase-config.json`

Firebase 콘솔 → 프로젝트 설정 → 일반 → 내 앱(웹) → **SDK 설정 및 구성** 의 `firebaseConfig` 값을 그대로 JSON 으로 붙여넣습니다.

```json
{
  "apiKey": "AIza...",
  "authDomain": "your-project.firebaseapp.com",
  "projectId": "your-project",
  "storageBucket": "your-project.appspot.com",
  "messagingSenderId": "123456789012",
  "appId": "1:123456789012:web:abcdef123456"
}
```

- `apiKey` 가 `DUMMY` 로 시작하거나 비어 있으면 **더미 모드**(localStorage)로 동작합니다.
- 실제 키를 넣으면 자동으로 Firestore 모드로 전환됩니다.
- Firebase 웹 설정값은 원래 클라이언트에 공개되는 값이라 비밀값은 아닙니다. 접근 제어는 Firestore 규칙으로 합니다.

### 2. `public/config/members.json`

```json
{
  "members": [
    { "nickname": "네오", "email": "neo@example.com" },
    { "nickname": "브라운", "email": "brown@example.com" }
  ]
}
```

- 로그인은 **단순 일치 비교**입니다. 입력한 닉네임과 이메일이 같은 항목에 둘 다 있으면 통과합니다.
  - 닉네임: 앞뒤 공백만 무시하고 정확히 일치해야 함
  - 이메일: 앞뒤 공백과 대소문자 무시 (형식 검사는 하지 않음. 테스트용으로 `1234` 같은 값도 가능)
- 이메일은 사용자를 구분하는 키입니다(한 사람당 예약 1건). 명단 안에서 중복되지 않게 해 주세요.

### 3. Firestore 준비

1. Firebase 콘솔에서 Firestore Database 를 생성합니다.
2. `firestore.rules` 를 배포합니다: `npx firebase-tools deploy --only firestore:rules`
3. 상태 문서 `reservationPool/current` 는 첫 등록 때 자동으로 생성됩니다.

### 4. 배포 (Firebase Hosting)

```bash
npm run build
npx firebase-tools login
npx firebase-tools use --add          # 프로젝트 선택
npx firebase-tools deploy --only hosting
```

`firebase.json` 이 `/config/**` 에 `Cache-Control: no-store` 를 걸어 두어서, 설정 파일을 바꾸면 바로 반영됩니다.

> ⚠️ **보안 주의**: 단순 일치 로그인은 클라이언트에서만 비교합니다. 명단 파일은 누구나 볼 수 있고,
> Firestore 규칙도 상태 문서 하나만 읽기/쓰기를 열어 둔 상태입니다. 내부용으로만 쓰고,
> 필요해지면 Firebase Auth(이메일 링크 등)로 교체하는 것을 권장합니다.

---

## 기능 명세

### 좌석 배치
- 수직으로 정렬된 책상 4라인 × 라인당 3개 = **12석** (`L{라인}-{순번}`, 예: `L2-3`)
- 모니터 위치는 제일 좌측 라인부터 **우 / 좌 / 우 / 좌**
- 정의 위치: `src/core/layout.js`

### 예약 (자동 배정)
- 로그인한 사용자가 **이용 시간(30분 단위, 최대 2시간)** 과 **자리 지정(특정 자리 또는 무관)** 을 고르고 **등록**만 누르면 됩니다.
- 빈 자리가 있으면 **즉시 배정**되고, 이용 시간은 배정된 시각부터 시작됩니다.
- 자리 없음 → **대기 목록**에 들어가며, 자리가 비면 자동으로 배정됩니다.
  - **자리 지정**: 해당 자리에만 우선 배정. 다른 자리가 비어도 그 자리가 빌 때까지 대기
  - **무관**: 남는 자리 중 앞 번호부터 배정
  - 자리가 비면 그 자리를 **지정한 대기자가 먼저**, 없으면 무관 대기자 중 먼저 등록한 사람이 받음
- 한 사람당 이용 중이거나 대기 중인 예약은 1건만 가능
- **중복 배정 방지**: 모든 변경은 Firestore 트랜잭션 안에서 처리하므로, 동시에 등록해도 같은 자리는 한 명만 받고 같은 사람은 한 자리만 받습니다.
  배정 단계에서도 이미 자리가 있는 사람은 다시 배정하지 않습니다. 화면에서도 버튼을 연타한 요청은 무시합니다.

### 재배정 신청 / 같은 자리 텀
- 이용이 끝나거나(만료·반납) 나면 **재배정 신청** 패널이 나타납니다.
- 종료 후 텀(`SAME_SEAT_COOLDOWN_MIN`, 현재 **5분**) 동안의 규칙:
  - **바로 앉을 수 있는 빈 자리가 있을 때만** 재신청할 수 있습니다. 대기자가 있는데 다시 줄을 서서 자리를 이어 쓰는 것을 막기 위함입니다.
  - **같은 자리**는 배정되지 않습니다. 좌석에 `(내 재배정 텀)` 이 표시되고, 선택 목록에서도 비활성화됩니다.
- 텀이 지나면 일반 등록과 같습니다(대기열 진입 가능).
- 텀 값은 `src/core/pool.js` 의 `SAME_SEAT_COOLDOWN_MIN` 에서 바꿀 수 있습니다.
- 좌석을 클릭하면 등록 폼의 자리 지정에 반영됩니다.

### 대기 목록
- 오른쪽 패널에 순번, 닉네임, 자리 지정 정보(자리 번호 또는 무관), 이용 시간을 표시합니다.

### 본인 예약 취소 / 변경
| 상태 | 취소 | 변경 |
| --- | --- | --- |
| 대기 중 | 대기 취소 | 이용 시간과 자리 지정 (대기 순번 유지) |
| 이용 중 | 반납 (즉시 다음 대기자 배정) | 이용 시간만 (시작 시각 기준 최대 2시간, 이미 지난 시간으로 줄이기 불가) |

## 구조

```
public/config/            ← 실제값 교체 파일 (firebase-config.json, members.json)
src/
  core/layout.js          좌석 배치 정의
  core/pool.js            배정 로직 (순수 함수: register / cancel / change / reconcile)
  core/auth.js            단순 일치 로그인
  store/localStore.js     더미 모드 저장소 (localStorage + BroadcastChannel)
  store/firestoreStore.js 실제 저장소 (Firestore 문서 1개 + 트랜잭션)
  config.js               설정 파일 로더
  main.js                 화면 (로그인 / 좌석 현황 / 대기 목록 / 내 예약)
test/pool.test.js         단위 테스트
firebase.json, firestore.rules
```

### 동작 방식 (서버 없음)
- 전체 상태를 Firestore 문서 하나(`reservationPool/current`)에 저장합니다: `{ seats: {L1-1: 예약|null, ...}, queue: [...], seq, recent: [최근 종료 기록] }`
- 모든 변경은 트랜잭션 안에서 순수 함수 `pool.js` 로 계산하므로 동시 등록에도 안전합니다.
- 접속 중인 클라이언트가 15초마다 `reconcile`(만료 정리 + 대기자 배정)을 실행하고, 실제로 바뀐 내용이 있을 때만 저장합니다.
  화면은 항상 현재 시각 기준으로 다시 계산해서 보여 줍니다. 접속자가 아무도 없어도 다음 접속 때 정확히 따라잡습니다.
  다만 배정 시작 시각은 그 정리가 실행된 시각으로 기록됩니다.
