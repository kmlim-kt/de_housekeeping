// =====================================================================
// 앱 상태 (로그인 사용자, 현재 장부, 계정과목) + 기기별 설정 저장
// =====================================================================

export const state = {
  user: null,        // 로그인한 사용자
  ledgers: [],       // 내가 속한 장부 [{id, name, role}]
  ledgerId: null,    // 현재 장부
  accounts: [],      // 현재 장부의 계정과목
  online: navigator.onLine,
};

const listeners = new Set();

/** 상태 일부를 바꾸고 구독자에게 알림 */
export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

/** 상태 변화 구독. 해제 함수를 돌려줌 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 현재 장부 정보 */
export function currentLedger() {
  return state.ledgers.find((l) => l.id === state.ledgerId) ?? null;
}

// 기기별 설정 (테마, 마지막 장부 등). 저장소를 쓸 수 없는 환경에서도 앱은 동작해야 함
export const prefs = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem('dh.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('dh.' + key, JSON.stringify(value));
    } catch {
      /* 저장 불가(사생활 보호 모드 등) — 무시 */
    }
  },
};
