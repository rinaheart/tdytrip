/**
 * TdyTripPWA2026 - Main Application Orchestrator (Phase 2)
 * Điều phối sự kiện DOM, render App Shell và kết nối In-Memory State.
 * Ranh giới: Thuần in-memory, không IndexedDB, không SW, không LocalStorage.
 */

import { store } from './ui/state.js';
import {
  renderHeader,
  renderTabs,
  renderSummaryCard,
  renderIdentityBanner,
  renderExpenseList,
  renderDebtsView,
  renderAddExpenseModal,
  renderSettingsModal,
  showToast,
  copyToClipboard
} from './ui/components.js';

// Hàm Render toàn bộ App Shell
function renderApp() {
  const root = document.getElementById('app');
  if (!root) return;

  const html = `
    ${renderHeader(store)}
    ${renderTabs(store)}
    ${renderSummaryCard(store)}
    ${renderIdentityBanner(store)}

    <main id="tab-panel" class="tab-content" role="tabpanel" aria-labelledby="tab-btn-${store.activeTab}">
      ${store.activeTab === 'expenses' ? renderExpenseList(store) : renderDebtsView(store)}
    </main>

    ${renderAddExpenseModal(store)}
    ${renderSettingsModal(store)}
  `;

  root.innerHTML = html;
}

// Thiết lập Event Delegation trên root để quản lý sự kiện nhất quán
function setupEventDelegation() {
  const root = document.getElementById('app');
  if (!root) return;

  // 1. Click Events
  root.addEventListener('click', async (e) => {
    // Chuyển Tab Chi tiêu
    if (e.target.closest('#tab-btn-expenses')) {
      e.preventDefault();
      store.setActiveTab('expenses');
      return;
    }

    // Chuyển Tab Công nợ
    if (e.target.closest('#tab-btn-debts')) {
      e.preventDefault();
      store.setActiveTab('debts');
      return;
    }

    // Mở Modal Cài đặt
    if (e.target.closest('#btn-open-settings') || e.target.closest('#btn-select-identity')) {
      e.preventDefault();
      store.setSettingsModalOpen(true);
      return;
    }

    // Đóng Modal Cài đặt
    if (e.target.closest('#btn-close-settings-modal') || e.target.id === 'modal-settings-overlay') {
      e.preventDefault();
      store.setSettingsModalOpen(false);
      return;
    }

    // Mở Form Thêm Chi tiêu
    if (e.target.closest('#btn-open-add')) {
      e.preventDefault();
      store.setAddModalOpen(true);
      return;
    }

    // Đóng Form Thêm Chi tiêu
    if (e.target.closest('#btn-close-add-modal') || e.target.id === 'modal-add-expense-overlay') {
      e.preventDefault();
      store.setAddModalOpen(false);
      return;
    }

    // Xóa khoản chi tiêu (Native confirm)
    const deleteBtn = e.target.closest('.btn-delete-expense');
    if (deleteBtn) {
      e.preventDefault();
      const expId = deleteBtn.dataset.id;
      if (expId) {
        const confirmed = window.confirm('Bạn có chắc chắn muốn xóa khoản chi tiêu này?');
        if (confirmed) {
          store.deleteExpense(expId);
          showToast('Đã xóa khoản chi thành công');
        }
      }
      return;
    }

    // Nút 1: Copy chỉ số tài khoản (STK) duy nhất
    const copyStkBtn = e.target.closest('.btn-copy-stk');
    if (copyStkBtn) {
      e.preventDefault();
      const stk = copyStkBtn.dataset.stk;
      if (stk) {
        await copyToClipboard(stk, `Đã sao chép STK: ${stk}`);
      }
      return;
    }

    // Nút 2: Copy nội dung chuyển khoản đầy đủ
    const copyMsgBtn = e.target.closest('.btn-copy-msg');
    if (copyMsgBtn) {
      e.preventDefault();
      const msg = copyMsgBtn.dataset.msg;
      if (msg) {
        await copyToClipboard(msg, 'Đã sao chép nội dung chuyển khoản');
      }
      return;
    }

    // Nút Đã trả (Ghi nhận thanh toán Settlement)
    const settleBtn = e.target.closest('.btn-mark-settled');
    if (settleBtn) {
      e.preventDefault();
      const { from, to, amount } = settleBtn.dataset;
      if (from && to && amount) {
        try {
          store.addSettlement({
            senderId: from,
            receiverId: to,
            amount: Number(amount)
          });
          showToast('Đã ghi nhận thanh toán thành công!');
        } catch (err) {
          console.error('Lỗi ghi nhận thanh toán:', err);
          showToast('Không thể ghi nhận thanh toán');
        }
      }
      return;
    }
  });

  // 2. Change Events
  root.addEventListener('change', (e) => {
    // Chuyển đổi phương thức chia (Radio: equal vs shares)
    const splitRadio = e.target.closest('input[name="split_method"]');
    if (splitRadio) {
      const equalGroup = document.getElementById('group-equal-participants');
      const sharesGroup = document.getElementById('group-shares-participants');
      if (equalGroup && sharesGroup) {
        if (splitRadio.value === 'equal') {
          equalGroup.style.display = 'block';
          sharesGroup.style.display = 'none';
        } else {
          equalGroup.style.display = 'none';
          sharesGroup.style.display = 'block';
        }
      }
      return;
    }

    // Thay đổi "Tôi là ai"
    if (e.target.id === 'sel-identity') {
      const selectedId = e.target.value || null;
      store.setCurrentMember(selectedId);
      return;
    }
  });

  // 3. Submit Events
  root.addEventListener('submit', (e) => {
    // Form Thêm Khoản Chi Tiêu
    if (e.target.id === 'form-add-expense') {
      e.preventDefault();
      const errorBanner = document.getElementById('add-expense-error');
      const hideError = () => {
        if (errorBanner) {
          errorBanner.style.display = 'none';
          errorBanner.textContent = '';
        }
      };
      const showError = (msg) => {
        if (errorBanner) {
          errorBanner.style.display = 'block';
          errorBanner.textContent = msg;
        } else {
          alert(msg);
        }
      };

      try {
        hideError();
        const title = document.getElementById('inp-title')?.value?.trim();
        const amountRaw = document.getElementById('inp-amount')?.value;
        const payerId = document.getElementById('sel-payer')?.value;
        const splitMethodRadio = document.querySelector('input[name="split_method"]:checked');
        const splitMethod = splitMethodRadio ? splitMethodRadio.value : 'equal';

        // Pre-validation tại UI
        if (!title) {
          throw new TypeError('Vui lòng nhập mô tả khoản chi');
        }

        const amount = Number(amountRaw);
        if (!Number.isSafeInteger(amount) || amount <= 0) {
          throw new TypeError('Số tiền phải là số nguyên dương hợp lệ');
        }
        if (amount > 500_000_000) {
          throw new RangeError('Số tiền tối đa cho một khoản chi là 500.000.000 đ');
        }

        if (!payerId) {
          throw new TypeError('Vui lòng chọn người thanh toán');
        }

        let participants = [];
        if (splitMethod === 'equal') {
          const checked = Array.from(document.querySelectorAll('input[name="equal_participant"]:checked'));
          participants = checked.map(cb => cb.value);
          if (participants.length === 0) {
            throw new RangeError('Phải chọn ít nhất 1 người tham gia chia tiền');
          }
        } else if (splitMethod === 'shares') {
          const weightInputs = Array.from(document.querySelectorAll('.shares-weight-input'));
          for (const inp of weightInputs) {
            const memberId = inp.name.replace('weight_', '');
            const w = Number(inp.value);
            if (!Number.isSafeInteger(w) || w < 0 || w > 1000) {
              throw new RangeError(`Trọng số của thành viên phải từ 0 đến 1.000`);
            }
            if (w > 0) {
              participants.push({ memberId, weight: w });
            }
          }
          if (participants.length === 0) {
            throw new RangeError('Phải có ít nhất 1 người tham gia (trọng số > 0)');
          }
        }

        store.addExpense({
          title,
          amount,
          payerId,
          splitMethod,
          participants
        });

        showToast('Đã thêm khoản chi thành công!');
      } catch (err) {
        showError(err.message || 'Lỗi dữ liệu đầu vào');
      }
      return;
    }

    // Form Thêm Thành Viên Mới
    if (e.target.id === 'form-add-member') {
      e.preventDefault();
      try {
        const name = document.getElementById('inp-new-member-name')?.value?.trim();
        const bankName = document.getElementById('inp-new-member-bank')?.value?.trim() || '';
        const bankAccount = document.getElementById('inp-new-member-stk')?.value?.trim() || '';

        if (!name) {
          showToast('Vui lòng nhập tên thành viên');
          return;
        }

        store.addMember({ name, bankName, bankAccount });
        showToast(`Đã thêm thành viên: ${name}`);

        // Reset input form
        const nameInput = document.getElementById('inp-new-member-name');
        const bankInput = document.getElementById('inp-new-member-bank');
        const stkInput = document.getElementById('inp-new-member-stk');
        if (nameInput) nameInput.value = '';
        if (bankInput) bankInput.value = '';
        if (stkInput) stkInput.value = '';
      } catch (err) {
        showToast(err.message || 'Lỗi thêm thành viên');
      }
      return;
    }
  });
}

// Khởi tạo ứng dụng
function init() {
  // Lắng nghe thay đổi từ Reactive Store
  store.subscribe(() => {
    renderApp();
  });

  // Thiết lập delegation và render lần đầu
  setupEventDelegation();
  renderApp();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
