// =====================================================================
// 화면 공통 도우미: 요소 만들기, 토스트, 로딩, 버튼 처리 중 표시
// =====================================================================

/**
 * 요소 만들기. h('button', { class: 'btn', onClick: fn }, '저장')
 * - on으로 시작하는 속성은 이벤트, value/checked/disabled 등은 속성(property)으로 설정
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [key, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (key === 'class') el.className = v;
    else if (key === 'value') value = v;
    else if (key === 'dataset') Object.assign(el.dataset, v);
    else if (key.startsWith('on') && typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v);
    else if (v === true) {
      // disabled·required 등은 속성(property)으로, novalidate 같은 이름이 다른 것은 HTML 속성으로
      if (key in el) el[key] = true;
      else el.setAttribute(key, '');
    } else el.setAttribute(key, String(v));
  }
  append(el, ...children);
  if (value !== undefined) el.value = value;   // select는 option이 붙은 뒤에 값 지정
  return el;
}

/** 자식 추가 (여러 개·배열·null·문자열 허용) */
export function append(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** 내용을 비우고 새 자식으로 바꿈 */
export function replace(el, ...children) {
  el.replaceChildren();
  return append(el, ...children);
}

/** 로딩 표시 */
export function loading(text = '불러오는 중…') {
  return h('div', { class: 'loading', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

/** 오류 안내 상자 + 다시 시도 버튼 */
export function errorBox(message, onRetry) {
  return h('div', { class: 'notice bad stack', role: 'alert' },
    h('p', {}, message),
    onRetry ? h('button', { class: 'btn small', type: 'button', onClick: onRetry }, '다시 시도') : null);
}

/** 화면 아래쪽 알림 */
export function toast(message, { type = 'info', duration = 3500 } = {}) {
  let area = document.querySelector('.toast-area');
  if (!area) {
    area = h('div', { class: 'toast-area', 'aria-live': 'polite' });
    document.body.append(area);
  }
  const t = h('div', { class: `toast ${type === 'error' ? 'bad' : ''}`, role: type === 'error' ? 'alert' : 'status' }, message);
  area.append(t);
  setTimeout(() => t.remove(), duration);
}

/**
 * 버튼을 누른 동안 비활성화하고 "처리 중" 표시. 두 번 눌러 중복 실행되는 것을 막습니다.
 * @returns {Promise<any>} fn의 결과
 */
export async function withBusy(button, busyLabel, fn) {
  if (button.dataset.busy) return undefined;
  const original = [...button.childNodes];
  button.dataset.busy = '1';
  button.disabled = true;
  replace(button, h('span', { class: 'spinner', 'aria-hidden': 'true' }), busyLabel);
  try {
    return await fn();
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.replaceChildren(...original);
  }
}

/** 간단한 SVG 아이콘 (선 아이콘) */
export function icon(paths, label) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (label) svg.setAttribute('aria-label', label);
  else svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
