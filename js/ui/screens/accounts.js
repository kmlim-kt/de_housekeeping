// =====================================================================
// 계정과목 관리: 분류별 2단계 트리 + 추가·이름 변경·숨김·삭제
//   - 하위 계정은 상위 계정 아래에만 (2단계까지)
//   - 거래가 있는 계정·기본 계정은 삭제할 수 없고 숨김만 가능 (DB가 검사하고 이유를 알려 줌)
//   - 하위 계정을 만들면 상위 계정에는 더 이상 직접 기록할 수 없습니다
// =====================================================================

import { h, append, replace, toast, withBusy } from '../dom.js';
import { state, setState, prefs } from '../state.js';
import { buildAccountTree, moveAccountTo, ACCOUNT_TYPES, TYPE_LABELS, SUBTYPE_LABELS, isDebitNormal } from '../../core/balance.js';
import { createAccount, updateAccount, deleteAccount } from '../../data/api.js';

// 최상위 계정을 만들 때 고를 수 있는 세부 분류
const SUBTYPES_BY_TYPE = {
  asset: ['cash', 'bank', 'savings', 'investment', 'receivable'],
  liability: ['card', 'loan', 'payable'],
};

let openEditor = null;   // 펼쳐 둔 편집기 (계정 id 또는 'new:분류' 또는 'child:상위id')
let focusAfter = null;   // 다시 그린 뒤 초점을 줄 순서 버튼 ('계정id:방향')
let saving = Promise.resolve();   // 순서 저장을 차례대로 보내기 위한 줄

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

  // 하위 계정 목록을 펼쳐 둔 상위 계정 (이 기기에 기억)
  const openKey = 'accOpen.' + state.ledgerId;
  const opened = new Set(prefs.get(openKey, []));
  const parentsWithKids = ACCOUNT_TYPES.flatMap((t) => tree[t].filter((a) => a.children.length));
  const saveOpened = () => { prefs.set(openKey, [...opened]); ctx.refresh(); };

  append(view,
    h('div', { class: 'row' },
      h('a', { href: '#/settings', class: 'btn small ghost' }, '‹ 설정'),
      h('h1', { class: 'view-title' }, '계정과목')),
    h('p', { class: 'muted small' },
      `모두 ${state.accounts.length}개. 계정 이름을 누르면 이름 변경·숨김·하위 계정 추가를 할 수 있고, 오른쪽 ⠿ 손잡이를 끌어 순서를 바꿉니다(상위를 옮기면 하위도 함께). 정한 순서는 예산·보고서·입력 화면의 계정 목록에 그대로 쓰입니다. 숨긴 계정은 입력 화면에 나오지 않지만 장부·보고서에는 그대로 남습니다.`),
    parentsWithKids.length
      ? h('div', { class: 'row acc-toolbar' },
          h('button', { class: 'btn small', type: 'button',
            onClick: () => { parentsWithKids.forEach((a) => opened.add(a.id)); saveOpened(); } }, '하위 모두 펼치기'),
          h('button', { class: 'btn small', type: 'button',
            onClick: () => { opened.clear(); saveOpened(); } }, '하위 모두 접기'))
      : null,
    h('div', { class: 'stack' }, ACCOUNT_TYPES.map((type) =>
      h('section', { class: 'card acc-group' },
        h('div', { class: 'row between' },
          h('h3', {}, TYPE_LABELS[type]),
          h('span', { class: 'small muted' }, isDebitNormal(type) ? '차변(+) 계정' : '대변(+) 계정')),
        h('ul', { class: 'list' }, tree[type].map((acc, i, arr) => topItem(acc, i, arr.length))),
        openEditor === 'new:' + type
          ? newAccountForm(type, null)
          : h('button', { class: 'btn small ghost', type: 'button',
              onClick: () => { openEditor = 'new:' + type; ctx.refresh(); } }, `+ ${TYPE_LABELS[type]} 계정 추가`)))));

  // 옮긴 뒤 같은 계정의 손잡이에 다시 초점 (키보드로 연달아 옮기기 쉽게)
  if (focusAfter) {
    const id = focusAfter;
    focusAfter = null;
    requestAnimationFrame(() => view.querySelector(`[data-handle="${id}"]`)?.focus());
  }

  // =================================================================

  /** 상위(최상위) 계정 한 줄 + 펼치면 하위 계정 목록 */
  function topItem(acc, index, count) {
    const kids = acc.children;
    const isOpen = kids.length > 0 && opened.has(acc.id);
    const li = h('li', { class: 'acc-li', 'data-id': acc.id },
      h('div', { class: 'acc-row' },
        kids.length
          ? h('button', {
              type: 'button', class: 'acc-toggle',
              'aria-expanded': String(isOpen),
              'aria-label': `${acc.name} 하위 계정 ${kids.length}개 ${isOpen ? '접기' : '펼치기'}`,
              onClick: () => { if (isOpen) opened.delete(acc.id); else opened.add(acc.id); saveOpened(); },
            }, h('span', { class: 'acc-caret', 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'))
          : h('span', { class: 'acc-toggle-space', 'aria-hidden': 'true' }),
        nameButton(acc, false),
        dragHandle(acc, index, count)));
    if (openEditor === acc.id) li.append(editor(acc, false));
    if (openEditor === 'child:' + acc.id) li.append(newAccountForm(acc.type, acc));
    if (isOpen) {
      li.append(h('ul', { class: 'acc-children', 'aria-label': `${acc.name} 하위 계정` },
        kids.map((c, i) => {
          const cli = h('li', { 'data-id': c.id }, h('div', { class: 'acc-row' }, nameButton(c, true), dragHandle(c, i, kids.length)));
          if (openEditor === c.id) cli.append(editor(c, true));
          return cli;
        })));
    }
    return li;
  }

  /** 계정 이름 (누르면 편집기 열기·닫기) */
  function nameButton(acc, isChild) {
    return h('button', {
      type: 'button',
      class: 'acc-item' + (isChild ? ' child' : '') + (acc.is_hidden ? ' is-hidden' : ''),
      'aria-expanded': String(openEditor === acc.id),
      onClick: () => { openEditor = openEditor === acc.id ? null : acc.id; ctx.refresh(); },
    },
    h('span', { class: 'name' }, acc.name),
    acc.children?.length ? h('span', { class: 'badge' }, `하위 ${acc.children.length}`) : null,
    acc.subtype && !isChild && SUBTYPE_LABELS[acc.subtype] !== acc.name
      ? h('span', { class: 'badge' }, SUBTYPE_LABELS[acc.subtype] ?? acc.subtype) : null,
    acc.is_system ? h('span', { class: 'badge' }, '기본') : null,
    acc.is_hidden ? h('span', { class: 'badge bad' }, '숨김') : null);
  }

  /**
   * 끌어서 옮기는 손잡이 (⠿) — 마우스·터치 모두 (Pointer Events)
   *   같은 묶음(같은 분류의 상위끼리 / 같은 상위의 하위끼리) 안에서만 움직임
   *   키보드: 손잡이에 초점을 두고 ↑↓
   */
  function dragHandle(acc, index, count) {
    if (count < 2) return null;
    const handle = h('button', {
      type: 'button', class: 'acc-handle',
      'data-handle': acc.id,
      'aria-label': `${acc.name} 순서 바꾸기 — 끌어서 옮기거나 위·아래 화살표 키`,
      title: '끌어서 순서 바꾸기',
    }, h('span', { 'aria-hidden': 'true' }, '⠿'));
    handle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveTo(acc, index + (e.key === 'ArrowUp' ? -1 : 1));
      }
    });
    handle.addEventListener('pointerdown', (e) => startDrag(e, handle, acc));
    return handle;
  }

  /** 끌기: 잡은 줄이 손가락·마우스를 따라오고, 다른 줄의 가운데를 넘으면 자리를 바꿔 보여 줌 */
  function startDrag(e, handle, acc) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const li = handle.closest('li[data-id]');
    const list = li.parentElement;
    const startIndex = [...list.children].indexOf(li);
    // 문서 기준 좌표 (스크롤해도 어긋나지 않게)
    const startPointer = e.clientY + scrollY;
    const startTop = li.getBoundingClientRect().top + scrollY;
    let pointer = startPointer;
    let scrollTimer = null;
    try { handle.setPointerCapture(e.pointerId); } catch { /* 캡처를 못 해도 끌기는 동작 */ }
    li.classList.add('dragging');
    list.classList.add('drag-list');

    const pageTop = (el) => el.getBoundingClientRect().top + scrollY;
    const update = () => {
      const want = startTop + (pointer - startPointer);   // 잡은 줄이 있어야 할 위치
      const height = li.offsetHeight;
      // 이웃 줄의 가운데를 넘으면 자리를 바꿈
      let prev = li.previousElementSibling;
      while (prev && want < pageTop(prev) + prev.offsetHeight / 2) {
        list.insertBefore(li, prev);
        prev = li.previousElementSibling;
      }
      let next = li.nextElementSibling;
      while (next && want + height > pageTop(next) + next.offsetHeight / 2) {
        list.insertBefore(next, li);
        next = li.nextElementSibling;
      }
      li.style.transform = '';
      li.style.transform = `translateY(${want - pageTop(li)}px)`;
    };
    const onMove = (ev) => {
      pointer = ev.clientY + scrollY;
      update();
      // 화면 끝 가까이 끌면 자동으로 스크롤
      clearInterval(scrollTimer);
      const edge = ev.clientY < 70 ? -12 : ev.clientY > innerHeight - 90 ? 12 : 0;
      if (edge) {
        scrollTimer = setInterval(() => {
          const y = scrollY;
          scrollBy(0, edge);
          pointer += scrollY - y;
          update();
        }, 16);
      }
    };
    const onEnd = () => {
      clearInterval(scrollTimer);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      li.classList.remove('dragging');
      list.classList.remove('drag-list');
      li.style.transform = '';
      const endIndex = [...list.children].indexOf(li);
      if (endIndex !== startIndex) moveTo(acc, endIndex);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  }

  /** 순서 바꾸기: 화면은 바로 바꾸고, 저장은 차례대로 보냄 (실패하면 다시 불러옴) */
  function moveTo(acc, toIndex) {
    const changes = moveAccountTo(state.accounts, acc.id, toIndex);
    if (!changes.length) return;
    const byId = new Map(changes.map((c) => [c.id, c.sort_order]));
    setState({ accounts: state.accounts.map((a) => (byId.has(a.id) ? { ...a, sort_order: byId.get(a.id) } : a)) });
    focusAfter = acc.id;
    ctx.refresh();
    saving = saving
      .then(() => Promise.all(changes.map((c) => updateAccount(c.id, { sortOrder: c.sort_order }))))
      .then(() => prefs.set('cache.accounts.' + state.ledgerId, state.accounts))
      .catch(async (err) => {
        toast('순서를 저장하지 못했습니다: ' + err.message, { type: 'error', duration: 6000 });
        try { await ctx.reloadAccounts(); } catch { /* 다음에 다시 불러옴 */ }
        ctx.refresh();
      });
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
      if (parent) { opened.add(parent.id); prefs.set(openKey, [...opened]); }   // 새 하위가 보이게 펼침
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
