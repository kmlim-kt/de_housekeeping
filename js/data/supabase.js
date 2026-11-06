// =====================================================================
// Supabase 클라이언트 (앱 전체에서 이 인스턴스 하나만 사용)
// 로그인 상태는 기기(localStorage)에 저장되어 다시 열어도 유지됩니다.
// =====================================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,      // 로그인 유지
    autoRefreshToken: true,    // 토큰 자동 갱신
    detectSessionInUrl: true,  // 가입 확인·비밀번호 재설정 메일 링크 처리
  },
});

/** 이 앱이 열린 주소 (메일 링크가 돌아올 곳) */
export function appUrl() {
  return location.origin + location.pathname;
}
