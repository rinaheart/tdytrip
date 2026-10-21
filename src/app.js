/**
 * TdyTripPWA2026 - Main Application Orchestrator (Phase 3)
 * Điều phối sự kiện DOM, render App Shell, quản lý Offline Storage (IndexedDB),
 * Sync Engine, Conflict Resolution và Hard Lock (TRIP_COMPLETE).
 */

import { store } from './ui/state.js';
import { syncEngine } from './sync/engine.js';
import {
  renderHeader,
  renderTabs,
  renderSummaryCard,
  renderIdentityBanner,
  renderExpenseList,
  renderDebtsView,
  renderAddExpenseModal,
  renderSettingsModal,
  renderOfflineBanner,
  renderTripLockedBanner,
  renderConflictBanner,
  showToast,
  copyToClipboard
} from './ui/components.js';

// Hàm Render toàn bộ App Shell
function renderApp() {
  const root = document.getElementById('app');
  if (!root) return;

  const html = `
    ${renderOfflineBanner(store)}
    ${renderTripLockedBanner(store)}
    ${renderConflictBanner(store)}
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

// Quản lý PWA Install Prompt
let deferredPrompt = null;

// Thiết lập Event Delegation trên root để quản lý sự kiện nhất quán
function setupEventDelegation() {
  const root = document.getElementById('app');
  if (!root) return;

  // 1. Click Events
  root.addEventListener('click', async (e) => {
    // Cài đặt PWA
    if (e.target.closest('#btn-install-pwa')) {
      e.preventDefault();
      if (deferredPrompt) {
        deferredPrompt.prompt();
        try {
          const choice = await deferredPrompt.userChoice;
          if (choice.outcome === 'accepted') {
            showToast('Đang tiến hành cài đặt ứng dụng...');
          }
        } finally {
          deferredPrompt = null;
          store.setInstallable(false);
        }
      }
      return;
    }

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

    // Khóa / Mở lại chuyến đi (Hard Lock)
    if (e.target.closest('#btn-toggle-trip-status')) {
      e.preventDefault();
      const newStatus = store.status === 'COMPLETE' ? 'ACTIVE' : 'COMPLETE';
      store.setTripStatus(newStatus);
      showToast(newStatus === 'COMPLETE' ? 'Đã khóa chuyến đi (Chế độ chỉ đọc)' : 'Đã mở lại chuyến đi');
      return;
    }

    // Mở Form Thêm Chi tiêu
    if (e.target.closest('#btn-open-add')) {
      e.preventDefault();
      if (store.status === 'COMPLETE') {
        showToast('Chuyến đi đã khóa. Không thể thêm khoản chi mới.');
        return;
      }
      store.setAddModalOpen(true);
      return;
    }

    // Đóng Form Thêm Chi tiêu
    if (e.target.closest('#btn-close-add-modal') || e.target.id === 'modal-add-expense-overlay') {
      e.preventDefault();
      store.setAddModalOpen(false);
      return;
    }

    // Xử lý nút phân giải xung đột (Conflict Resolution Buttons)
    const conflictBtn = e.target.closest('.btn-conflict-action');
    if (conflictBtn) {
      e.preventDefault();
      const opId = conflictBtn.dataset.opId;
      const action = conflictBtn.dataset.action;
      if (opId && action) {
        try {
          await store.resolveConflict(opId, action);
          showToast('Đã giải quyết xung đột thành công!');
        } catch (err) {
          console.error('Lỗi giải quyết xung đột:', err);
          showToast('Không thể giải quyết xung đột');
        }
      }
      return;
    }

    // Xóa khoản chi tiêu (Native confirm)
    const deleteBtn = e.target.closest('.btn-delete-expense');
    if (deleteBtn) {
      e.preventDefault();
      if (store.status === 'COMPLETE') {
        showToast('Chuyến đi đã khóa. Không thể xóa.');
        return;
      }
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
      if (store.status === 'COMPLETE') {
        showToast('Chuyến đi đã khóa. Không thể ghi nhận thanh toán.');
        return;
      }
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
        const titleInput = document.getElementById('inp-title');
        const amountInput = document.getElementById('inp-amount');
        const payerSelect = document.getElementById('sel-payer');
        const splitMethodRadio = document.querySelector('input[name="split_method"]:checked');

        const title = titleInput?.value?.trim();
        const amount = Number(amountInput?.value);
        const payerId = payerSelect?.value;
        const splitMethod = splitMethodRadio?.value || 'equal';

        let participants = [];

        if (splitMethod === 'equal') {
          const checkedBoxes = document.querySelectorAll('input[name="equal_participant"]:checked');
          participants = Array.from(checkedBoxes).map(cb => cb.value);
        } else {
          const weightInputs = document.querySelectorAll('.shares-weight-input');
          participants = Array.from(weightInputs)
            .map(inp => {
              const memberId = inp.name.replace('weight_', '');
              const weight = Number(inp.value) || 0;
              return { memberId, weight };
            })
            .filter(p => p.weight > 0);
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
        showError(err.message || 'Dữ liệu khoản chi không hợp lệ');
      }
      return;
    }

    // Form Thêm Thành Viên Mới
    if (e.target.id === 'form-add-member') {
      e.preventDefault();
      try {
        const name = document.getElementById('inp-new-member-name')?.value?.trim();
        const bankName = document.getElementById('inp-new-member-bank')?.value?.trim();
        const bankAccount = document.getElementById('inp-new-member-stk')?.value?.trim();

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
async function init() {
  // Lắng nghe thay đổi từ Reactive Store
  store.subscribe(() => {
    renderApp();
  });

  // Thiết lập delegation và render lần đầu
  setupEventDelegation();

  // Khởi tạo IndexedDB snapshot & localStorage
  await store.init();

  // Khởi động Sync Loop trong nền
  syncEngine.start().catch(err => {
    console.warn('Sync engine start note:', err);
  });

  // Đăng ký Service Worker cho PWA
  registerServiceWorker();

  // Lắng nghe sự kiện trước khi hiển thị hộp thoại cài đặt PWA
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    store.setInstallable(true);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    store.setInstallable(false);
    showToast('Ứng dụng TdyTrip đã được cài đặt thành công 🎉');
  });

  // Lắng nghe trạng thái mạng
  window.addEventListener('online', () => {
    showToast('Đã kết nối lại mạng 🟢');
    renderApp();
  });
  window.addEventListener('offline', () => {
    showToast('Đang ngoại tuyến — Dữ liệu lưu an toàn trên máy ✈️');
    renderApp();
  });

  renderApp();
}

function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  const isSecure = window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (!isSecure) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => {
        console.log('[PWA] Service Worker đăng ký thành công với scope:', reg.scope);
        reg.onupdatefound = () => {
          const installingWorker = reg.installing;
          if (installingWorker) {
            installingWorker.onstatechange = () => {
              if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                showToast('Đã có bản cập nhật mới. Tải lại trang để áp dụng.');
              }
            };
          }
        };
      })
      .catch((err) => {
        console.warn('[PWA] Đăng ký Service Worker thất bại:', err);
      });
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
