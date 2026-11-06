// =====================================================================
// 전표 저장 흐름: 대기열에 넣기 → 서버 전송 → 성공하면 대기열에서 삭제
//   - 네트워크 오류: 대기열에 남겨 두고, 연결되면 자동 재전송 (같은 id라 중복 저장 없음)
//   - 서버가 거부(차대 불일치 등): 즉시 저장이면 화면에 알리고 대기열에서 삭제,
//     나중 재전송이면 'failed'로 표시해 사용자가 확인·삭제하게 함
// =====================================================================

import * as outbox from './outbox.js';
import { createTransaction } from './api.js';

const listeners = new Set();
let syncing = null;

/** 대기열 변화 구독: fn({ pending, failed, items }) */
export function onQueueChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function notify() {
  const items = await outbox.list();
  const info = {
    items,
    pending: items.filter((i) => i.status === 'pending').length,
    failed: items.filter((i) => i.status === 'failed').length,
  };
  for (const fn of listeners) fn(info);
  return info;
}

/** 네트워크 문제인지 (서버가 내용을 거부한 것과 구분) */
export function isNetworkError(err) {
  const raw = String(err?.cause?.message ?? err?.message ?? '');
  return !navigator.onLine || /failed to fetch|networkerror|load failed|network request failed|인터넷에 연결/i.test(raw)
    || err?.cause?.name === 'AuthRetryableFetchError';
}

/**
 * 전표 저장
 * @param {{ id, ledgerId, date, memo, kind, source, lines }} payload
 * @returns {Promise<{ status: 'saved' | 'queued' }>} 서버가 거부하면 Error를 던짐
 */
export async function submitTransaction(payload) {
  const item = { id: payload.id, ledgerId: payload.ledgerId, payload, createdAt: Date.now(), status: 'pending', error: null };
  await outbox.put(item);
  try {
    await createTransaction(payload);
    await outbox.remove(item.id);
    await notify();
    return { status: 'saved' };
  } catch (err) {
    if (isNetworkError(err)) {
      await notify();
      return { status: 'queued' };
    }
    await outbox.remove(item.id);   // 내용 오류: 화면에서 고치도록 대기열에서는 뺌
    await notify();
    throw err;
  }
}

/**
 * 대기 중인 전표를 모두 서버로 보냄 (앱 시작·연결 복구·주기적으로 호출)
 * @returns {Promise<{ sent: number, failed: number, remaining: number }>}
 */
export function flush() {
  if (syncing) return syncing;
  syncing = (async () => {
    let sent = 0;
    let failed = 0;
    for (const item of await outbox.list()) {
      if (item.status !== 'pending') continue;
      try {
        await createTransaction(item.payload);
        await outbox.remove(item.id);
        sent++;
      } catch (err) {
        if (isNetworkError(err)) break;     // 아직 오프라인 — 다음에 다시
        await outbox.put({ ...item, status: 'failed', error: err.message });
        failed++;
      }
    }
    const info = await notify();
    return { sent, failed, remaining: info.pending };
  })().finally(() => { syncing = null; });
  return syncing;
}

/** 실패한 항목 다시 시도 */
export async function retry(id) {
  const item = (await outbox.list()).find((i) => i.id === id);
  if (item) await outbox.put({ ...item, status: 'pending', error: null });
  return flush();
}

/** 대기열에서 삭제 (저장 포기) */
export async function discard(id) {
  await outbox.remove(id);
  return notify();
}

/** 현재 대기열 상태 */
export const queueInfo = notify;
