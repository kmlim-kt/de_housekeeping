// =====================================================================
// 장부·가족 (#/settings/ledger)
//   장부 이름 바꾸기, 구성원 목록(이메일·역할), 소유자 지정·내보내기, 나가기
//   초대 코드 만들기(소유자) — 받은 사람이 [초대 코드로 합류]에 입력
//   새 장부 만들기, 장부 삭제(소유자, 이름을 직접 입력해 확인)
// 권한 검사는 DB(RLS·RPC)가 합니다. 화면은 할 수 있는 버튼만 보여 줍니다.
// =====================================================================

import { h, append, replace, toast, withBusy, loading, errorBox } from '../dom.js';
import { state, currentLedger } from '../state.js';
import { membersInfo, setMemberRole, removeMember, createInvite, listInvites, deleteInvite, acceptInvite,
  renameLedger, deleteLedger, createLedger } from '../../data/api.js';

export function render(view, ctx) {
  const ledger = currentLedger();
  const isOwner = ledger?.role === 'owner';
  const membersBox = h('div', { class: 'stack' }, loading());
  const invitesBox = h('div', { class: 'stack' });

  append(view,
    h('div', { class: 'row' }, h('a', { href: '#/settings', class: 'btn small ghost' }, '‹ 설정'),
      h('h1', { class: 'view-title' }, '장부·가족')),
    h('div', { class: 'stack' },
      nameSection(),
      h('section', { class: 'card stack' }, h('h2', {}, '구성원'), membersBox),
      isOwner ? h('section', { class: 'card stack' }, h('h2', {}, '가족 초대'), invitesBox) : null,
      joinSection(),
      newLedgerSection(),
      isOwner ? deleteSection() : null));

  loadMembers();
  if (isOwner) loadInvites();

  // ---------- 장부 이름 ----------
  function nameSection() {
    const name = h('input', { type: 'text', maxlength: '50', value: ledger?.name ?? '', 'aria-label': '장부 이름', disabled: !isOwner });
    const save = h('button', { class: 'btn small primary', type: 'submit' }, '이름 저장');
    const f = h('form', { class: 'card stack' },
      h('h2', {}, '이 장부'),
      h('div', { class: 'inline-add' }, name, isOwner ? save : null),
      h('p', { class: 'small muted' }, `내 역할: ${isOwner ? '소유자 — 초대·구성원 관리·장부 삭제 가능' : '구성원 — 입력·수정 가능'}`));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!name.value.trim()) return;
      withBusy(save, '…', async () => {
        try {
          await renameLedger(state.ledgerId, name.value);
          await ctx.reloadLedgers();
          toast('장부 이름을 바꿨습니다.');
        } catch (err) { toast(err.message, { type: 'error' }); }
      });
    });
    return f;
  }

  // ---------- 구성원 ----------
  async function loadMembers() {
    try {
      const list = await membersInfo(state.ledgerId);
      const owners = list.filter((m) => m.role === 'owner').length;
      replace(membersBox, h('ul', { class: 'list' }, list.map((m) => {
        const actions = [];
        if (isOwner && !m.is_me) {
          const roleBtn = h('button', { class: 'btn small', type: 'button' }, m.role === 'owner' ? '구성원으로' : '소유자로');
          roleBtn.addEventListener('click', () => withBusy(roleBtn, '…', async () => {
            try { await setMemberRole(state.ledgerId, m.user_id, m.role === 'owner' ? 'member' : 'owner'); loadMembers(); }
            catch (err) { toast(err.message, { type: 'error' }); }
          }));
          const kick = h('button', { class: 'btn small danger', type: 'button' }, '내보내기');
          kick.addEventListener('click', () => {
            if (!confirm(`${m.email} 님을 이 장부에서 내보낼까요? 입력한 전표는 남습니다.`)) return;
            withBusy(kick, '…', async () => {
              try { await removeMember(state.ledgerId, m.user_id); toast('내보냈습니다.'); loadMembers(); }
              catch (err) { toast(err.message, { type: 'error' }); }
            });
          });
          actions.push(roleBtn, kick);
        }
        if (m.is_me && !(m.role === 'owner' && owners === 1)) {
          const leave = h('button', { class: 'btn small danger', type: 'button' }, '이 장부에서 나가기');
          leave.addEventListener('click', () => {
            if (!confirm('이 장부에서 나갈까요? 다시 들어오려면 초대 코드가 필요합니다.')) return;
            withBusy(leave, '…', async () => {
              try {
                await removeMember(state.ledgerId, m.user_id);
                toast('장부에서 나갔습니다.');
                await ctx.reloadLedgers();
                ctx.navigate('dashboard');
              } catch (err) { toast(err.message, { type: 'error' }); }
            });
          });
          actions.push(leave);
        }
        return h('li', { class: 'stack', style: 'gap:6px' },
          h('div', { class: 'row between' },
            h('span', {}, m.email, m.is_me ? h('span', { class: 'small muted' }, ' (나)') : null),
            h('span', { class: 'badge' }, m.role === 'owner' ? '소유자' : '구성원')),
          h('span', { class: 'small muted' }, `${new Date(m.joined_at).toLocaleDateString('ko-KR')} 합류`),
          actions.length ? h('div', { class: 'row', style: 'flex-wrap:wrap' }, actions) : null);
      })));
    } catch (err) {
      replace(membersBox, errorBox(state.online ? err.message : '인터넷 연결이 필요합니다.', loadMembers));
    }
  }

  // ---------- 초대 (소유자) ----------
  async function loadInvites() {
    const email = h('input', { type: 'email', inputmode: 'email', placeholder: '받는 사람 이메일 (선택)', 'aria-label': '초대할 이메일' });
    const make = h('button', { class: 'btn primary', type: 'button' }, '초대 코드 만들기');
    const codeBox = h('div');
    make.addEventListener('click', () => withBusy(make, '만드는 중…', async () => {
      try {
        const code = await createInvite(state.ledgerId, email.value.trim());
        const share = `"${ledger?.name}" 가계부에 초대합니다.\n앱 주소: ${location.origin + location.pathname}\n가입·로그인 후 설정 → 장부·가족 → [초대 코드로 합류]에 입력: ${code}\n(7일 동안 1번 사용 가능)`;
        const copy = h('button', { class: 'btn small', type: 'button' }, '안내문 복사');
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(share); toast('복사했습니다. 문자·메신저로 보내세요.'); }
          catch { toast('복사하지 못했습니다. 코드를 길게 눌러 직접 복사하세요.', { type: 'error' }); }
        });
        const shareBtn = navigator.share ? h('button', { class: 'btn small', type: 'button',
          onClick: () => navigator.share({ text: share }).catch(() => {}) }, '공유하기') : null;
        replace(codeBox, h('div', { class: 'notice ok stack' },
          h('div', {}, '초대 코드: ', h('strong', { class: 'num', style: 'font-size:1.3rem;letter-spacing:2px' }, code)),
          h('span', { class: 'small' }, `7일 동안 한 번 쓸 수 있습니다.${email.value.trim() ? ` ${email.value.trim()} 계정만 사용 가능.` : ''}`),
          h('div', { class: 'row' }, copy, shareBtn)));
        email.value = '';
        drawPending();
      } catch (err) { toast(err.message, { type: 'error' }); }
    }));
    const pending = h('div');
    async function drawPending() {
      try {
        const list = (await listInvites(state.ledgerId)).filter((i) => new Date(i.expires_at) > new Date());
        replace(pending, list.length ? h('div', { class: 'stack', style: 'gap:4px' },
          h('span', { class: 'small muted' }, '아직 쓰지 않은 초대 코드'),
          h('ul', { class: 'list' }, list.map((i) => {
            const del = h('button', { class: 'btn small ghost', type: 'button' }, '취소');
            del.addEventListener('click', () => withBusy(del, '…', async () => {
              try { await deleteInvite(i.id); drawPending(); } catch (err) { toast(err.message, { type: 'error' }); }
            }));
            return h('li', { class: 'row between' },
              h('span', { class: 'small' }, h('strong', { class: 'num' }, i.code),
                ` · ${new Date(i.expires_at).toLocaleDateString('ko-KR')}까지${i.email ? ` · ${i.email}` : ''}`), del);
          }))) : null);
      } catch { replace(pending); }
    }
    replace(invitesBox,
      h('p', { class: 'small muted' }, '배우자·가족이 같은 장부를 쓰게 하려면 초대 코드를 만들어 보내세요. 받은 사람이 가입한 뒤 코드를 입력하면 함께 입력·조회할 수 있습니다.'),
      h('div', { class: 'stack' }, email, make), codeBox, pending);
    drawPending();
  }

  // ---------- 초대 코드로 합류 ----------
  function joinSection() {
    const code = h('input', { type: 'text', maxlength: '20', placeholder: '초대 코드 10자리', 'aria-label': '초대 코드',
      autocapitalize: 'characters', autocomplete: 'off' });
    const join = h('button', { class: 'btn small primary', type: 'submit' }, '합류');
    const f = h('form', { class: 'card stack' }, h('h2', {}, '초대 코드로 합류'),
      h('p', { class: 'small muted' }, '가족에게 받은 초대 코드를 넣으면 그 장부가 추가됩니다. 내 장부는 그대로 남고 화면 위쪽에서 바꿔 볼 수 있습니다.'),
      h('div', { class: 'inline-add' }, code, join));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!code.value.trim()) return code.focus();
      withBusy(join, '…', async () => {
        try {
          const id = await acceptInvite(code.value.trim());
          await ctx.reloadLedgers(id);
          toast('장부에 합류했습니다. 이 장부로 바꿨습니다.');
          ctx.navigate('dashboard');
        } catch (err) { toast(err.message, { type: 'error' }); }
      });
    });
    return f;
  }

  // ---------- 새 장부 ----------
  function newLedgerSection() {
    const name = h('input', { type: 'text', maxlength: '50', placeholder: '예: 개인 용돈, 부모님 가계부', 'aria-label': '새 장부 이름' });
    const make = h('button', { class: 'btn small', type: 'submit' }, '만들기');
    const f = h('form', { class: 'card stack' }, h('h2', {}, '새 장부 만들기'),
      h('p', { class: 'small muted' }, '기본 계정과목이 들어 있는 빈 장부를 하나 더 만듭니다.'),
      h('div', { class: 'inline-add' }, name, make));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!name.value.trim()) return name.focus();
      withBusy(make, '…', async () => {
        try {
          const id = await createLedger(name.value.trim());
          await ctx.reloadLedgers(id);
          toast(`"${name.value.trim()}" 장부를 만들고 바꿨습니다.`);
          ctx.navigate('opening');
        } catch (err) { toast(err.message, { type: 'error' }); }
      });
    });
    return f;
  }

  // ---------- 장부 삭제 (소유자) ----------
  function deleteSection() {
    const del = h('button', { class: 'btn block danger', type: 'button' }, '이 장부 삭제');
    del.addEventListener('click', () => {
      if (state.ledgers.length <= 1) {
        toast('장부가 하나뿐이라 삭제할 수 없습니다. 새 장부를 먼저 만들거나 합류하세요.', { type: 'error' });
        return;
      }
      const typed = prompt(`장부를 삭제하면 계정과목·전표·예산 등 모든 데이터가 영구히 지워지고 되돌릴 수 없습니다.\n먼저 [설정 → 데이터 관리]에서 백업을 받아 두세요.\n\n삭제하려면 장부 이름 "${ledger.name}"을(를) 그대로 입력하세요.`);
      if (typed === null) return;
      if (typed.trim() !== ledger.name) { toast('장부 이름이 일치하지 않아 삭제하지 않았습니다.', { type: 'error' }); return; }
      withBusy(del, '삭제 중…', async () => {
        try {
          await deleteLedger(state.ledgerId);
          toast(`"${ledger.name}" 장부를 삭제했습니다.`);
          await ctx.reloadLedgers();
          ctx.navigate('dashboard');
        } catch (err) { toast(err.message, { type: 'error' }); }
      });
    });
    return h('section', { class: 'card stack deleted-banner' }, h('h2', {}, '장부 삭제'),
      h('p', { class: 'small muted' }, '이 장부와 모든 데이터를 영구히 지웁니다. 구성원 모두에게서 사라집니다.'), del);
  }
}
