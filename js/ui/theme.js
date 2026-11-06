// =====================================================================
// 테마: auto(기기 설정 따름) | light | dark
// =====================================================================

import { prefs } from './state.js';

export const THEME_LABELS = { auto: '자동', light: '라이트', dark: '다크' };

export function currentTheme() {
  return prefs.get('theme', 'auto');
}

export function applyTheme(theme = currentTheme()) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  prefs.set('theme', theme);
}
