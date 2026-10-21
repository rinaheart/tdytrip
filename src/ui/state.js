/**
 * TdyTripPWA2026 - In-Memory Reactive State Store (Phase 2)
 * Quản lý toàn bộ trạng thái trong RAM JavaScript.
 * Kết nối trực tiếp với lõi toán học pure functional src/core/math.js.
 * Ranh giới: Không IndexedDB, không Service Worker, không LocalStorage.
 */

import {
  validateExpenseInput,
  validateSettlementInput,
  calculateBalances,
  simplifyDebts
} from '../core/math.js';

// Dữ liệu Seed mẫu ban đầu (phục vụ kiểm thử ngay cả 2 nhánh equal & shares)
const INITIAL_MEMBERS = [
  { id: 'mem_1', name: 'An', active: true, bankName: 'Techcombank', bankAccount: '19036789999011' },
  { id: 'mem_2', name: 'Bình', active: true, bankName: 'Vietcombank', bankAccount: '0011004567890' },
  { id: 'mem_3', name: 'Cường', active: true, bankName: 'Vietinbank', bankAccount: '101876543210' },
  { id: 'mem_4', name: 'Dũng', active: true, bankName: 'Vietcombank', bankAccount: '0451000333222' }
];

const INITIAL_EXPENSES = [
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
    this.tripName = 'Chuyến đi Đà Lạt 2026';
    this.activeTab = 'expenses'; // 'expenses' | 'debts'
    this.currentMemberId = null; // 'Tôi là ai' - reset về null khi refresh
    this.isAddModalOpen = false;
    this.isSettingsModalOpen = false;

    // In-memory data collections
    this.members = [...INITIAL_MEMBERS];
    this.expenses = [...INITIAL_EXPENSES];
    this.settlements = [];

    // Cached calculation results
    this.calculation = null;
    this.greedyDebts = [];

    // Listeners for reactive updates
    this.listeners = new Set();

    // Khởi tạo tính toán ban đầu
    this._recompute();
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

  // Chuyển tab
  setActiveTab(tab) {
    if (this.activeTab !== tab) {
      this.activeTab = tab;
      this._notify();
    }
  }

  // Đặt "Tôi là ai"
  setCurrentMember(memberId) {
    this.currentMemberId = memberId || null;
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

  // Thêm khoản chi tiêu mới
  addExpense({ title, amount, payerId, splitMethod, participants }) {
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
    return newExpense;
  }

  // Xóa khoản chi tiêu (đánh dấu deleted: true, không undo trong MVP)
  deleteExpense(id) {
    const exp = this.expenses.find(e => e.id === id);
    if (!exp) return false;

    exp.deleted = true;
    exp.rev += 1;
    this._recompute();
    this._notify();
    return true;
  }

  // Ghi nhận thanh toán quyết toán nợ ("Đã trả")
  // senderId = người nợ (from), receiverId = chủ nợ (to)
  addSettlement({ senderId, receiverId, amount }) {
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
    return newSettlement;
  }

  // Thêm thành viên mới
  addMember({ name, bankName = '', bankAccount = '' }) {
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
    return newMember;
  }

  // Cập nhật thông tin thành viên
  updateMember(id, updates) {
    const member = this.members.find(m => m.id === id);
    if (!member) return false;

    if (updates.name !== undefined) member.name = updates.name.trim();
    if (updates.bankName !== undefined) member.bankName = updates.bankName.trim();
    if (updates.bankAccount !== undefined) member.bankAccount = String(updates.bankAccount).trim();
    if (updates.active !== undefined) member.active = Boolean(updates.active);

    this._recompute();
    this._notify();
    return true;
  }
}

export const store = new StateStore();
