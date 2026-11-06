// 아직 만들지 않은 화면 (다음 단계에서 채움)
import { h, append } from '../dom.js';

export function placeholder(title, text) {
  return (view) => {
    append(view, h('h1', { class: 'view-title' }, title), h('p', { class: 'notice' }, text));
  };
}
