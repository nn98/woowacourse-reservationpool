// 단순 일치 비교 로그인: members.json 의 (닉네임, 이메일) 쌍과 정확히 일치해야 통과
// 이메일은 대소문자/앞뒤 공백 무시, 닉네임은 앞뒤 공백만 무시
export function matchMember(members, nickname, email) {
  const n = String(nickname ?? '').trim();
  const e = String(email ?? '').trim().toLowerCase();
  if (!n || !e) return null;
  const found = (members || []).find(
    (m) => String(m.nickname).trim() === n && String(m.email).trim().toLowerCase() === e,
  );
  return found ? { nickname: found.nickname.trim(), email: found.email.trim().toLowerCase() } : null;
}
