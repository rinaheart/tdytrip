/**
 * TdyTripPWA2026 - Sync Orchestrator Engine (Phase 3)
 * Điều phối toàn bộ chu kỳ đồng bộ tự động 2 chiều (Pull -> Push -> Pull),
 * Mutex chống trùng lặp, Exponential Backoff có Jitter, và Safe Boot Recovery.
 */

import { executePullDelta } from './pull.js';
import { executePushBatch } from './push.js';
import { outbox } from './outbox.js';
import {
  recoverStuckProcessingOps,
  getMeta,
  setMeta,
  SYNC_STATUS
} from '../storage/db.js';

export class SyncEngine {
  constructor() {
    this.isSyncing = false;
    this.failureCount = 0;
    this.retryTimer = null;
    this.periodicTimer = null;
    this.listeners = new Set();
    this.gasUrl = '';
    this.gasToken = '';
  }

  setCredentials(url, token) {
    this.gasUrl = (url || '').trim();
    this.gasToken = (token || '').trim();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify(data) {
    for (const fn of this.listeners) {
      try {
        fn(data);
      } catch (err) {
        console.error('Error in sync engine listener:', err);
      }
    }
  }

  async start() {
    // 1. Safe Boot: khôi phục các ops bị kẹt khi tắt trình duyệt đột ngột
    try {
      const recovered = await recoverStuckProcessingOps();
      if (recovered > 0) {
        console.info(`[SyncEngine] Safe Boot: Đã khôi phục ${recovered} ops từ PROCESSING về PENDING.`);
      }
    } catch (bootErr) {
      console.warn('[SyncEngine] Safe Boot recovery error:', bootErr);
    }

    // 2. Lắng nghe sự kiện Online/Offline của trình duyệt
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        console.info('[SyncEngine] Network online detected. Triggering sync...');
        this.sync();
      });
    }

    // 3. Khởi động chu kỳ định kỳ (mỗi 30s)
    this.periodicTimer = setInterval(() => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      this.sync();
    }, 30000);
  }

  stop() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  /**
   * Kích hoạt đồng bộ 2 chiều (Pull -> Push -> Pull)
   */
  async sync() {
    if (this.isSyncing) {
      return { status: 'IN_PROGRESS' };
    }

    if (!this.gasUrl) {
      return { status: 'NO_URL' };
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      await setMeta('syncStatus', SYNC_STATUS.IDLE);
      return { status: 'OFFLINE' };
    }

    this.isSyncing = true;
    await setMeta('syncStatus', SYNC_STATUS.SYNCING);
    this._notify({ status: SYNC_STATUS.SYNCING });

    try {
      // 1. Bước 1: Pull Delta để nhận dữ liệu mới nhất trước khi push
      await executePullDelta(this.gasUrl, this.gasToken);

      // 2. Bước 2: Push Batch (xử lý các batch đang chờ, ngắt an toàn nếu không có tiến triển)
      let pendingCount = await outbox.getPendingCount();
      while (pendingCount > 0) {
        const pushRes = await executePushBatch(this.gasUrl, this.gasToken);
        if (pushRes.pushed === 0 || pushRes.error || (pushRes.acked === 0 && pushRes.rejected === 0)) {
          break;
        }
        const nextCount = await outbox.getPendingCount();
        if (nextCount >= pendingCount) {
          break;
        }
        pendingCount = nextCount;
      }

      // 3. Bước 3: Pull Delta lần cuối sau khi push để đồng bộ revision chốt
      await executePullDelta(this.gasUrl, this.gasToken);

      // Đồng bộ thành công
      this.failureCount = 0;
      const conflicts = await outbox.getConflicts();
      const finalStatus = conflicts.length > 0 ? SYNC_STATUS.CONFLICT : SYNC_STATUS.IDLE;
      await setMeta('syncStatus', finalStatus);
      this._notify({ status: finalStatus });

      return { status: 'SUCCESS' };
    } catch (err) {
      this.failureCount++;
      await setMeta('syncStatus', SYNC_STATUS.ERROR);
      await setMeta('lastError', err.message);

      // Tính toán Exponential Backoff kèm Jitter ngẫu nhiên (±20%)
      const baseDelay = Math.min(60000, 2000 * Math.pow(2, this.failureCount - 1));
      const jitter = (Math.random() * 0.4 - 0.2) * baseDelay; // ±20%
      const finalDelay = Math.round(baseDelay + jitter);

      console.warn(`[SyncEngine] Sync failed: ${err.message}. Retrying in ${finalDelay}ms...`);

      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.sync(), finalDelay);

      this._notify({ status: SYNC_STATUS.ERROR, error: err.message });
      return { status: 'ERROR', error: err.message };
    } finally {
      this.isSyncing = false;
    }
  }
}

export const syncEngine = new SyncEngine();
