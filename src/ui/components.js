/**
 * TdyTripPWA2026 - UI Component Renderers (Phase 2)
 * Vanilla HTML template string rendering.
 * Đảm bảo accessibility: role="tablist", role="tab", aria-label.
 * Cung cấp tiện ích clipboard copy và toast notification có clearTimeout.
 */

// Format VND số nguyên với tabular-nums
export function formatVND(amount) {
  if (typeof amount !== 'number' || isNaN(amount)) return '0 đ';
  return `${amount.toLocaleString('vi-VN')} đ`;
}

// Quản lý Toast Notification với clearTimeout an toàn
let toastTimeoutId = null;

export function showToast(message) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  // Clear timeout trước đó để tránh tắt sớm
  if (toastTimeoutId) {
    clearTimeout(toastTimeoutId);
    toastTimeoutId = null;
  }

  container.innerHTML = `<div class="toast" role="status" aria-live="polite">${escapeHTML(message)}</div>`;

  toastTimeoutId = setTimeout(() => {
    container.innerHTML = '';
    toastTimeoutId = null;
  }, 2000);
}

// Sao chép văn bản vào clipboard với fallback an toàn
export async function copyToClipboard(text, successMsg = 'Đã sao chép vào clipboard') {
  if (!text) {
    showToast('Không có nội dung để sao chép');
    return false;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      showToast(successMsg);
      return true;
    }
  } catch (err) {
    console.warn('Clipboard API blocked, using fallback textarea...', err);
  }

  // Fallback qua input ẩn
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textarea);

    if (successful) {
      showToast(successMsg);
      return true;
    }
  } catch (fallbackErr) {
    console.error('Fallback copy failed:', fallbackErr);
  }

  showToast('Không thể sao chép tự động. Vui lòng thử lại!');
  return false;
}

// Tiện ích escape HTML chống XSS
export function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// -------------------------------------------------------------
// Component Renderers
// -------------------------------------------------------------

export function renderHeader(state) {
  return `
    <header class="app-header">
      <div class="header-title-group">
        <h1>${escapeHTML(state.tripName)}</h1>
        <div class="trip-meta">${state.members.length} thành viên • In-Memory MVP</div>
      </div>
      <div class="header-actions">
        <button id="btn-open-settings" class="btn-icon" aria-label="Cài đặt chuyến đi và thành viên">
          ⚙️
        </button>
      </div>
    </header>
  `;
}

export function renderTabs(state) {
  return `
    <nav class="tab-nav" role="tablist" aria-label="Điều hướng chính">
      <button 
        id="tab-btn-expenses" 
        class="tab-btn" 
        role="tab" 
        aria-selected="${state.activeTab === 'expenses'}"
        aria-controls="panel-expenses"
      >
        <span>💸</span> Chi tiêu (${state.expenses.filter(e => !e.deleted).length})
      </button>
      <button 
        id="tab-btn-debts" 
        class="tab-btn" 
        role="tab" 
        aria-selected="${state.activeTab === 'debts'}"
        aria-controls="panel-debts"
      >
        <span>🤝</span> Công nợ (${state.greedyDebts.length})
      </button>
    </nav>
  `;
}

export function renderSummaryCard(state) {
  const total = state.calculation?.totalTripExpense || 0;
  return `
    <div class="summary-card">
      <div>
        <div class="summary-label">Tổng chi phí chuyến đi</div>
        <div class="summary-value num">${formatVND(total)}</div>
      </div>
    </div>
  `;
}

export function renderIdentityBanner(state) {
  const currentMember = state.members.find(m => m.id === state.currentMemberId);
  if (!currentMember) {
    return `
      <div class="identity-banner">
        <span>Chưa chọn danh tính người dùng</span>
        <button id="btn-select-identity" class="badge" style="cursor: pointer; background: transparent;">
          Chọn "Tôi là ai" ⟶
        </button>
      </div>
    `;
  }

  const myBalance = state.calculation?.balances[currentMember.id] || 0;
  let balanceText = 'Đã hòa';
  if (myBalance > 0) balanceText = `Được nhận lại ${formatVND(myBalance)}`;
  else if (myBalance < 0) balanceText = `Cần trả ${formatVND(Math.abs(myBalance))}`;

  return `
    <div class="identity-banner">
      <span>Đang xem với tư cách: <strong>${escapeHTML(currentMember.name)}</strong></span>
      <span class="num" style="font-weight: 700;">${balanceText}</span>
    </div>
  `;
}

export function renderExpenseList(state) {
  const activeExpenses = state.expenses.filter(e => !e.deleted);
  const memberMap = new Map(state.members.map(m => [m.id, m]));

  if (activeExpenses.length === 0) {
    return `
      <div style="text-align: center; padding: 40px 16px; color: var(--text-muted);">
        Chưa có khoản chi nào. Bấm nút bên dưới để thêm khoản chi đầu tiên!
      </div>
      <button id="btn-open-add" class="btn-primary" aria-label="Thêm khoản chi mới">+ Thêm khoản chi</button>
    `;
  }

  const itemsHTML = activeExpenses.map(exp => {
    const payer = memberMap.get(exp.payerId);
    const payerName = payer ? payer.name : exp.payerId;
    const splitLabel = exp.splitMethod === 'shares' ? 'Theo phần' : 'Chia đều';

    return `
      <div class="expense-card" data-expense-id="${escapeHTML(exp.id)}">
        <div class="expense-card-top">
          <div class="expense-title">${escapeHTML(exp.title)}</div>
          <div class="expense-amount num">${formatVND(exp.amount)}</div>
        </div>
        <div class="expense-card-meta">
          <div class="expense-tags">
            <span class="badge badge-payer">${escapeHTML(payerName)} trả</span>
            <span class="badge">${splitLabel} (${exp.participants.length} ng)</span>
          </div>
          <button class="btn-delete btn-delete-expense" data-id="${escapeHTML(exp.id)}" aria-label="Xóa khoản chi ${escapeHTML(exp.title)}">
            Xóa
          </button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="expense-list">${itemsHTML}</div>
    <button id="btn-open-add" class="btn-primary" aria-label="Thêm khoản chi mới">+ Thêm khoản chi</button>
  `;
}

export function renderDebtsView(state) {
  const memberMap = new Map(state.members.map(m => [m.id, m]));
  const balances = state.calculation?.balances || {};

  // 1. Grid số dư từng người
  const balanceGridHTML = state.members.map(m => {
    const bal = balances[m.id] || 0;
    let cls = 'zero';
    let prefix = '';
    if (bal > 0) {
      cls = 'positive';
      prefix = '+';
    } else if (bal < 0) {
      cls = 'negative';
      prefix = '';
    }

    const isMe = m.id === state.currentMemberId;

    return `
      <div class="balance-item ${isMe ? 'is-me' : ''}">
        <div class="balance-name">${escapeHTML(m.name)} ${isMe ? '(Tôi)' : ''}</div>
        <div class="balance-val ${cls} num">${prefix}${formatVND(bal)}</div>
      </div>
    `;
  }).join('');

  // 2. Danh sách giao dịch trả nợ tối ưu Greedy
  let debtsHTML = '';
  if (state.greedyDebts.length === 0) {
    debtsHTML = `
      <div style="text-align: center; padding: 24px; color: var(--success); font-weight: 600;">
        🎉 Mọi người đều đã hoàn tất công nợ! Không còn khoản nợ nào cần thanh toán.
      </div>
    `;
  } else {
    debtsHTML = state.greedyDebts.map(debt => {
      const debtor = memberMap.get(debt.from);
      const creditor = memberMap.get(debt.to);

      const debtorName = debtor ? debtor.name : debt.from;
      const creditorName = creditor ? creditor.name : debt.to;
      const bankAcc = creditor?.bankAccount || '';
      const bankName = creditor?.bankName || '';

      const isMyDebt = state.currentMemberId === debt.from;
      const isMyCredit = state.currentMemberId === debt.to;

      let cardClass = '';
      if (isMyDebt) cardClass = 'is-my-debt';
      else if (isMyCredit) cardClass = 'is-my-credit';

      const fullTransferMsg = `[TdyTrip] ${debtorName} chuyen ${creditorName} ${debt.amount}d`;

      return `
        <div class="settlement-card ${cardClass}" data-from="${escapeHTML(debt.from)}" data-to="${escapeHTML(debt.to)}" data-amount="${debt.amount}">
          <div class="settlement-flow">
            <div class="settlement-parties">
              ${escapeHTML(debtorName)} <span class="arrow">⟶</span> ${escapeHTML(creditorName)}
            </div>
            <div class="settlement-amount num">${formatVND(debt.amount)}</div>
          </div>

          ${bankAcc ? `
            <div class="settlement-bank-info">
              <span>🏦 ${escapeHTML(bankName || 'Ngân hàng')}: <strong class="num">${escapeHTML(bankAcc)}</strong></span>
            </div>
          ` : ''}

          <div class="settlement-actions">
            ${bankAcc ? `
              <button 
                class="btn-secondary btn-copy-stk" 
                data-stk="${escapeHTML(bankAcc)}" 
                aria-label="Sao chép số tài khoản của ${escapeHTML(creditorName)}"
              >
                📋 Copy STK
              </button>
            ` : ''}
            <button 
              class="btn-secondary btn-copy-msg" 
              data-msg="${escapeHTML(fullTransferMsg)}" 
              aria-label="Sao chép nội dung chuyển khoản cho ${escapeHTML(creditorName)}"
            >
              💬 Copy nội dung CK
            </button>
            <button 
              class="btn-secondary btn-settle btn-mark-settled" 
              data-from="${escapeHTML(debt.from)}" 
              data-to="${escapeHTML(debt.to)}" 
              data-amount="${debt.amount}"
              aria-label="Xác nhận đã thanh toán ${formatVND(debt.amount)}"
            >
              ✓ Đã trả
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  return `
    <div class="section-title">Số dư ròng các thành viên</div>
    <div class="balance-grid">${balanceGridHTML}</div>

    <div class="section-title">Gợi ý trả nợ tối ưu (Greedy)</div>
    <div class="settlement-list">${debtsHTML}</div>
  `;
}

// Modal Form Thêm Chi Tiêu
export function renderAddExpenseModal(state) {
  if (!state.isAddModalOpen) return '';

  const memberOptions = state.members
    .filter(m => m.active)
    .map(m => `<option value="${escapeHTML(m.id)}">${escapeHTML(m.name)}</option>`)
    .join('');

  const participantCheckboxes = state.members
    .filter(m => m.active)
    .map(m => `
      <label class="participant-row">
        <span>${escapeHTML(m.name)}</span>
        <input type="checkbox" name="equal_participant" value="${escapeHTML(m.id)}" checked />
      </label>
    `).join('');

  const participantSharesRows = state.members
    .filter(m => m.active)
    .map(m => `
      <div class="participant-row">
        <span>${escapeHTML(m.name)}</span>
        <div style="display: flex; align-items: center; gap: 4px;">
          <input 
            type="number" 
            class="shares-weight-input num" 
            name="weight_${escapeHTML(m.id)}" 
            value="1" 
            min="0" 
            max="1000" 
          />
          <span style="font-size: 0.75rem; color: var(--text-muted);">phần</span>
        </div>
      </div>
    `).join('');

  return `
    <div class="modal-overlay" id="modal-add-expense-overlay">
      <div class="modal-content" role="dialog" aria-labelledby="modal-add-title">
        <div class="modal-header">
          <div class="modal-title" id="modal-add-title">Thêm Khoản Chi Tiêu</div>
          <button id="btn-close-add-modal" class="btn-icon" aria-label="Đóng form">✕</button>
        </div>
        <form id="form-add-expense" class="modal-body">
          <div id="add-expense-error" class="error-banner" style="display: none;"></div>

          <div class="form-group">
            <label class="form-label" for="inp-title">Mô tả khoản chi</label>
            <input type="text" id="inp-title" class="form-input" placeholder="Ví dụ: Ăn tối hải sản" required />
          </div>

          <div class="form-group">
            <label class="form-label" for="inp-amount">Số tiền (VND, tối đa 500.000.000 đ)</label>
            <input 
              type="number" 
              id="inp-amount" 
              class="form-input num" 
              placeholder="100000" 
              min="1" 
              max="500000000" 
              required 
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="sel-payer">Người thanh toán</label>
            <select id="sel-payer" class="form-select">
              ${memberOptions}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">Phương thức chia</label>
            <div style="display: flex; gap: 12px; margin-bottom: 6px;">
              <label style="display: flex; align-items: center; gap: 4px; font-size: 0.9rem; cursor: pointer;">
                <input type="radio" name="split_method" value="equal" checked /> Chia đều
              </label>
              <label style="display: flex; align-items: center; gap: 4px; font-size: 0.9rem; cursor: pointer;">
                <input type="radio" name="split_method" value="shares" /> Chia theo phần
              </label>
            </div>
          </div>

          <div class="form-group" id="group-equal-participants">
            <label class="form-label">Người tham gia thụ hưởng</label>
            <div class="participant-checkbox-list">
              ${participantCheckboxes}
            </div>
          </div>

          <div class="form-group" id="group-shares-participants" style="display: none;">
            <label class="form-label">Nhập trọng số phần chia (1 đến 1.000, nhập 0 nếu không tham gia)</label>
            <div class="participant-shares-list">
              ${participantSharesRows}
            </div>
          </div>

          <button type="submit" class="btn-primary" style="margin-top: 8px;">
            Lưu khoản chi
          </button>
        </form>
      </div>
    </div>
  `;
}

// Modal Cài Đặt & Quản Lý Thành Viên
export function renderSettingsModal(state) {
  if (!state.isSettingsModalOpen) return '';

  const memberRowsHTML = state.members.map(m => `
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm);">
      <div>
        <div style="font-weight: 600; font-size: 0.9rem;">${escapeHTML(m.name)}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted);">
          ${escapeHTML(m.bankName || 'Chưa nhập ngân hàng')}: ${escapeHTML(m.bankAccount || 'Chưa có STK')}
        </div>
      </div>
      <div>
        <span class="badge ${m.active ? 'badge-payer' : ''}">${m.active ? 'Đang tham gia' : 'Nghỉ'}</span>
      </div>
    </div>
  `).join('');

  const identityOptions = state.members.map(m => `
    <option value="${escapeHTML(m.id)}" ${state.currentMemberId === m.id ? 'selected' : ''}>
      ${escapeHTML(m.name)}
    </option>
  `).join('');

  return `
    <div class="modal-overlay" id="modal-settings-overlay">
      <div class="modal-content" role="dialog" aria-labelledby="modal-settings-title">
        <div class="modal-header">
          <div class="modal-title" id="modal-settings-title">Cài Đặt Chuyến Đi</div>
          <button id="btn-close-settings-modal" class="btn-icon" aria-label="Đóng cài đặt">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label" for="sel-identity">Chọn "Tôi là ai" (làm nổi bật nợ của tôi)</label>
            <select id="sel-identity" class="form-select">
              <option value="">-- Không chọn (xem toàn bộ) --</option>
              ${identityOptions}
            </select>
            <span style="font-size: 0.72rem; color: var(--text-muted);">Lưu in-memory, reset khi refresh trang</span>
          </div>

          <div class="section-title" style="margin-top: 8px;">Danh sách thành viên</div>
          <div style="display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto;">
            ${memberRowsHTML}
          </div>

          <form id="form-add-member" style="margin-top: 12px; display: flex; flex-direction: column; gap: 8px;">
            <div class="form-label">Thêm thành viên mới</div>
            <input type="text" id="inp-new-member-name" class="form-input" placeholder="Tên thành viên" required />
            <input type="text" id="inp-new-member-bank" class="form-input" placeholder="Tên ngân hàng (ví dụ: VCB, MB)" />
            <input type="text" id="inp-new-member-stk" class="form-input num" placeholder="Số tài khoản (STK)" />
            <button type="submit" class="btn-secondary" style="min-height: 40px; margin-top: 4px;">+ Thêm thành viên</button>
          </form>
        </div>
      </div>
    </div>
  `;
}
