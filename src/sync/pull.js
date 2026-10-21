/**
 * TdyTripPWA2026 - Pull Delta Engine (Phase 3)
 * Kéo các thay đổi mới nhất từ server theo con trỏ revision (sinceRev).
 * Hợp nhất an toàn vào IndexedDB snapshot và tính toán lại Core Math.
 */

import { safeFetch } from './transport.js';
import { getSnapshot, saveSnapshot, getMeta, setMeta, SYNC_STATUS } from '../storage/db.js';
import { calculateBalances, simplifyDebts } from '../core/math.js';
import { outbox } from './outbox.js';

export const DEFAULT_TIMEOUT_MS = 45000;

export async function executePullDelta(url, token, tripId = 'default_trip', timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!url) throw new TypeError('Missing GAS URL');

  // 1. Đọc serverRevision hiện tại từ storage
  const currentServerRev = (await getMeta('serverRevision')) || 0;
  const separator = url.includes('?') ? '&' : '?';
  const pullUrl = `${url}${separator}action=pull&sinceRev=${currentServerRev}`;

  const bodyPayload = {
    action: 'pull',
    token: token || '',
    sinceRev: currentServerRev
  };

  try {
    const res = await safeFetch(
      pullUrl,
      {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(bodyPayload)
      },
      timeoutMs
    );
    const data = res.json;

    if (!data || data.ok !== true) {
      throw new Error(data?.error || 'Invalid pull response from server');
    }

    const changes = data.changes || [];
    const newServerRev = typeof data.serverRevision === 'number' ? data.serverRevision : currentServerRev;
    const tripStatus = data.status || 'ACTIVE';

    // 2. Lấy snapshot hiện tại
    let snapshot = await getSnapshot(tripId);
    if (!snapshot) {
      snapshot = {
        tripId,
        tripName: 'Chuyến đi Đà Lạt 2026',
        status: tripStatus,
        members: [],
        expenses: [],
        settlements: [],
        calculation: null,
        greedyDebts: []
      };
    }

    snapshot.status = tripStatus;

    // 3. Hợp nhất các bản ghi (Upsert / Tombstone)
    for (const change of changes) {
      if (change.type === 'expense') {
        const idx = snapshot.expenses.findIndex(e => e.id === change.id);
        if (idx >= 0) {
          if (change.rev >= snapshot.expenses[idx].rev) {
            snapshot.expenses[idx] = { ...snapshot.expenses[idx], ...change };
          }
        } else {
          snapshot.expenses.push(change);
        }
      } else if (change.type === 'settlement') {
        const idx = snapshot.settlements.findIndex(s => s.id === change.id);
        if (idx >= 0) {
          if (change.rev >= snapshot.settlements[idx].rev) {
            snapshot.settlements[idx] = { ...snapshot.settlements[idx], ...change };
          }
        } else {
          snapshot.settlements.push(change);
        }
      } else if (change.type === 'member') {
        const idx = snapshot.members.findIndex(m => m.id === change.id);
        if (idx >= 0) {
          snapshot.members[idx] = { ...snapshot.members[idx], ...change };
        } else {
          snapshot.members.push(change);
        }
      }
    }

    // 4. Tái tính toán số dư và công nợ với Core Math
    try {
      if (snapshot.members && snapshot.members.length > 0) {
        snapshot.calculation = calculateBalances(snapshot.members, snapshot.expenses, snapshot.settlements);
        snapshot.greedyDebts = simplifyDebts(snapshot.calculation.balances);
      }
    } catch (mathErr) {
      console.warn('Lỗi tính toán lại sau khi pull delta:', mathErr);
    }

    // 5. Lưu lại snapshot vào IndexedDB
    await saveSnapshot(snapshot);

    // 6. Cập nhật sync_meta
    await setMeta('serverRevision', newServerRev);
    await setMeta('lastSyncTime', new Date().toISOString());

    const conflicts = await outbox.getConflicts();
    if (conflicts.length > 0) {
      await setMeta('syncStatus', SYNC_STATUS.CONFLICT);
    } else {
      await setMeta('syncStatus', SYNC_STATUS.IDLE);
    }

    return {
      ok: true,
      changesCount: changes.length,
      serverRevision: newServerRev,
      tripStatus
    };
  } catch (err) {
    await setMeta('syncStatus', SYNC_STATUS.ERROR);
    await setMeta('lastError', err.message);
    throw err;
  }
}
