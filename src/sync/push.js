/**
 * TdyTripPWA2026 - Batch Push Engine (Phase 3)
 * Điều phối việc gửi các pending ops theo batch 5 ops lên backend Google Apps Script.
 * Xử lý per-op results độc lập (không all-or-nothing).
 */

import { outbox } from './outbox.js';
import { postBatchPayload } from './transport.js';
import { setMeta, SYNC_STATUS } from '../storage/db.js';

export const BATCH_SIZE = 5;
export const DEFAULT_TIMEOUT_MS = 45000;

export async function executePushBatch(url, token, options = {}) {
  const batchSize = options.batchSize || BATCH_SIZE;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  // 1. Lấy tối đa 5 ops PENDING (đã được sort theo timestamp tăng dần)
  const ops = await outbox.peekBatch(batchSize);
  if (ops.length === 0) {
    return { pushed: 0, status: 'NOOP' };
  }

  const opIds = ops.map(o => o.opId);

  // 2. Đánh dấu ops đang PROCESSING
  await outbox.markProcessing(opIds);

  try {
    // 3. Gửi payload POST BATCH_APPLY
    const response = await postBatchPayload(url, token, ops, timeoutMs);

    // 4. Bóc tách kết quả per-op độc lập: results: [{ opId, ok, error?, record? }]
    const results = response.results || [];
    const resultMap = new Map(results.map(r => [r.opId, r]));

    let ackedCount = 0;
    let rejectedCount = 0;
    let conflictCount = 0;
    let retryableCount = 0;

    for (const op of ops) {
      const res = resultMap.get(op.opId);

      if (!res) {
        // Server không trả kết quả cho opId này -> Giữ nguyên PENDING để retry
        await outbox.markRejected(op.opId, 'ERR_NO_OP_RESULT', true);
        retryableCount++;
        continue;
      }

      if (res.ok === true) {
        // Thành công -> Xóa khỏi outbox
        await outbox.markAcked([op.opId]);
        ackedCount++;
      } else {
        const error = res.error || 'ERR_UNKNOWN';

        if (error === 'ERR_VALIDATION') {
          // Lỗi xác thực nghiệp vụ -> Không retry
          await outbox.markRejected(op.opId, error, false);
          rejectedCount++;
        } else if (error === 'ERR_TRIP_LOCKED') {
          // Chuyến đi đã khóa -> Không retry, drop op
          await outbox.markRejected(op.opId, error, false);
          rejectedCount++;
        } else if (error === 'ERR_LOCK_TIMEOUT' || error === 'ERR_MEMBER_NOT_FOUND') {
          // Lỗi tạm thời -> retryable: true
          await outbox.markRejected(op.opId, error, true);
          retryableCount++;
        } else if (error === 'ERR_STALE_REV' || error === 'ERR_ID_CONFLICT') {
          // Xung đột phiên bản -> Chuyển sang needs_attention
          await outbox.markNeedsAttention(op.opId, res.record || null);
          conflictCount++;
        } else {
          // Mặc định lỗi lạ -> Cho phép retry
          await outbox.markRejected(op.opId, error, true);
          retryableCount++;
        }
      }
    }

    // 5. Cập nhật serverRevision nếu server phản hồi
    if (typeof response.serverRevision === 'number') {
      await setMeta('serverRevision', response.serverRevision);
    }
    await setMeta('lastSyncTime', new Date().toISOString());

    if (conflictCount > 0) {
      await setMeta('syncStatus', SYNC_STATUS.CONFLICT);
    } else {
      await setMeta('syncStatus', SYNC_STATUS.IDLE);
    }

    return {
      pushed: ops.length,
      acked: ackedCount,
      rejected: rejectedCount,
      conflicts: conflictCount,
      retryable: retryableCount,
      serverRevision: response.serverRevision
    };
  } catch (netErr) {
    // 6. Lỗi mạng toàn cục (timeout, ngắt kết nối, HTTP 500)
    // Hoàn trả toàn bộ ops về PENDING để thử lại ở chu kỳ sau
    for (const op of ops) {
      await outbox.markRejected(op.opId, netErr.message, true);
    }

    await setMeta('syncStatus', SYNC_STATUS.ERROR);
    await setMeta('lastError', netErr.message);

    return {
      pushed: 0,
      error: netErr.message,
      retryable: true
    };
  }
}
