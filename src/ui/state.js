/**
 * TdyTripPWA2026 - IndexedDB-Backed Reactive State Store (Phase 3)
 * Lưu trữ bền vững vào IndexedDB, điều phối hàng đợi Outbox FIFO và Sync Engine.
 * Bảo toàn 100% chữ ký API mutation của Phase 2 và lõi toán học pure functional src/core/math.js.
 */

import {
  validateExpenseInput,
  validateSettlementInput,
  calculateBalances,
  simplifyDebts
} from '../core/math.js';

import {
  getSnapshot,
  saveSnapshot,
  getMeta,
  setMeta,
  SYNC_STATUS
} from '../storage/db.js';

import { outbox } from '../sync/outbox.js';
import { syncEngine } from '../sync/engine.js';
import { resolveConflictAction } from '../sync/reconcile.js';

// Dữ liệu Seed mẫu ban đầu (phục vụ test và khởi tạo cold-start)
export const INITIAL_MEMBERS = [
  { id: 'mem_1', name: 'An', active: true, bankName: 'Techcombank', bankAccount: '19036789999011' },
  { id: 'mem_2', name: 'Bình', active: true, bankName: 'Vietcombank', bankAccount: '0011004567890' },
  { id: 'mem_3', name: 'Cường', active: true, bankName: 'Vietinbank', bankAccount: '101876543210' },
  { id: 'mem_4', name: 'Dũng', active: true, bankName: 'Vietcombank', bankAccount: '0451000333222' }
];

export const INITIAL_EXPENSES = [
  {
    id: 'exp_init_1',
    rev: 1,
    type: 'expense',
    title: 'Ăn trưa quán gà lá é',
    payerId: 'mem_1',
    amount: 120000,
    splitMethod: 'equal',
    participants: ['mem_1', 'mem_2', 'mem_3', 'mem_4'],
    timestamp: '2026-10-21T07:00:00+07:00',
    deleted: false
  },
  {
    id: 'exp_init_2',
    rev: 1,
    type: 'expense',
    title: 'Thuê xe máy 2 ngày',
    payerId: 'mem_2',
    amount: 300000,
    splitMethod: 'shares',
    participants: [
      { memberId: 'mem_1', weight: 1 },
      { memberId: 'mem_2', weight: 1 },
      { memberId: 'mem_3', weight: 2 },
      { memberId: 'mem_4', weight: 2 }
    ],
    timestamp: '2026-10-21T07:30:00+07:00',
    deleted: false
  }
];

class StateStore {
  constructor() {
    this.tripId = 'default_trip';
    this.tripName = 'Chuyến đi Đà Lạt 2026';
    this.status = 'ACTIVE'; // 'ACTIVE' | 'COMPLETE'
    this.activeTab = 'expenses'; // 'expenses' | 'debts'
    this.currentMemberId = null; // Khởi tạo, sẽ đọc từ localStorage
    this.isAddModalOpen = false;
    this.isSettingsModalOpen = false;

    // Sync metadata & Outbox state
    this.syncStatus = SYNC_STATUS.IDLE;
    this.pendingOpsCount = 0;
    this.conflicts = [];
    this.serverRevision = 0;
    this.lastSyncTime = null;
    this.isInstallable = false;
    this.isInitialized = false;

    // In-memory data collections (khởi tạo với seed ban đầu để synchronous unit tests chạy ngay)
    this.members = JSON.parse(JSON.stringify(INITIAL_MEMBERS));
    this.expenses = JSON.parse(JSON.stringify(INITIAL_EXPENSES));
    this.settlements = [];

    // Cached calculation results
    this.calculation = null;
    this.greedyDebts = [];

    // Listeners for reactive updates
    this.listeners = new Set();

    // Khởi tạo tính toán ban đầu
    this._recompute();
  }

  // Khởi tạo async từ IndexedDB & localStorage
  async init() {
    if (this.isInitialized) return;

    // 1. Phục hồi currentMemberId từ localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        const savedId = localStorage.getItem('tdytrip_my_member_id');
        if (savedId) this.currentMemberId = savedId;
      } catch (e) {
        console.warn('Cannot read localStorage:', e);
      }
    }

    // 2. Tải snapshot từ IndexedDB
    try {
      const snapshot = await getSnapshot(this.tripId);
      if (snapshot) {
        this.tripName = snapshot.tripName || this.tripName;
        this.status = snapshot.status || 'ACTIVE';
        this.members = snapshot.members || [];
        this.expenses = snapshot.expenses || [];
        this.settlements = snapshot.settlements || [];
      } else {
        // Lưu seed ban đầu vào IndexedDB
        await saveSnapshot(this.toSnapshot());
      }
    } catch (dbErr) {
      console.warn('IndexedDB read snapshot error, using in-memory seed:', dbErr);
    }

    // 3. Tải sync metadata & trạng thái outbox
    await this._refreshSyncState();

    // 4. Lắng nghe thay đổi từ Sync Engine
    syncEngine.subscribe(async () => {
      await this.reloadFromStorage();
    });

    this.isInitialized = true;
    this._recompute();
    this._notify();
  }

  async _refreshSyncState() {
    try {
      this.syncStatus = (await getMeta('syncStatus')) || SYNC_STATUS.IDLE;
      this.serverRevision = (await getMeta('serverRevision')) || 0;
      this.lastSyncTime = await getMeta('lastSyncTime');
      this.pendingOpsCount = await outbox.getPendingCount();
      this.conflicts = await outbox.getConflicts();
    } catch (e) {
      console.warn('Error refreshing sync state:', e);
    }
  }

  toSnapshot() {
    return {
      tripId: this.tripId,
      tripName: this.tripName,
      status: this.status,
      members: this.members,
      expenses: this.expenses,
      settlements: this.settlements,
      calculation: this.calculation,
      greedyDebts: this.greedyDebts,
      updatedAt: new Date().toISOString()
    };
  }

  // Tải lại snapshot từ storage (sau khi Pull Delta hoặc Push Batch)
  async reloadFromStorage() {
    try {
      const snapshot = await getSnapshot(this.tripId);
      if (snapshot) {
        this.tripName = snapshot.tripName || this.tripName;
        this.status = snapshot.status || 'ACTIVE';
        this.members = snapshot.members || [];
        this.expenses = snapshot.expenses || [];
        this.settlements = snapshot.settlements || [];
      }
      await this._refreshSyncState();
      this._recompute();
      this._notify();
    } catch (err) {
      console.error('Error reloading from storage:', err);
    }
  }

  // Đăng ký listener cập nhật giao diện
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) {
      try {
        fn(this);
      } catch (err) {
        console.error('Error in state subscriber:', err);
      }
    }
  }

  // Tự động tính toán lại với core math
  _recompute() {
    try {
      this.calculation = calculateBalances(this.members, this.expenses, this.settlements);
      this.greedyDebts = simplifyDebts(this.calculation.balances);
    } catch (err) {
      console.error('Math calculation error:', err);
      throw err;
    }
  }

  // Async persistence & queueing
  async _persistAndQueue(type, payload, expectedRev = null) {
    try {
      await saveSnapshot(this.toSnapshot());
      await outbox.enqueue(type, payload, expectedRev);
      await this._refreshSyncState();
      this._notify();

      // Kích hoạt sync nền nếu có cấu hình
      if (typeof navigator === 'undefined' || navigator.onLine) {
        syncEngine.sync().catch(err => console.warn('Background sync error:', err));
      }
    } catch (err) {
      console.error('Failed to persist & queue op:', err);
    }
  }

  // Chuyển tab
  setActiveTab(tab) {
    if (this.activeTab !== tab) {
      this.activeTab = tab;
      this._notify();
    }
  }

  // Đặt "Tôi là ai" & lưu vào localStorage
  setCurrentMember(memberId) {
    this.currentMemberId = memberId || null;
    if (typeof localStorage !== 'undefined') {
      try {
        if (this.currentMemberId) {
          localStorage.setItem('tdytrip_my_member_id', this.currentMemberId);
        } else {
          localStorage.removeItem('tdytrip_my_member_id');
        }
      } catch (e) {
        console.warn('Cannot write localStorage:', e);
      }
    }
    this._notify();
  }

  // Đóng/Mở Modals
  setAddModalOpen(isOpen) {
    this.isAddModalOpen = Boolean(isOpen);
    this._notify();
  }

  setSettingsModalOpen(isOpen) {
    this.isSettingsModalOpen = Boolean(isOpen);
    this._notify();
  }

  setInstallable(bool) {
    this.isInstallable = Boolean(bool);
    this._notify();
  }

  // Thêm khoản chi tiêu mới
  addExpense({ title, amount, payerId, splitMethod, participants }) {
    if (this.status === 'COMPLETE') {
      throw new Error('Chuyến đi đã khóa (Chế độ chỉ đọc)');
    }

    const newId = `exp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const newExpense = {
      id: newId,
      rev: 1,
      type: 'expense',
      title: title?.trim() || 'Khoản chi không tên',
      payerId,
      amount: Number(amount),
      splitMethod,
      participants,
      timestamp: new Date().toISOString().replace('Z', '+07:00'),
      deleted: false
    };

    // Kiểm tra tính hợp lệ trước khi ghi
    validateExpenseInput(newExpense, this.members);

    this.expenses.push(newExpense);
    this._recompute();
    this.isAddModalOpen = false;
    this._notify();

    // Ghi vào IndexedDB và outbox
    this._persistAndQueue('EXPENSE_CREATE', newExpense, null);

    return newExpense;
  }

  // Xóa khoản chi tiêu (đánh dấu deleted: true, không purge khỏi DB)
  deleteExpense(id) {
    if (this.status === 'COMPLETE') {
      return false;
    }

    const exp = this.expenses.find(e => e.id === id);
    if (!exp || exp.deleted) return false;

    const expectedRev = exp.rev;
    exp.deleted = true;
    exp.rev += 1;
    this._recompute();
    this._notify();

    this._persistAndQueue('EXPENSE_DELETE', { id }, expectedRev);
    return true;
  }

  // Ghi nhận thanh toán quyết toán nợ ("Đã trả")
  addSettlement({ senderId, receiverId, amount }) {
    if (this.status === 'COMPLETE') {
      throw new Error('Chuyến đi đã khóa (Chế độ chỉ đọc)');
    }

    const newId = `set_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const newSettlement = {
      id: newId,
      rev: 1,
      type: 'settlement',
      senderId,
      receiverId,
      amount: Number(amount),
      timestamp: new Date().toISOString().replace('Z', '+07:00'),
      deleted: false
    };

    validateSettlementInput(newSettlement, this.members);

    this.settlements.push(newSettlement);
    this._recompute();
    this._notify();

    this._persistAndQueue('SETTLEMENT_CREATE', newSettlement, null);
    return newSettlement;
  }

  // Thêm thành viên mới
  addMember({ name, bankName = '', bankAccount = '' }) {
    if (this.status === 'COMPLETE') {
      throw new Error('Chuyến đi đã khóa (Chế độ chỉ đọc)');
    }

    const trimmedName = name?.trim();
    if (!trimmedName) {
      throw new TypeError('Tên thành viên không được để trống');
    }

    const newId = `mem_${this.members.length + 1}_${Math.random().toString(36).substr(2, 4)}`;
    const newMember = {
      id: newId,
      name: trimmedName,
      active: true,
      bankName: bankName.trim(),
      bankAccount: String(bankAccount).trim() // Luôn lưu dạng chuỗi để giữ số 0 đầu
    };

    this.members.push(newMember);
    this._recompute();
    this._notify();

    this._persistAndQueue('MEMBER_CREATE', newMember, null);
    return newMember;
  }

  // Cập nhật thông tin thành viên
  updateMember(id, updates) {
    if (this.status === 'COMPLETE') {
      return false;
    }

    const member = this.members.find(m => m.id === id);
    if (!member) return false;

    if (updates.name !== undefined) member.name = updates.name.trim();
    if (updates.bankName !== undefined) member.bankName = updates.bankName.trim();
    if (updates.bankAccount !== undefined) member.bankAccount = String(updates.bankAccount).trim();
    if (updates.active !== undefined) member.active = Boolean(updates.active);

    this._recompute();
    this._notify();

    this._persistAndQueue('MEMBER_UPDATE', { id, ...updates }, null);
    return true;
  }

  // Đổi trạng thái chuyến đi ('ACTIVE' | 'COMPLETE')
  setTripStatus(status) {
    if (status !== 'ACTIVE' && status !== 'COMPLETE') {
      throw new TypeError(`Invalid trip status: ${status}`);
    }
    this.status = status;
    this._notify();
    this._persistAndQueue('TRIP_COMPLETE', { status }, null);
    return true;
  }

  // Giải quyết xung đột từ UI
  async resolveConflict(opId, choice) {
    const result = await resolveConflictAction(opId, choice, this.tripId);
    await this.reloadFromStorage();
    return result;
  }
}

export const store = new StateStore();
