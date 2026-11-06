// =====================================================================
// 계정과목 관리: 분류별 2단계 트리 + 추가·이름 변경·숨김·삭제
//   - 하위 계정은 상위 계정 아래에만 (2단계까지)
//   - 거래가 있는 계정·기본 계정은 삭제할 수 없고 숨김만 가능 (DB가 검사하고 이유를 알려 줌)
//   - 하위 계정을 만들면 상위 계정에는 더 이상 직접 기록할 수 없습니다
// =====================================================================

import { h, append, replace, toast, withBusy } from '../dom.js';
import { state } from '../state.js';
import { buildAccountTree, ACCOUNT_TYPES, TYPE_LABELS, SUBTYPE_LABELS, isDebitNormal } from '../../core/balance.js';
import { createAccount, updateAccount, deleteAccount } from '../../data/api.js';

// 최상위 계정을 만들 때 고를 수 있는 세부 분류
const SUBTYPES_BY_TYPE = {
  asset: ['cash', 'bank', 'savings', 'investment', 'receivable'],
  liability: ['card', 'loan', 'payable'],
};

let openEditor = null;   // 펼쳐 둔 편집기 (계정 id 또는 'new:분류' 또는 'child:상위id')

export function render(view, ctx) {
  const tree = buildAccountTree(state.accounts);

  /** 변경 후 계정 목록 다시 불러와 화면 갱신 */
  async function apply(button, label, fn, doneMessage) {
    await withBusy(button, label, async () => {
      try {
        await fn();
        await ctx.reloadAccounts();
        openEditor = null;
        toast(doneMessage);
        ctx.refresh();
      } catch (err) {
        toast(err.message, { type: 'error', duration: 6000 });
      }
    });
  }

  append(view,
    h('div', { class: 'row' },
      h('a', { href: '#/settings', class: 'btn small ghost' }, '‹ 설정'),
      h('h1', { class: 'view-title' }, '계정과목')),
    h('p', { class: 'muted small' },
      `모두 ${state.accounts.length}개. 계정을 누르면 이름 변경·숨김·하위 계정 추가를 할 수 있습니다. 숨긴 계정은 입력 화면에 나오지 않지만 장부·보고서에는 그대로 남습니다.`),
    h('div', { class: 'stack' }, ACCOUNT_TYPES.map((type) =>
      h('section', { class: 'card acc-group' },
        h('div', { class: 'row between' },
          h('h3', {}, TYPE_LABELS[type]),
          h('span', { class: 'small muted' }, isDebitNormal(type) ? '차변(+) 계정' : '대변(+) 계정')),
        h('ul', { class: 'list' }, tree[type].flatMap((acc) => [
          item(acc, false),
          ...acc.children.map((c) => item(c, true)),
        ])),
        openEditor === 'new:' + type
          ? newAccountForm(type, null)
          : h('button', { class: 'btn small ghost', type: 'button',
              onClick: () => { openEditor = 'new:' + type; ctx.refresh(); } }, `+ ${TYPE_LABELS[type]} 계정 추가`)))));

  // =================================================================

  function item(acc, isChild) {
    const li = h('li', {},
      h('button', {
        type: 'button',
        class: 'acc-item' + (isChild ? ' child' : '') + (acc.is_hidden ? ' is-hidden' : ''),
        style: 'width:100%;border:0;background:none;text-align:left;cursor:pointer;padding:0',
        'aria-expanded': String(openEditor === acc.id),
        onClick: () => { openEditor = openEditor === acc.id ? null : acc.id; ctx.refresh(); },
      },
      h('span', { class: 'name' }, acc.name),
      acc.children?.length ? h('span', { class: 'badge' }, '상위') : null,
      acc.subtype && !isChild && SUBTYPE_LABELS[acc.subtype] !== acc.name
        ? h('span', { class: 'badge' }, SUBTYPE_LABELS[acc.subtype] ?? acc.subtype) : null,
      acc.is_system ? h('span', { class: 'badge' }, '기본') : null,
      acc.is_hidden ? h('span', { class: 'badge bad' }, '숨김') : null));
    if (openEditor === acc.id) li.append(editor(acc, isChild));
    if (openEditor === 'child:' + acc.id) li.append(newAccountForm(acc.type, acc));
    return li;
  }

  /** 계정 편집: 이름, 숨김, 하위 계정 추가, 삭제 */
  function editor(acc, isChild) {
    const name = h('input', { type: 'text', maxlength: '30', value: acc.name, 'aria-label': '계정 이름' });
    const saveBtn = h('button', { class: 'btn small primary', type: 'submit' }, '이름 저장');
    const hideBtn = h('button', { class: 'btn small', type: 'button' }, acc.is_hidden ? '다시 보이기' : '숨기기');
    const delBtn = h('button', { class: 'btn small danger', type: 'button' }, '삭제');
    const childBtn = !isChild
      ? h('button', { class: 'btn small', type: 'button',
          onClick: () => { openEditor = 'child:' + acc.id; ctx.refresh(); } }, '+ 하위 계정')
      : null;

    const f = h('form', { class: 'acc-editor' },
      h('label', { class: 'field' }, h('span', {}, '이름'), name),
      h('div', { class: 'row' }, saveBtn, hideBtn, childBtn, acc.is_system ? null : delBtn),
      !isChild && !acc.children?.length
        ? h('p', { class: 'small muted' }, '하위 계정을 만들면 이 계정에는 직접 기록할 수 없고, 하위 계정의 합계로 보입니다.') : null);

    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!name.value.trim()) return name.focus();
      apply(saveBtn, '저장 중…', () => updateAccount(acc.id, { name: name.value }), '이름을 바꿨습니다.');
    });
    hideBtn.addEventListener('click', () =>
      apply(hideBtn, '처리 중…', () => updateAccount(acc.id, { isHidden: !acc.is_hidden }),
        acc.is_hidden ? '다시 보이게 했습니다.' : '숨겼습니다. 입력 화면에 나오지 않습니다.'));
    delBtn.addEventListener('click', () => {
      if (!confirm(`"${acc.name}" 계정을 삭제할까요? (거래가 있으면 삭제되지 않습니다)`)) return;
      apply(delBtn, '삭제 중…', () => deleteAccount(acc.id), '삭제했습니다.');
    });
    requestAnimationFrame(() => name.focus());
    return f;
  }

  /** 새 계정: 최상위(분류 선택) 또는 하위(상위 계정 지정) */
  function newAccountForm(type, parent) {
    const name = h('input', { type: 'text', maxlength: '30', 'aria-label': '새 계정 이름',
      placeholder: parent ? `${parent.name} 아래에 만들 이름` : '계정 이름' });
    const subtypes = !parent ? SUBTYPES_BY_TYPE[type] : null;
    const subtype = subtypes
      ? h('select', { 'aria-label': '세부 분류' },
          h('option', { value: '' }, '세부 분류 (선택)'),
          subtypes.map((s) => h('option', { value: s }, SUBTYPE_LABELS[s])))
      : null;
    const addBtn = h('button', { class: 'btn small primary', type: 'submit' }, '추가');
    const cancel = h('button', { class: 'btn small ghost', type: 'button',
      onClick: () => { openEditor = null; ctx.refresh(); } }, '취소');

    const f = h('form', { class: 'acc-editor' },
      h('label', { class: 'field' }, h('span', {}, parent ? `${parent.name} > 새 하위 계정` : `새 ${TYPE_LABELS[type]} 계정`), name),
      subtype ? h('label', { class: 'field' }, h('span', {}, '세부 분류 — 간편 입력에서 어느 칸에 보일지 정합니다'), subtype) : null,
      h('div', { class: 'row' }, addBtn, cancel));

    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!name.value.trim()) return name.focus();
      // 정렬: 상위 계정 바로 뒤, 최상위는 같은 분류의 마지막 뒤
      const siblings = state.accounts.filter((a) => a.type === type);
      const sortOrder = parent
        ? Math.max(parent.sort_order, ...state.accounts.filter((a) => a.parent_id === parent.id).map((a) => a.sort_order)) + 1
        : Math.max(0, ...siblings.map((a) => a.sort_order)) + 10;
      apply(addBtn, '추가 중…', () => createAccount({
        ledgerId: state.ledgerId, name: name.value, type,
        subtype: subtype?.value || null, parentId: parent?.id ?? null, sortOrder,
      }), `"${name.value.trim()}" 계정을 추가했습니다.`);
    });
    requestAnimationFrame(() => name.focus());
    return f;
  }
}
