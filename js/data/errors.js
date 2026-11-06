// =====================================================================
// 오류 메시지를 사용자에게 보여 줄 한국어 문장으로 바꿉니다.
// DB 함수(RPC)가 내는 오류는 이미 한국어라서 그대로 씁니다.
// =====================================================================

const AUTH_MESSAGES = [
  [/invalid login credentials/i, '이메일 또는 비밀번호가 올바르지 않습니다.'],
  [/email not confirmed/i, '이메일 인증이 아직 안 되었습니다. 받은 메일함(스팸함 포함)의 확인 링크를 눌러 주세요.'],
  [/user already registered/i, '이미 가입된 이메일입니다. 로그인하거나 비밀번호 찾기를 이용하세요.'],
  [/password should be at least (\d+)/i, (m) => `비밀번호는 ${m[1]}자 이상이어야 합니다.`],
  [/weak.?password|password is too weak/i, '비밀번호가 너무 쉽습니다. 더 길고 복잡하게 만들어 주세요.'],
  [/rate limit|too many requests|over_email_send_rate_limit/i, '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요. (메일 발송은 시간당 몇 통으로 제한됩니다)'],
  [/unable to validate email|invalid.*email/i, '이메일 주소 형식이 올바르지 않습니다.'],
  [/new password should be different/i, '새 비밀번호는 이전 비밀번호와 달라야 합니다.'],
  [/jwt expired|invalid jwt|refresh token/i, '로그인이 만료되었습니다. 다시 로그인하세요.'],
  [/signups not allowed/i, '현재 새 가입이 막혀 있습니다. 관리자에게 문의하세요.'],
];

/**
 * @param {unknown} error supabase-js 오류 객체 또는 Error
 * @returns {string}
 */
export function toKoreanMessage(error) {
  if (!error) return '알 수 없는 오류가 발생했습니다.';
  const msg = String(error.message ?? error);

  // 네트워크 끊김 (fetch 실패)
  if (!navigator.onLine || /failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return '인터넷에 연결되어 있지 않아 서버에 저장하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.';
  }

  for (const [pattern, text] of AUTH_MESSAGES) {
    const m = msg.match(pattern);
    if (m) return typeof text === 'function' ? text(m) : text;
  }

  // PostgreSQL·PostgREST 오류 코드
  switch (error.code) {
    case '42501': return /[가-힣]/.test(msg) ? msg : '이 작업을 할 권한이 없습니다.';
    case '28000': return '로그인이 필요합니다.';
    case '23505': return /[가-힣]/.test(msg) ? msg : '이미 같은 항목이 있습니다.';
    case '23503': return '다른 데이터가 사용 중이라 처리할 수 없습니다.';
    case 'PGRST301': return '로그인이 만료되었습니다. 다시 로그인하세요.';
    case 'PGRST202': return '서버 기능을 찾을 수 없습니다. schema.sql이 최신인지 확인하세요.';
    default: break;
  }

  // DB에서 보낸 한국어 메시지는 그대로
  if (/[가-힣]/.test(msg)) return msg;
  return `처리 중 오류가 발생했습니다. (${msg})`;
}
