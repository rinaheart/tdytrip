/**
 * TdyTripPWA2026 - Core Math Engine
 * Module tính toán độc lập, thuần khiết (pure functional), zero-dependency.
 * Tuân thủ chuẩn Vanilla ES2020 ES Modules.
 */

export const MAX_AMOUNT = 500_000_000; // 500M VND
export const MIN_AMOUNT = 1;
export const MAX_PARTICIPANTS = 50;
export const MIN_PARTICIPANTS = 1;
export const MIN_WEIGHT = 1;
export const MAX_WEIGHT = 1000;
export const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?\+07:00$/;

/**
 * So sánh chuỗi memberId theo mã UTF-16 code unit xác định (không dùng localeCompare)
 * @param {string} idA
 * @param {string} idB
 * @returns {number} -1 nếu idA < idB, 1 nếu idA > idB, 0 nếu bằng nhau
 */
export function compareMemberId(idA, idB) {
  if (typeof idA !== 'string' || typeof idB !== 'string') {
    throw new TypeError('memberId must be string');
  }
  return idA < idB ? -1 : (idA > idB ? 1 : 0);
}

/**
 * Kiểm tra số nguyên an toàn trong đoạn [min, max]
 * @param {any} val
 * @param {string} fieldName
 * @param {number} min
 * @param {number} max
 */
export function validateSafeInteger(val, fieldName, min, max) {
  if (typeof val !== 'number' || !Number.isSafeInteger(val)) {
    throw new TypeError(`${fieldName} must be a safe integer`);
  }
  if (val < min || val > max) {
    throw new RangeError(`${fieldName} must be between ${min} and ${max}`);
  }
}

/**
 * Xác thực dữ liệu đầu vào của một khoản chi tiêu (Expense)
 * @param {object} expense
 * @param {Array<{id: string, name?: string, active?: boolean}>} members
 */
export function validateExpenseInput(expense, members) {
  if (!expense || typeof expense !== 'object') {
    throw new TypeError('Expense must be an object');
  }
  if (typeof expense.id !== 'string' || expense.id.trim() === '') {
    throw new TypeError('Expense id must be a non-empty string');
  }
  validateSafeInteger(expense.rev, 'Expense rev', 1, Number.MAX_SAFE_INTEGER);
  if (typeof expense.timestamp !== 'string' || !ISO_TIMESTAMP_REGEX.test(expense.timestamp)) {
    throw new TypeError('Expense timestamp must match ISO 8601 with +07:00 offset');
  }
  validateSafeInteger(expense.amount, 'Expense amount', MIN_AMOUNT, MAX_AMOUNT);

  if (expense.splitMethod !== 'equal' && expense.splitMethod !== 'shares') {
    throw new TypeError(
      `Invalid splitMethod "${expense.splitMethod}". Must be "equal" or "shares"`
    );
  }

  if (!Array.isArray(members) || members.length === 0) {
    throw new TypeError('Members must be a non-empty array');
  }
  const memberSet = new Set(members.map(m => m.id));

  if (typeof expense.payerId !== 'string' || !memberSet.has(expense.payerId)) {
    throw new TypeError(`payerId "${expense.payerId}" does not exist in members`);
  }

  if (!Array.isArray(expense.participants) || expense.participants.length === 0) {
    throw new RangeError('Expense participants must be a non-empty array');
  }
  if (expense.participants.length > MAX_PARTICIPANTS) {
    throw new RangeError(`Expense participants cannot exceed ${MAX_PARTICIPANTS}`);
  }

  const seenParticipants = new Set();
  for (const p of expense.participants) {
    const memberId = typeof p === 'string' ? p : p?.memberId;
    if (typeof memberId !== 'string' || !memberSet.has(memberId)) {
      throw new TypeError(`Participant memberId "${memberId}" does not exist in members`);
    }
    if (seenParticipants.has(memberId)) {
      throw new TypeError(`Duplicate participant memberId "${memberId}" in expense`);
    }
    seenParticipants.add(memberId);

    if (expense.splitMethod === 'shares') {
      if (typeof p !== 'object' || p === null) {
        throw new TypeError('Shares participant must be an object with weight');
      }
      validateSafeInteger(p.weight, `Participant ${memberId} weight`, MIN_WEIGHT, MAX_WEIGHT);
    }
  }
}

/**
 * Xác thực dữ liệu đầu vào của một giao dịch quyết toán (Settlement)
 * @param {object} settlement
 * @param {Array<{id: string, name?: string, active?: boolean}>} members
 */
export function validateSettlementInput(settlement, members) {
  if (!settlement || typeof settlement !== 'object') {
    throw new TypeError('Settlement must be an object');
  }
  if (typeof settlement.id !== 'string' || settlement.id.trim() === '') {
    throw new TypeError('Settlement id must be a non-empty string');
  }
  validateSafeInteger(settlement.rev, 'Settlement rev', 1, Number.MAX_SAFE_INTEGER);
  if (typeof settlement.timestamp !== 'string' || !ISO_TIMESTAMP_REGEX.test(settlement.timestamp)) {
    throw new TypeError('Settlement timestamp must match ISO 8601 with +07:00 offset');
  }
  validateSafeInteger(settlement.amount, 'Settlement amount', MIN_AMOUNT, MAX_AMOUNT);

  if (!Array.isArray(members) || members.length === 0) {
    throw new TypeError('Members must be a non-empty array');
  }
  const memberSet = new Set(members.map(m => m.id));

  if (typeof settlement.senderId !== 'string' || !memberSet.has(settlement.senderId)) {
    throw new TypeError(`senderId "${settlement.senderId}" does not exist in members`);
  }
  if (typeof settlement.receiverId !== 'string' || !memberSet.has(settlement.receiverId)) {
    throw new TypeError(`receiverId "${settlement.receiverId}" does not exist in members`);
  }
  if (settlement.senderId === settlement.receiverId) {
    throw new TypeError('senderId and receiverId must be distinct');
  }
}

/**
 * Thuật toán chia đều (Equal Split)
 * Phần dư dồn cho các memberId nhỏ nhất theo thứ tự UTF-16 code unit.
 * @param {number} amount
 * @param {string[]} participantIds
 * @returns {Array<{memberId: string, allocated: number}>} Mảng đã sắp xếp theo memberId tăng dần
 */
export function splitEqual(amount, participantIds) {
  validateSafeInteger(amount, 'amount', MIN_AMOUNT, MAX_AMOUNT);
  if (!Array.isArray(participantIds) || participantIds.length === 0) {
    throw new RangeError('participantIds must be a non-empty array');
  }
  if (participantIds.length > MAX_PARTICIPANTS) {
    throw new RangeError(`participantIds cannot exceed ${MAX_PARTICIPANTS}`);
  }

  // Kiểm tra trùng lặp ID
  const uniqueSet = new Set(participantIds);
  if (uniqueSet.size !== participantIds.length) {
    throw new TypeError('Duplicate participantId found');
  }

  const sortedIds = [...participantIds].sort(compareMemberId);
  const n = sortedIds.length;
  const q = Math.floor(amount / n);
  const r = amount % n;

  const result = [];
  let sumAllocated = 0;

  for (let i = 0; i < n; i++) {
    const allocated = i < r ? q + 1 : q;
    sumAllocated += allocated;
    result.push({ memberId: sortedIds[i], allocated });
  }

  if (sumAllocated !== amount) {
    throw new Error(`Split equal invariant violation: sum ${sumAllocated} !== amount ${amount}`);
  }

  return result;
}

/**
 * Thuật toán chia theo trọng số (Shares Split - Largest Remainder / Hamilton-Hare)
 * Phần dư dồn cho các thành viên có phần dư f_i lớn nhất, hòa thì theo memberId tăng dần.
 * @param {number} amount
 * @param {Array<{memberId: string, weight: number}>} participantsWithWeights
 * @returns {Array<{memberId: string, allocated: number}>} Mảng đã sắp xếp theo memberId tăng dần
 */
export function splitShares(amount, participantsWithWeights) {
  validateSafeInteger(amount, 'amount', MIN_AMOUNT, MAX_AMOUNT);
  if (!Array.isArray(participantsWithWeights) || participantsWithWeights.length === 0) {
    throw new RangeError('participantsWithWeights must be a non-empty array');
  }
  if (participantsWithWeights.length > MAX_PARTICIPANTS) {
    throw new RangeError(`participantsWithWeights cannot exceed ${MAX_PARTICIPANTS}`);
  }

  // Chuẩn hóa và xác thực trọng số
  const uniqueSet = new Set();
  let totalWeight = 0;
  for (const p of participantsWithWeights) {
    if (!p || typeof p.memberId !== 'string') {
      throw new TypeError('Participant must have string memberId');
    }
    if (uniqueSet.has(p.memberId)) {
      throw new TypeError(`Duplicate memberId "${p.memberId}" in splitShares`);
    }
    uniqueSet.add(p.memberId);
    validateSafeInteger(p.weight, `Weight for ${p.memberId}`, MIN_WEIGHT, MAX_WEIGHT);
    totalWeight += p.weight;
  }

  const n = participantsWithWeights.length;
  const items = participantsWithWeights.map(p => {
    // A * w_i <= 500M * 1000 = 5e11 < MAX_SAFE_INTEGER
    const prod = amount * p.weight;
    const baseShare = Math.floor(prod / totalWeight);
    const remainder = prod % totalWeight;
    return {
      memberId: p.memberId,
      weight: p.weight,
      baseShare,
      remainder
    };
  });

  const sumBase = items.reduce((acc, it) => acc + it.baseShare, 0);
  const R = amount - sumBase;

  // Bất biến toán học: R luôn nhỏ hơn n
  if (R < 0 || R >= n) {
    throw new Error(`Largest remainder invariant violation: R (${R}) must be in [0, ${n - 1}]`);
  }

  // Sắp xếp các phần tử để phân bổ R đơn vị dư:
  // 1. remainder giảm dần
  // 2. tie-break bằng memberId tăng dần theo UTF-16 code unit
  const rankedItems = [...items].sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder - a.remainder;
    }
    return compareMemberId(a.memberId, b.memberId);
  });

  const allocatedMap = new Map();
  for (let i = 0; i < n; i++) {
    const extra = i < R ? 1 : 0;
    allocatedMap.set(rankedItems[i].memberId, rankedItems[i].baseShare + extra);
  }

  // Trả về mảng đã sắp xếp theo memberId tăng dần
  const sortedIds = [...uniqueSet].sort(compareMemberId);
  const result = [];
  let sumAllocated = 0;

  for (const id of sortedIds) {
    const allocated = allocatedMap.get(id);
    sumAllocated += allocated;
    result.push({ memberId: id, allocated });
  }

  if (sumAllocated !== amount) {
    throw new Error(`Split shares invariant violation: sum ${sumAllocated} !== amount ${amount}`);
  }

  return result;
}

/**
 * Tổng hợp số dư ròng của tất cả thành viên trong chuyến đi
 * balance = (đã trả - phải chịu) + (đã chuyển - đã nhận)
 * @param {Array<{id: string, name?: string, active?: boolean}>} members
 * @param {Array<object>} expenses
 * @param {Array<object>} settlements
 * @returns {{
 *   balances: Record<string, number>,
 *   balanceList: Array<{memberId: string, balance: number}>,
 *   totalTripExpense: number,
 *   memberStats: Record<string, {paid: number, owed: number, transferred: number, received: number}>
 * }}
 */
export function calculateBalances(members, expenses = [], settlements = []) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new TypeError('Members must be a non-empty array');
  }

  // Chuẩn hóa danh sách members theo mã UTF-16 code unit tăng dần
  const sortedMembers = [...members].sort((a, b) => compareMemberId(a.id, b.id));

  const stats = {};
  for (const m of sortedMembers) {
    stats[m.id] = {
      paid: 0,
      owed: 0,
      transferred: 0,
      received: 0
    };
  }

  // 1. Xử lý các khoản chi tiêu (bỏ qua deleted: true)
  let totalTripExpense = 0;
  const activeExpenses = expenses.filter(e => !e?.deleted);

  for (const exp of activeExpenses) {
    validateExpenseInput(exp, sortedMembers);
    totalTripExpense += exp.amount;
    stats[exp.payerId].paid += exp.amount;

    let allocations;
    if (exp.splitMethod === 'shares') {
      allocations = splitShares(exp.amount, exp.participants);
    } else if (exp.splitMethod === 'equal') {
      const ids = exp.participants.map(p => typeof p === 'string' ? p : p.memberId);
      allocations = splitEqual(exp.amount, ids);
    } else {
      throw new TypeError(`Invalid splitMethod "${exp.splitMethod}"`);
    }

    for (const alloc of allocations) {
      stats[alloc.memberId].owed += alloc.allocated;
    }
  }

  // 2. Xử lý các giao dịch quyết toán Settlement (bỏ qua deleted: true)
  // Chấp nhận cả type === 'settlement' và alias type === 'transfer'
  const activeSettlements = settlements.filter(s => !s?.deleted);

  for (const set of activeSettlements) {
    validateSettlementInput(set, sortedMembers);
    stats[set.senderId].transferred += set.amount;
    stats[set.receiverId].received += set.amount;
  }

  // 3. Tính balance cho từng thành viên
  const balances = {};
  const balanceList = [];
  let sumBalance = 0;

  for (const m of sortedMembers) {
    const s = stats[m.id];
    const bal = (s.paid - s.owed) + (s.transferred - s.received);
    balances[m.id] = bal;
    balanceList.push({ memberId: m.id, balance: bal });
    sumBalance += bal;
  }

  if (sumBalance !== 0) {
    throw new Error(`Net balance invariant violation: sum of balances is ${sumBalance}, expected 0`);
  }

  return {
    balances,
    balanceList,
    totalTripExpense,
    memberStats: stats
  };
}

/**
 * Thuật toán tối ưu hóa thanh toán nợ (Greedy Debt Settlement)
 * Bất biến: T <= n - 1 (với n = số thành viên có balance !== 0).
 * Bất biến hoán vị tuyệt đối (Strict Permutation Invariance).
 * @param {Record<string, number> | Array<{memberId: string, balance: number}>} inputBalances
 * @returns {Array<{from: string, to: string, amount: number}>}
 */
export function simplifyDebts(inputBalances) {
  let list = [];
  if (Array.isArray(inputBalances)) {
    list = inputBalances.map(it => ({ memberId: it.memberId, balance: it.balance }));
  } else if (inputBalances && typeof inputBalances === 'object') {
    list = Object.entries(inputBalances).map(([memberId, balance]) => ({ memberId, balance }));
  } else {
    throw new TypeError('inputBalances must be an object or array');
  }

  // Chuẩn hóa sắp xếp theo memberId tăng dần trước tiên
  list.sort((a, b) => compareMemberId(a.memberId, b.memberId));

  // Tách Chủ nợ (> 0) và Con nợ (< 0), bỏ qua balance === 0
  const creditors = [];
  const debtors = [];
  let sumCheck = 0;

  for (const it of list) {
    if (typeof it.balance !== 'number' || !Number.isSafeInteger(it.balance)) {
      throw new TypeError(`Invalid balance for ${it.memberId}`);
    }
    sumCheck += it.balance;
    if (it.balance > 0) {
      creditors.push({ memberId: it.memberId, balance: it.balance });
    } else if (it.balance < 0) {
      debtors.push({ memberId: it.memberId, balance: it.balance });
    }
  }

  if (sumCheck !== 0) {
    throw new Error(`Cannot simplify unbalanced debts: sum of balances is ${sumCheck}`);
  }

  const nonZeroMembersCount = creditors.length + debtors.length;
  if (nonZeroMembersCount === 0) {
    return [];
  }

  // Hàm sắp xếp Chủ nợ: số tiền giảm dần, hòa -> memberId tăng dần
  const sortCreditors = arr => arr.sort((a, b) => {
    if (b.balance !== a.balance) {
      return b.balance - a.balance;
    }
    return compareMemberId(a.memberId, b.memberId);
  });

  // Hàm sắp xếp Con nợ: số tiền nợ tuyệt đối giảm dần, hòa -> memberId tăng dần
  const sortDebtors = arr => arr.sort((a, b) => {
    const absA = Math.abs(a.balance);
    const absB = Math.abs(b.balance);
    if (absB !== absA) {
      return absB - absA;
    }
    return compareMemberId(a.memberId, b.memberId);
  });

  sortCreditors(creditors);
  sortDebtors(debtors);

  const transactions = [];

  while (creditors.length > 0 && debtors.length > 0) {
    const creditor = creditors[0];
    const debtor = debtors[0];

    const debtorOwes = Math.abs(debtor.balance);
    const amount = Math.min(creditor.balance, debtorOwes);

    transactions.push({
      from: debtor.memberId,
      to: creditor.memberId,
      amount
    });

    creditor.balance -= amount;
    debtor.balance += amount; // âm + dương -> tiến về 0

    if (creditor.balance === 0) {
      creditors.shift();
    } else {
      sortCreditors(creditors);
    }

    if (debtor.balance === 0) {
      debtors.shift();
    } else {
      sortDebtors(debtors);
    }
  }

  // Kiểm tra bất biến số giao dịch: T <= n - 1 (n là số thành viên có balance !== 0)
  if (transactions.length > Math.max(0, nonZeroMembersCount - 1)) {
    throw new Error(
      `Greedy transaction bound violation: ${transactions.length} > ${nonZeroMembersCount - 1}`
    );
  }

  return transactions;
}
