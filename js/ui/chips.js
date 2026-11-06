// =====================================================================
// 선택 버튼 묶음(칩): 계정을 한 번 터치로 고르기
// 처음에는 limit개만 보이고 [더보기]로 전체를 펼칩니다.
// =====================================================================

import { h, replace } from './dom.js';

/**
 * @param {{ label: string, options: Array<{id: string, label: string, title?: string}>,
 *           selected?: string, limit?: number, onSelect: (id: string) => void }} opts
 * @returns {HTMLElement & { setSelected: (id: string) => void }}
 */
export function chipGroup({ label, options, selected = '', limit = 8, onSelect }) {
  let expanded = false;
  let current = selected;
  const list = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': label });
  const box = h('div', { class: 'stack chip-field' }, h('div', { class: 'chip-label' }, label), list);

  function draw() {
    // 선택된 항목이 접힌 부분에 있으면 펼침
    const idx = options.findIndex((o) => o.id === current);
    const showAll = expanded || options.length <= limit + 1 || idx >= limit;
    const visible = showAll ? options : options.slice(0, limit);
    replace(list,
      visible.map((o) => h('button', {
        type: 'button',
        class: 'chip',
        role: 'radio',
        'aria-checked': String(o.id === current),
        title: o.title ?? o.label,
        onClick: () => { current = o.id; draw(); onSelect(o.id); },
      }, o.label)),
      !showAll ? h('button', { type: 'button', class: 'chip more', onClick: () => { expanded = true; draw(); } },
        `더보기 (${options.length - limit})`) : null,
      options.length === 0 ? h('span', { class: 'small muted' }, '고를 수 있는 계정이 없습니다. 설정 → 계정과목에서 추가하세요.') : null);
  }

  box.setSelected = (id) => { current = id; draw(); };
  draw();
  return box;
}
