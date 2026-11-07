// =====================================================================
// 즐겨찾기 관리 (#/settings/favorites): 이름 바꾸기, 순서 바꾸기, 삭제
//   즐겨찾기 추가는 입력 화면(간편 입력)의 [☆ 이 입력을 즐겨찾기로 저장]에서
// =====================================================================

import { h, append, replace, toast, withBusy } from '../dom.js';
import { state } from '../state.js';
import { formatAmount } from '../../core/money.js';
import { SIMPLE_FORMS } from '../../core/simple.js';
import { templateAmount } from '../../core/recurring.js';
import { indexAccounts } from '../../core/balance.js';
import { updateFavorite, deleteFavorite } from '../../data/api.js';

export function render(view, ctx) {
  const byId = indexAccounts(state.accounts);
  const list = h('div');
  append(view,
    h('div', { class: 'row' }, h('a', { href: '#/settings', class: 'btn small ghost' }, '‹ 설정'),
      h('h1', { class: 'view-title' }, '즐겨찾기')),
    h('p', { class: 'small muted', style: 'margin-bottom:12px' },
      '입력 화면 맨 위 ★ 줄에 나오는 순서입니다. 추가는 입력 → 간편 입력에서 계정을 고른 뒤 [☆ 이 입력을 즐겨찾기로 저장].'),
    list);
  draw();

  function describe(f) {
    const t = f.template;
    const spec = SIMPLE_FORMS[t?.kind];
    if (!spec) return '';
    const accounts = spec.pickers.map((p) => byId.get(t.values?.[p.key])?.name).filter(Boolean).join(' · ');
    const amount = templateAmount(t);
    return `${spec.label} · ${accounts}${amount ? ` · ${formatAmount(amount)}원` : ' · 금액은 그때그때'}`;
  }

  function draw() {
    const favs = state.favorites;
    if (!favs.length) return replace(list, h('p', { class: 'card muted' }, '저장한 즐겨찾기가 없습니다.'));
    replace(list, h('section', { class: 'card' }, h('ul', { class: 'list' }, favs.map((f, i) => {
      const up = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${f.name} 위로`, disabled: i === 0,
        onClick: () => move(i, -1) }, '↑');
      const down = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `${f.name} 아래로`, disabled: i === favs.length - 1,
        onClick: () => move(i, 1) }, '↓');
      const rename = h('button', { class: 'btn small', type: 'button', onClick: () => editName(f) }, '이름');
      const del = h('button', { class: 'btn small danger', type: 'button' }, '삭제');
      del.addEventListener('click', () => {
        if (!confirm(`"${f.name}" 즐겨찾기를 삭제할까요?`)) return;
        withBusy(del, '…', async () => {
          try { await deleteFavorite(f.id); await ctx.reloadFavorites(); toast('삭제했습니다.'); draw(); }
          catch (err) { toast(err.message, { type: 'error' }); }
        });
      });
      return h('li', { class: 'stack', style: 'gap:6px' },
        h('div', { class: 'row between' }, h('strong', {}, f.name), h('div', { class: 'row', style: 'gap:2px' }, up, down)),
        h('div', { class: 'small muted' }, describe(f)),
        h('div', { class: 'row' }, rename, del));
    }))));
  }

  async function move(i, d) {
    const favs = [...state.favorites];
    [favs[i], favs[i + d]] = [favs[i + d], favs[i]];
    try {
      await Promise.all(favs.map((f, idx) => (f.sort_order === idx ? null : updateFavorite(f.id, { sort_order: idx }))));
      await ctx.reloadFavorites();
      draw();
    } catch (err) { toast(err.message, { type: 'error' }); }
  }

  async function editName(f) {
    const name = prompt('즐겨찾기 이름', f.name);
    if (!name || !name.trim() || name.trim() === f.name) return;
    try {
      await updateFavorite(f.id, { name: name.trim().slice(0, 30) });
      await ctx.reloadFavorites();
      draw();
    } catch (err) { toast(err.message, { type: 'error' }); }
  }
}
