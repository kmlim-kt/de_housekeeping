// =====================================================================
// 로그인 화면: 로그인 / 회원가입 / 비밀번호 찾기 / 새 비밀번호 설정(메일 링크로 들어온 경우)
// =====================================================================

import { h, replace, withBusy } from './dom.js';
import { signIn, signUp, sendPasswordReset, updatePassword } from '../data/api.js';

const MIN_PASSWORD = 6;   // Supabase 기본 최소 길이

/**
 * @param {HTMLElement} root
 * @param {{ mode?: 'login'|'signup'|'reset'|'recovery', message?: string, onRecovered?: () => void }} [opts]
 */
export function renderAuth(root, opts = {}) {
  let mode = opts.mode ?? 'login';
  const card = h('div', { class: 'card stack-lg' });
  replace(root, h('main', { class: 'auth' }, card));

  function draw(notice) {
    const status = h('div', { 'aria-live': 'polite' }, notice ?? (opts.message ? h('p', { class: 'notice' }, opts.message) : null));
    opts.message = null;

    const header = h('div', { class: 'stack' },
      h('h1', {}, '복식부기 가계부'),
      h('p', { class: 'muted small' }, '쉽게 적고, 장부는 정확하게.'));

    const tabs = mode === 'login' || mode === 'signup'
      ? h('div', { class: 'segmented', role: 'group', 'aria-label': '로그인 또는 회원가입' },
          tabButton('login', '로그인'), tabButton('signup', '회원가입'))
      : null;

    replace(card, header, tabs, formFor(mode, status), status);
  }

  function tabButton(m, label) {
    return h('button', {
      type: 'button',
      'aria-pressed': String(mode === m),
      onClick: () => { mode = m; draw(); },
    }, label);
  }

  function show(status, text, type = '') {
    replace(status, h('p', { class: `notice ${type}`, role: type === 'bad' ? 'alert' : 'status' }, text));
  }

  function formFor(m, status) {
    const email = h('input', { type: 'email', name: 'email', autocomplete: 'email', required: true, inputmode: 'email' });
    const pw = h('input', {
      type: 'password', name: 'password', required: true, minlength: String(MIN_PASSWORD),
      autocomplete: m === 'login' ? 'current-password' : 'new-password',
    });
    const pw2 = h('input', { type: 'password', name: 'password2', required: true, autocomplete: 'new-password' });
    const submit = h('button', { class: 'btn primary block', type: 'submit' });

    const fields = [];
    if (m !== 'recovery') fields.push(h('label', { class: 'field' }, h('span', {}, '이메일'), email));
    if (m !== 'reset') fields.push(h('label', { class: 'field' }, h('span', {}, m === 'recovery' ? '새 비밀번호' : '비밀번호'), pw));
    if (m === 'signup' || m === 'recovery') {
      fields.push(h('label', { class: 'field' }, h('span', {}, '비밀번호 확인'), pw2));
      fields.push(h('p', { class: 'muted small' }, `비밀번호는 ${MIN_PASSWORD}자 이상으로 정하세요.`));
    }
    submit.textContent = { login: '로그인', signup: '가입하기', reset: '재설정 메일 받기', recovery: '비밀번호 바꾸기' }[m];

    // 화면 종류별로 입력란 앞(before)·뒤(after)에 붙는 요소
    const goto = (next, label) =>
      h('button', { class: 'btn ghost block', type: 'button', onClick: () => { mode = next; draw(); } }, label);
    const before = {
      reset: [h('h2', {}, '비밀번호 찾기'), h('p', { class: 'muted small' }, '가입한 이메일로 비밀번호 재설정 링크를 보내 드립니다.')],
      recovery: [h('h2', {}, '새 비밀번호 설정')],
    }[m] ?? [];
    const after = {
      login: [goto('reset', '비밀번호를 잊으셨나요?')],
      reset: [goto('login', '로그인으로 돌아가기')],
    }[m] ?? [];

    const form = h('form', { class: 'stack', novalidate: true }, before, fields, submit, after);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const e = email.value.trim();
      // 화면에서 먼저 검사
      if (m !== 'recovery' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return show(status, '이메일 주소를 확인하세요.', 'bad');
      if (m !== 'reset' && pw.value.length < MIN_PASSWORD) return show(status, `비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`, 'bad');
      if ((m === 'signup' || m === 'recovery') && pw.value !== pw2.value) return show(status, '비밀번호 확인이 일치하지 않습니다.', 'bad');

      withBusy(submit, '처리 중…', async () => {
        try {
          if (m === 'login') {
            await signIn(e, pw.value);   // 성공하면 app.js가 로그인 상태 변화를 받아 화면을 바꿈
          } else if (m === 'signup') {
            const { session } = await signUp(e, pw.value);
            if (!session) {
              mode = 'login';
              draw(h('p', { class: 'notice ok', role: 'status' },
                `${e} 로 확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인하세요. (스팸함도 확인해 주세요)`));
            }
          } else if (m === 'reset') {
            await sendPasswordReset(e);
            show(status, '메일을 보냈습니다. 메일의 링크를 누르면 새 비밀번호를 정하는 화면이 열립니다.', 'ok');
          } else if (m === 'recovery') {
            await updatePassword(pw.value);
            opts.onRecovered?.();
          }
        } catch (err) {
          show(status, err.message, 'bad');
        }
      });
    });
    return form;
  }

  draw();
}
