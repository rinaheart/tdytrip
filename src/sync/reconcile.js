/**
 * TdyTripPWA2026 - Conflict Reconcile Engine (Phase 3)
 * Xử lý giải quyết xung đột theo đúng quy chuẩn đã chốt:
 * - Với CREATE: 3 lựa chọn (Giữ bản server / Tạo khoản chi mới với ID mới / Bỏ qua op)
 * - Với UPDATE/DELETE: 2 lựa chọn (Giữ bản server / Lưu thành bản sửa mới với rev của server)
 */

import { outbox } from './outbox.js';
import { getSnapshot, saveSnapshot, setMeta, SYNC_STATUS } from '../storage/db.js';
import { calculateBalances, simplifyDebts } from '../core/math.js';

export async function resolveConflictAction(opId, choice, tripId = 'default_trip') {
  const conflicts = await outbox.getConflicts();
  const op = conflicts.find(o => o.opId === opId);
  if (!op) {
    throw new Error(`Conflict op with ID "${opId}" not found in outbox`);
  }

  const isCreate = op.type.endsWith('_CREATE');

  if (choice === 'KEEP_SERVER') {
    // 1. Giữ bản server: Xóa op khỏi outbox, khôi phục snapshot theo bản ghi của server
    await outbox.resolveConflict(opId, 'KEEP_SERVER');

    if (op.serverRecord) {
      const snapshot = await getSnapshot(tripId);
      if (snapshot) {
        snapshot.expenses = snapshot.expenses || [];
        snapshot.settlements = snapshot.settlements || [];
        if (op.type.startsWith('EXPENSE_')) {
          const idx = snapshot.expenses.findIndex(e => e.id === op.serverRecord.id);
          if (idx >= 0) snapshot.expenses[idx] = { ...op.serverRecord };
          else snapshot.expenses.push({ ...op.serverRecord });
        } else if (op.type.startsWith('SETTLEMENT_')) {
          const idx = snapshot.settlements.findIndex(s => s.id === op.serverRecord.id);
          if (idx >= 0) snapshot.settlements[idx] = { ...op.serverRecord };
          else snapshot.settlements.push({ ...op.serverRecord });
        }
        const validExpenses = snapshot.expenses.filter(e => e.deleted || (e.payerId && Array.isArray(e.participants) && e.participants.length > 0));
        snapshot.calculation = calculateBalances(snapshot.members, validExpenses, snapshot.settlements);
        snapshot.greedyDebts = simplifyDebts(snapshot.calculation.balances);
        await saveSnapshot(snapshot);
      }
    }
  } else if (choice === 'DROP_OP') {
    // 2. Bỏ qua thay đổi cục bộ (Bỏ op): xóa khỏi outbox
    await outbox.resolveConflict(opId, 'KEEP_SERVER');

    const snapshot = await getSnapshot(tripId);
    if (snapshot) {
      snapshot.expenses = snapshot.expenses || [];
      snapshot.settlements = snapshot.settlements || [];
      if (op.type.startsWith('EXPENSE_')) {
        if (isCreate) {
          // Khoản chi vừa tạo bị hủy bỏ hoàn toàn
          snapshot.expenses = snapshot.expenses.filter(e => e.id !== op.payload.id);
        } else if (op.serverRecord) {
          // Khoản sửa/xóa khôi phục về bản server
          const idx = snapshot.expenses.findIndex(e => e.id === op.serverRecord.id);
          if (idx >= 0) snapshot.expenses[idx] = { ...op.serverRecord };
        }
      } else if (op.type.startsWith('SETTLEMENT_')) {
        if (isCreate) {
          // Khoản thanh toán vừa tạo bị hủy bỏ hoàn toàn
          snapshot.settlements = snapshot.settlements.filter(s => s.id !== op.payload.id);
        } else if (op.serverRecord) {
          // Khoản thanh toán sửa/xóa khôi phục về bản server
          const idx = snapshot.settlements.findIndex(s => s.id === op.serverRecord.id);
          if (idx >= 0) snapshot.settlements[idx] = { ...op.serverRecord };
        }
      }
      const validExpenses = snapshot.expenses.filter(e => e.deleted || (e.payerId && Array.isArray(e.participants) && e.participants.length > 0));
      snapshot.calculation = calculateBalances(snapshot.members, validExpenses, snapshot.settlements);
      snapshot.greedyDebts = simplifyDebts(snapshot.calculation.balances);
      await saveSnapshot(snapshot);
    }
  } else if (choice === 'CREATE_NEW' && isCreate) {
    // 3. Tạo khoản chi mới với ID mới (chỉ cho CREATE)
    await outbox.resolveConflict(opId, 'CREATE_NEW');
  } else if (choice === 'OVERWRITE_SERVER' || choice === 'KEEP_MINE') {
    // Tùy chọn giữ bản của tôi (lấy rev server mới làm expectedRev, reset PENDING)
    await outbox.resolveConflict(opId, 'KEEP_MINE');
  } else {
    throw new TypeError(`Invalid conflict choice "${choice}" for op type "${op.type}"`);
  }

  // Cập nhật lại sync status
  const remainingConflicts = await outbox.getConflicts();
  if (remainingConflicts.length === 0) {
    await setMeta('syncStatus', SYNC_STATUS.IDLE);
  }

  return { ok: true, opId, choice };
}
