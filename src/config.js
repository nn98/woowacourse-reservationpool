// 실행 시점에 public/config/*.json 을 읽는다 → 실제값은 빌드 없이 파일만 교체하면 됨
const base = import.meta.env.BASE_URL;

async function loadJson(path) {
  const res = await fetch(`${base}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} 를 불러오지 못했습니다 (${res.status})`);
  return res.json();
}

export async function loadConfig() {
  const [firebase, members] = await Promise.all([
    loadJson('config/firebase-config.json'),
    loadJson('config/members.json'),
  ]);
  const dummy = !firebase.apiKey || String(firebase.apiKey).startsWith('DUMMY');
  return { firebase, members: members.members ?? members, dummy };
}
