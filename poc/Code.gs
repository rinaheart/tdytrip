/**
 * TdyTripPWA2026 — Phase 0 PoC Backend (Google Apps Script)
 * Version: v0.2.0-wal-sweep
 * 
 * QUY TRÌNH GHI BẢO ĐẢM NGUYÊN TỬ & IDEMPOTENCY HOÀN CHỈNH:
 * 1. Kiểm tra Token bảo mật TRƯỚC KHI lấy Lock (chống kiệt quệ tài nguyên Lock).
 * 2. LockService: waitLock(20000) (trả retryable: true nếu timeout).
 * 3. SWEEP RECOVERY: Quét toàn bộ History 'PENDING_APPLY' mồ côi:
 *    - Nếu row nghiệp vụ còn op_id khớp -> Chốt ACKED + lưu record.
 *    - Nếu không khớp -> Chốt ABORTED.
 *    (Giải quyết triệt để kịch bản: A crash sau khi ghi -> B cập nhật đè -> A retry).
 * 4. Kiểm tra Idempotency Replay (ACKED -> replay kết quả; REJECTED/ABORTED -> replay lỗi cũ).
 * 5. Input Validation nghiêm ngặt -> Ghi REJECTED nếu sai dữ liệu, không để PENDING_APPLY mồ côi.
 * 6. Kiểm tra ID Conflict (CREATE trùng ID nhưng khác opId -> ERR_ID_CONFLICT).
 * 7. WAL Step 1: Ghi History 'PENDING_APPLY'.
 * 8. WAL Step 2: Ghi/Sửa/Xóa nghiệp vụ (rev+1, last_op_id).
 * 9. WAL Step 3: Cập nhật History 'ACKED' kèm JSON kết quả đầy đủ.
 * 10. SpreadsheetApp.flush() ép commit trước khi nhả Lock.
 */

var BACKEND_VERSION = 'v0.2.0-wal-sweep';

function doGet(e) {
  var scriptProps = PropertiesService.getScriptProperties();
  var expectedToken = scriptProps.getProperty('POC_TOKEN');
  var clientToken = (e && e.parameter && e.parameter.token) || '';

  // 1. Kiểm tra Token bảo mật cho mọi endpoint đọc dữ liệu
  if (expectedToken && clientToken !== expectedToken) {
    return sendJson({ ok: false, retryable: false, error: 'ERR_UNAUTHORIZED', message: 'Token không hợp lệ.' });
  }

  var action = (e && e.parameter && e.parameter.action) || 'ping';
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (action === 'count') {
    var targetOpId = (e && e.parameter && e.parameter.opId) || '';
    if (!targetOpId) {
      return sendJson({ ok: false, retryable: false, error: 'ERR_MISSING_OPID', message: 'Thiếu opId để đếm.' });
    }
    var recordsSheet = getOrCreateSheet(ss, 'PoC_Records', ['id', 'title', 'amount', 'split_method', 'created_op_id', 'last_op_id', 'rev', 'deleted', 'updated_at']);
    var values = recordsSheet.getDataRange().getValues();
    var count = 0;
    for (var i = 1; i < values.length; i++) {
      if (values[i][4] === targetOpId) { // created_op_id column
        count++;
      }
    }
    return sendJson({ ok: true, action: 'count', opId: targetOpId, count: count });
  }

  if (action === 'get') {
    var recId = (e && e.parameter && e.parameter.id) || '';
    var recSheet = getOrCreateSheet(ss, 'PoC_Records', ['id', 'title', 'amount', 'split_method', 'created_op_id', 'last_op_id', 'rev', 'deleted', 'updated_at']);
    var recs = recSheet.getDataRange().getValues();
    for (var j = 1; j < recs.length; j++) {
      if (recs[j][0] === recId) {
        return sendJson({ ok: true, action: 'get', record: parseRecordRow(recs[j]) });
      }
    }
    return sendJson({ ok: false, error: 'ERR_NOT_FOUND', message: 'Không tìm thấy bản ghi.' });
  }

  // Mặc định: ping kiểm tra sức khỏe
  var debugCrashAllowed = scriptProps.getProperty('DEBUG_CRASH_ENABLED') === 'true';
  return sendJson({
    ok: true,
    action: 'ping',
    version: BACKEND_VERSION,
    debugCrashEnabled: debugCrashAllowed,
    serverTime: new Date().toISOString(),
    message: 'GAS PoC Endpoint sẵn sàng.'
  });
}

function doPost(e) {
  var scriptProps = PropertiesService.getScriptProperties();
  var expectedToken = scriptProps.getProperty('POC_TOKEN');
  var debugCrashAllowed = scriptProps.getProperty('DEBUG_CRASH_ENABLED') === 'true';

  // 1. KIỂM TRA TOKEN TRƯỚC KHI LẤY LOCK (Bảo vệ tài nguyên server)
  var raw = e && e.postData && e.postData.contents;
  if (!raw) {
    return sendJson({ ok: false, retryable: false, error: 'ERR_EMPTY_BODY', message: 'Body trống.' });
  }

  var data;
  try {
    data = JSON.parse(raw);
  } catch (parseErr) {
    return sendJson({ ok: false, retryable: false, error: 'ERR_JSON_INVALID', message: 'JSON body không hợp lệ.' });
  }

  if (expectedToken) {
    var clientToken = data.token || (e.parameter && e.parameter.token);
    if (clientToken !== expectedToken) {
      return sendJson({ ok: false, retryable: false, error: 'ERR_UNAUTHORIZED', message: 'Token xác thực không hợp lệ.' });
    }
  }

  // 2. LẤY LOCK CHỐNG TRANH CHẤP ĐỒNG THỜI
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return sendJson({
      ok: false,
      retryable: true,
      error: 'ERR_LOCK_TIMEOUT',
      message: 'Máy chủ đang bận xử lý giao dịch đồng thời, vui lòng thử lại sau.'
    });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var historySheet = getOrCreateSheet(ss, 'PoC_History', ['opId', 'type', 'status', 'entityId', 'createdAt', 'payload', 'result']);
  var recordsSheet = getOrCreateSheet(ss, 'PoC_Records', ['id', 'title', 'amount', 'split_method', 'created_op_id', 'last_op_id', 'rev', 'deleted', 'updated_at']);

  try {
    // 3. P0 SWEEP TOÀN DIỆN MỌI PENDING_APPLY (Giải quyết kịch bản A crash -> B ghi đè -> A retry)
    sweepPendingApply(historySheet, recordsSheet);

    var opId = data.opId;
    var type = data.type; // EXPENSE_CREATE | EXPENSE_UPDATE | EXPENSE_DELETE
    var payload = data.payload || {};
    var debugCrash = data.debugCrash || '';

    if (!opId || !type) {
      return sendJson({ ok: false, retryable: false, error: 'ERR_MISSING_PARAMS', message: 'Thiếu opId hoặc type.' });
    }

    // 4. KIỂM TRA IDEMPOTENCY TỪ HISTORY ĐÃ SWEEP
    var historyData = historySheet.getDataRange().getValues();
    for (var h = 1; h < historyData.length; h++) {
      if (historyData[h][0] === opId) {
        var hStatus = historyData[h][2];
        var hResultStr = historyData[h][6];
        var parsedRes = {};
        try { parsedRes = JSON.parse(hResultStr); } catch (ex) {}

        if (hStatus === 'ACKED') {
          return sendJson({
            ok: true,
            duplicate: true,
            source: 'history_acked',
            opId: opId,
            record: parsedRes,
            message: 'Thao tác đã được xác nhận thành công trước đó (Idempotent Replay).'
          });
        } else if (hStatus === 'REJECTED' || hStatus === 'ABORTED') {
          return sendJson(Object.assign({
            ok: false,
            duplicate: true,
            source: 'history_' + hStatus.toLowerCase(),
            opId: opId,
            retryable: false
          }, parsedRes));
        }
      }
    }

    // 5. WAL BƯỚC 1: GHI NHẬN PENDING_APPLY VÀO HISTORY NGAY TỪ ĐẦU
    var targetEntityId = payload.id || Utilities.getUuid();
    historySheet.appendRow([opId, type, 'PENDING_APPLY', targetEntityId, new Date().toISOString(), JSON.stringify(payload), '']);
    SpreadsheetApp.flush();
    var currentHistoryRow = historySheet.getLastRow();

    // 6. VALIDATION DỮ LIỆU ĐẦU VÀO NGHIÊM NGẶT
    var valErr = validatePayload(type, payload);
    if (valErr) {
      return rejectPendingOp(historySheet, currentHistoryRow, 'ERR_VALIDATION', valErr);
    }

    // 7. KIỂM TRA TRÙNG ID KHI CREATE (ID Conflict)
    var recValues = recordsSheet.getDataRange().getValues();
    if (type === 'EXPENSE_CREATE') {
      for (var k = 1; k < recValues.length; k++) {
        if (recValues[k][0] === targetEntityId) {
          // Trùng payload.id nhưng opId không khớp (vì nếu khớp opId thì đã replay ở bước 4)
          return rejectPendingOp(historySheet, currentHistoryRow, 'ERR_ID_CONFLICT', 'ID bản ghi đã tồn tại từ một thao tác khác.');
        }
      }
    }

    // 8. THỰC THI NGHIỆP VỤ TƯƠNG ỨNG
    var resultRecord = null;
    var nowIso = new Date().toISOString();

    if (type === 'EXPENSE_CREATE') {
      var createAmount = parseInt(payload.amount, 10);
      var createRev = 1;
      var newRow = [
        targetEntityId,
        payload.title.trim(),
        createAmount,
        payload.splitMethod,
        opId, // created_op_id
        opId, // last_op_id
        createRev,
        false, // deleted
        nowIso
      ];
      recordsSheet.appendRow(newRow);
      resultRecord = {
        id: targetEntityId,
        title: payload.title.trim(),
        amount: createAmount,
        splitMethod: payload.splitMethod,
        created_op_id: opId,
        last_op_id: opId,
        rev: createRev,
        deleted: false,
        updated_at: nowIso
      };

    } else if (type === 'EXPENSE_UPDATE') {
      var updateId = payload.id;
      var expectedRev = parseInt(payload.expectedRev, 10);
      var targetRowIdx = -1;
      var currentRec = null;

      for (var u = 1; u < recValues.length; u++) {
        if (recValues[u][0] === updateId) {
          targetRowIdx = u + 1;
          currentRec = parseRecordRow(recValues[u]);
          break;
        }
      }

      if (!currentRec) {
        return rejectPendingOp(historySheet, currentHistoryRow, 'ERR_NOT_FOUND', 'Không tìm thấy bản ghi để cập nhật.');
      }

      // KIỂM TRA ĐỐI CHIẾU REVISION CHÍNH XÁC
      if (currentRec.rev !== expectedRev) {
        return rejectPendingOp(historySheet, currentHistoryRow, 'ERR_STALE_REV', 
          'Phiên bản không khớp (Kỳ vọng rev=' + expectedRev + ', Server hiện có rev=' + currentRec.rev + ').',
          { currentRecord: currentRec }
        );
      }

      var newRev = currentRec.rev + 1;
      var updAmount = payload.amount !== undefined ? parseInt(payload.amount, 10) : currentRec.amount;
      var updTitle = payload.title !== undefined ? payload.title.trim() : currentRec.title;
      var updSplit = payload.splitMethod !== undefined ? payload.splitMethod : currentRec.splitMethod;

      recordsSheet.getRange(targetRowIdx, 2).setValue(updTitle);
      recordsSheet.getRange(targetRowIdx, 3).setValue(updAmount);
      recordsSheet.getRange(targetRowIdx, 4).setValue(updSplit);
      recordsSheet.getRange(targetRowIdx, 6).setValue(opId); // last_op_id
      recordsSheet.getRange(targetRowIdx, 7).setValue(newRev); // rev
      recordsSheet.getRange(targetRowIdx, 9).setValue(nowIso);

      resultRecord = {
        id: updateId,
        title: updTitle,
        amount: updAmount,
        splitMethod: updSplit,
        created_op_id: currentRec.created_op_id,
        last_op_id: opId,
        rev: newRev,
        deleted: currentRec.deleted,
        updated_at: nowIso
      };

    } else if (type === 'EXPENSE_DELETE') {
      var deleteId = payload.id;
      var expDelRev = parseInt(payload.expectedRev, 10);
      var delRowIdx = -1;
      var currentDelRec = null;

      for (var d = 1; d < recValues.length; d++) {
        if (recValues[d][0] === deleteId) {
          delRowIdx = d + 1;
          currentDelRec = parseRecordRow(recValues[d]);
          break;
        }
      }

      if (!currentDelRec) {
        return rejectPendingOp(historySheet, currentHistoryRow, 'ERR_NOT_FOUND', 'Không tìm thấy bản ghi để xóa.');
      }

      if (currentDelRec.rev !== expDelRev) {
        return rejectPendingOp(historySheet, currentHistoryRow, 'ERR_STALE_REV',
          'Phiên bản không khớp khi xóa (Kỳ vọng rev=' + expDelRev + ', Server rev=' + currentDelRec.rev + ').',
          { currentRecord: currentDelRec }
        );
      }

      var delNewRev = currentDelRec.rev + 1;
      // Ghi Tombstone: deleted = true, rev = rev + 1
      recordsSheet.getRange(delRowIdx, 6).setValue(opId);
      recordsSheet.getRange(delRowIdx, 7).setValue(delNewRev);
      recordsSheet.getRange(delRowIdx, 8).setValue(true);
      recordsSheet.getRange(delRowIdx, 9).setValue(nowIso);

      resultRecord = {
        id: deleteId,
        title: currentDelRec.title,
        amount: currentDelRec.amount,
        splitMethod: currentDelRec.splitMethod,
        created_op_id: currentDelRec.created_op_id,
        last_op_id: opId,
        rev: delNewRev,
        deleted: true,
        updated_at: nowIso
      };

    } else {
      return rejectPendingOp(historySheet, currentHistoryRow, 'ERR_UNKNOWN_TYPE', 'Loại thao tác không được hỗ trợ.');
    }

    // 9. MÔ PHỎNG SỰ CỐ SAU KHI GHI BẢNG NGHIỆP VỤ (Debug Crash Simulator)
    if (debugCrashAllowed && debugCrash === 'afterBusinessWrite') {
      SpreadsheetApp.flush();
      throw new Error('SIMULATED_CRASH: Sau khi ghi row nghiệp vụ nhưng trước khi chốt History ACKED.');
    }

    // 10. WAL BƯỚC 3: CẬP NHẬT HISTORY SANG 'ACKED' VÀ LƯU RECORD KẾT QUẢ ĐẦY ĐỦ
    historySheet.getRange(currentHistoryRow, 3).setValue('ACKED');
    historySheet.getRange(currentHistoryRow, 4).setValue(resultRecord.id);
    historySheet.getRange(currentHistoryRow, 7).setValue(JSON.stringify(resultRecord));

    if (debugCrashAllowed && debugCrash === 'afterAck') {
      SpreadsheetApp.flush();
      throw new Error('SIMULATED_CRASH: Sau khi ghi History ACKED nhưng trước khi trả phản hồi HTTP.');
    }

    // 11. ÉP FLUSH TRƯỚC KHI NHẢ LOCK
    SpreadsheetApp.flush();

    return sendJson({
      ok: true,
      duplicate: false,
      opId: opId,
      record: resultRecord,
      message: 'Thao tác hoàn tất và đã được xác nhận (Committed).'
    });

  } catch (err) {
    return sendJson({
      ok: false,
      retryable: true,
      error: 'ERR_SERVER_EXCEPTION',
      message: String(err && err.message ? err.message : err)
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Sweep toàn bộ dòng PENDING_APPLY mồ côi khi bắt đầu request
 */
function sweepPendingApply(historySheet, recordsSheet) {
  var histData = historySheet.getDataRange().getValues();
  if (histData.length <= 1) return;

  var recData = recordsSheet.getDataRange().getValues();
  var hasChanges = false;

  for (var i = 1; i < histData.length; i++) {
    if (histData[i][2] === 'PENDING_APPLY') {
      var pendingOpId = histData[i][0];
      var pendingType = histData[i][1];
      var pendingEntityId = histData[i][3];
      var rowIdx = i + 1; // 1-indexed trong Sheets

      var matchedRec = null;
      for (var j = 1; j < recData.length; j++) {
        var r = recData[j];
        if (pendingType === 'EXPENSE_CREATE') {
          if (r[4] === pendingOpId || r[0] === pendingEntityId) {
            matchedRec = parseRecordRow(r);
            break;
          }
        } else if (pendingType === 'EXPENSE_UPDATE' || pendingType === 'EXPENSE_DELETE') {
          if (r[0] === pendingEntityId && r[5] === pendingOpId) {
            matchedRec = parseRecordRow(r);
            break;
          }
        }
      }

      if (matchedRec) {
        // Bản ghi nghiệp vụ đã được ghi nhận trước khi crash -> Chốt ACKED
        historySheet.getRange(rowIdx, 3).setValue('ACKED');
        historySheet.getRange(rowIdx, 7).setValue(JSON.stringify(matchedRec));
        hasChanges = true;
      } else {
        // Chưa kịp ghi nghiệp vụ -> Đánh dấu ABORTED
        historySheet.getRange(rowIdx, 3).setValue('ABORTED');
        historySheet.getRange(rowIdx, 7).setValue(JSON.stringify({ error: 'CRASH_ABORTED', message: 'Thao tác bị hủy do crash trước khi ghi dữ liệu nghiệp vụ.' }));
        hasChanges = true;
      }
    }
  }

  if (hasChanges) {
    SpreadsheetApp.flush();
  }
}

function rejectPendingOp(historySheet, rowIndex, errCode, errMsg, extraData) {
  var errObj = Object.assign({ error: errCode, message: errMsg }, extraData || {});
  historySheet.getRange(rowIndex, 3).setValue('REJECTED');
  historySheet.getRange(rowIndex, 7).setValue(JSON.stringify(errObj));
  SpreadsheetApp.flush();
  return sendJson(Object.assign({ ok: false, retryable: false }, errObj));
}

function validatePayload(type, p) {
  if (type === 'EXPENSE_CREATE' || type === 'EXPENSE_UPDATE') {
    if (p.amount !== undefined) {
      var amt = parseInt(p.amount, 10);
      if (!isSafeInteger(amt) || amt <= 0 || amt > 500000000) {
        return 'Số tiền phải là số nguyên dương và không vượt quá 500.000.000 VND.';
      }
    } else if (type === 'EXPENSE_CREATE') {
      return 'Thiếu số tiền hợp lệ.';
    }

    if (p.title !== undefined) {
      if (typeof p.title !== 'string' || p.title.trim().length === 0 || p.title.trim().length > 200) {
        return 'Tiêu đề không được để trống và tối đa 200 ký tự.';
      }
    } else if (type === 'EXPENSE_CREATE') {
      return 'Thiếu tiêu đề chi tiêu.';
    }

    if (p.splitMethod !== undefined) {
      if (p.splitMethod !== 'equal' && p.splitMethod !== 'shares') {
        return 'Phương thức chia tiền phải là "equal" hoặc "shares".';
      }
    }
  }

  if (type === 'EXPENSE_UPDATE' || type === 'EXPENSE_DELETE') {
    if (!p.id) return 'Thiếu id bản ghi.';
    if (p.expectedRev === undefined || isNaN(parseInt(p.expectedRev, 10))) {
      return 'Thiếu expectedRev hợp lệ cho thao tác cập nhật/xóa.';
    }
  }

  return null;
}

function isSafeInteger(n) {
  return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && Math.abs(n) <= 9007199254740991;
}

function parseRecordRow(row) {
  return {
    id: String(row[0]),
    title: String(row[1]),
    amount: parseInt(row[2], 10) || 0,
    splitMethod: String(row[3] || 'equal'),
    created_op_id: String(row[4]),
    last_op_id: String(row[5]),
    rev: parseInt(row[6], 10) || 1,
    deleted: row[7] === true || String(row[7]).toLowerCase() === 'true',
    updated_at: String(row[8])
  };
}

function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function sendJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
