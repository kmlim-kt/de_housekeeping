// =====================================================================
// 계정과목 화면 — 1단계: 불러와서 분류별 2단계 트리로 보여 주기
//   추가·이름 변경·숨김은 2단계(개시 잔액 마법사와 함께)에서 추가합니다.
// =====================================================================

import { h, append } from '../dom.js';
import { state } from '../state.js';
import { buildAccountTree, ACCOUNT_TYPES, TYPE_LABELS, SUBTYPE_LABELS, isDebitNormal } from '../../core/balance.js';

export function render(view) {
  const tree = buildAccountTree(state.accounts);
  append(view,
    h('div', { class: 'row' },
      h('a', { href: '#/settings', class: 'btn small ghost' }, '‹ 설정'),
      h('h1', { class: 'view-title' }, '계정과목')),
    h('p', { class: 'muted small' }, `모두 ${state.accounts.length}개. 계정 추가·수정·숨김은 2단계에서 제공합니다.`),
    h('div', { class: 'stack' }, ACCOUNT_TYPES.map((type) =>
      h('section', { class: 'card acc-group' },
        h('div', { class: 'row between' },
          h('h3', {}, TYPE_LABELS[type]),
          h('span', { class: 'small muted' }, isDebitNormal(type) ? '차변(+) 계정' : '대변(+) 계정')),
        h('ul', { class: 'list' }, tree[type].flatMap((acc) => [
          item(acc, false),
          ...acc.children.map((c) => item(c, true)),
        ]))))));
}

function item(acc, isChild) {
  return h('li', { class: 'acc-item' + (isChild ? ' child' : '') },
    h('span', { class: 'name' }, acc.name),
    acc.children?.length ? h('span', { class: 'badge' }, '상위') : null,
    acc.subtype && !isChild && SUBTYPE_LABELS[acc.subtype] !== acc.name
      ? h('span', { class: 'badge' }, SUBTYPE_LABELS[acc.subtype] ?? acc.subtype) : null,
    acc.is_system ? h('span', { class: 'badge' }, '기본') : null,
    acc.is_hidden ? h('span', { class: 'badge bad' }, '숨김') : null);
}
