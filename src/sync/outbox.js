/**
 * TdyTripPWA2026 - Outbox FIFO Queue Manager (Phase 3)
 * Điều phối hàng đợi cục bộ theo thứ tự thời gian nghiêm ngặt (FIFO).
 * Đảm bảo tính bất biến của opId và hỗ trợ batching 5 ops.
 */

import {
  enqueueOp as dbEnqueueOp,
  getOp as dbGetOp,
  updateOp as dbUpdateOp,
  removeOp as dbRemoveOp,
  getAllPendingOps,
  OP_STATUS
} from '../storage/db.js';

export function generateOpId(prefix = 'op') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

export class OutboxManager {
  /**
   * Đưa một thao tác mới vào hàng đợi outbox
   * @param {string} type - EXPENSE_CREATE | EXPENSE_UPDATE | EXPENSE_DELETE | SETTLEMENT_CREATE | MEMBER_CREATE | TRIP_COMPLETE
   * @param {object} payload - Dữ liệu thực thi của thao tác
   * @param {number|null} expectedRev - Revision kỳ vọng tại thời điểm tạo thao tác
   * @returns {Promise<object>}
   */
  async enqueue(type, payload, expectedRev = null) {
    if (!type || !payload) {
      throw new TypeError('Operation requires type and payload');
    }

    const op = {
      opId: generateOpId(),
      type,
      payload,
      expectedRev: expectedRev !== null && expectedRev !== undefined ? Number(expectedRev) : null,
      timestamp: new Date().toISOString().replace('Z', '+07:00'),
      status: OP_STATUS.PENDING,
      retryCount: 0,
      lastError: null
    };

    await dbEnqueueOp(op);
    return op;
  }

  /**
   * Lấy một batch tối đa maxSize ops có trạng thái PENDING
   * Bắt buộc sắp xếp timestamp tăng dần
   * @param {number} maxSize - Mặc định 5 ops
   * @returns {Promise<Array<object>>}
   */
  async peekBatch(maxSize = 5) {
    const allOps = await getAllPendingOps();
    const pendingOps = allOps.filter(op => op.status === OP_STATUS.PENDING);
    // Đảm bảo sort timestamp tăng dần
    pendingOps.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    return pendingOps.slice(0, maxSize);
  }

  /**
   * Đánh dấu danh sách opIds đang được gửi qua mạng
   * @param {Array<string>} opIds
   */
  async markProcessing(opIds) {
    for (const id of opIds) {
      const op = await dbGetOp(id);
      if (op && op.status === OP_STATUS.PENDING) {
        op.status = OP_STATUS.PROCESSING;
        await dbUpdateOp(op);
      }
    }
  }

  /**
   * Đánh dấu thành công (ACKED) từ server -> Xóa khỏi hàng đợi outbox
   * @param {Array<string>} opIds
   */
  async markAcked(opIds) {
    for (const id of opIds) {
      await dbRemoveOp(id);
    }
  }

  /**
   * Đánh dấu thất bại từ server
   * @param {string} opId
   * @param {string} error - Mã lỗi
   * @param {boolean} retryable - Nếu true -> trả về PENDING để thử lại
   */
  async markRejected(opId, error, retryable = false) {
    const op = await dbGetOp(opId);
    if (!op) return;

    if (retryable) {
      op.status = OP_STATUS.PENDING;
      op.retryCount = (op.retryCount || 0) + 1;
      op.lastError = error;
      await dbUpdateOp(op);
    } else {
      // Lỗi vĩnh viễn (ERR_VALIDATION, ERR_TRIP_LOCKED) -> xóa khỏi outbox
      await dbRemoveOp(opId);
    }
  }

  /**
   * Đánh dấu xung đột phiên bản (ERR_STALE_REV hoặc ERR_ID_CONFLICT)
   * Chuyển op sang NEEDS_ATTENTION và đính kèm bản ghi phía server để người dùng phân giải
   * @param {string} opId
   * @param {object} serverRecord
   */
  async markNeedsAttention(opId, serverRecord = null) {
    const op = await dbGetOp(opId);
    if (!op) return;

    op.status = OP_STATUS.NEEDS_ATTENTION;
    op.serverRecord = serverRecord;
    await dbUpdateOp(op);
  }

  /**
   * Trả về số lượng ops chưa đồng bộ xong (PENDING + PROCESSING + NEEDS_ATTENTION)
   */
  async getPendingCount() {
    const allOps = await getAllPendingOps();
    return allOps.filter(op => op.status !== OP_STATUS.ACKED).length;
  }

  /**
   * Lấy danh sách các ops đang bị xung đột cần chú ý
   */
  async getConflicts() {
    const allOps = await getAllPendingOps();
    return allOps.filter(op => op.status === OP_STATUS.NEEDS_ATTENTION);
  }

  /**
   * Phân giải xung đột:
   * 1. 'KEEP_SERVER' (Bỏ qua thay đổi của tôi): xóa op khỏi outbox
   * 2. 'KEEP_MINE' (Lưu bản của tôi): cập nhật expectedRev theo serverRecord.rev, reset về PENDING
   * 3. 'CREATE_NEW' (Tạo mới): tạo entity ID mới, reset về PENDING
   */
  async resolveConflict(opId, action) {
    const op = await dbGetOp(opId);
    if (!op) return false;

    if (action === 'KEEP_SERVER') {
      await dbRemoveOp(opId);
      return { resolved: true, action: 'KEEP_SERVER' };
    }

    if (action === 'KEEP_MINE') {
      if (op.serverRecord && typeof op.serverRecord.rev === 'number') {
        op.expectedRev = op.serverRecord.rev;
      }
      op.status = OP_STATUS.PENDING;
      op.serverRecord = null;
      await dbUpdateOp(op);
      return { resolved: true, action: 'KEEP_MINE' };
    }

    if (action === 'CREATE_NEW') {
      const newEntityId = `exp_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
      op.payload.id = newEntityId;
      op.expectedRev = null;
      op.status = OP_STATUS.PENDING;
      op.serverRecord = null;
      await dbUpdateOp(op);
      return { resolved: true, action: 'CREATE_NEW', newEntityId };
    }

    throw new TypeError(`Unknown conflict resolution action: "${action}"`);
  }
}

export const outbox = new OutboxManager();
