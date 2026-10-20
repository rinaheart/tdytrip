/**
 * TdyTripPWA2026 — Phase 0 PoC Backend (Google Apps Script)
 * 
 * QUY TRÌNH GHI BẢO ĐẢM NGUYÊN TỬ & IDEMPOTENCY:
 * 1. LockService: waitLock(20000)
 * 2. Token check (Script Property 'POC_TOKEN')
 * 3. WAL Step 1: Ghi History với status = 'PENDING_APPLY'
 * 4. WAL Step 2: Quét Crash Recovery hoặc thực thi ghi/sửa/xóa dòng nghiệp vụ
 * 5. WAL Step 3: Cập nhật History dòng tương ứng sang status = 'ACKED' kèm JSON kết quả
 * 6. SpreadsheetApp.flush() ép commit trước khi lock.releaseLock()
 */

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'ping';
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (action === 'count') {
    var targetOpId = (e && e.parameter && e.parameter.opId) || '';
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

  // Mặc định: ping
  return sendJson({
    ok: true,
    action: 'ping',
    serverTime: new Date().toISOString(),
    message: 'GAS PoC Endpoint sẵn sàng.'
  });
}

function doPost(e) {
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

  try {
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

    // 1. Kiểm tra Token từ Script Property (nếu đã cấu hình POC_TOKEN)
    var scriptProps = PropertiesService.getScriptProperties();
    var expectedToken = scriptProps.getProperty('POC_TOKEN');
    if (expectedToken) {
      var clientToken = data.token || (e.parameter && e.parameter.token);
      if (clientToken !== expectedToken) {
        return sendJson({ ok: false, retryable: false, error: 'ERR_UNAUTHORIZED', message: 'Token xác thực không hợp lệ.' });
      }
    }

    var opId = data.opId;
    var type = data.type; // EXPENSE_CREATE | EXPENSE_UPDATE | EXPENSE_DELETE
    var payload = data.payload || {};
    var debugCrash = data.debugCrash || '';
    var debugCrashAllowed = scriptProps.getProperty('DEBUG_CRASH_ENABLED') === 'true';

    if (!opId || !type) {
      return sendJson({ ok: false, retryable: false, error: 'ERR_MISSING_PARAMS', message: 'Thiếu opId hoặc type.' });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var historySheet = getOrCreateSheet(ss, 'PoC_History', ['opId', 'type', 'status', 'entityId', 'createdAt', 'payload', 'result']);
    var recordsSheet = getOrCreateSheet(ss, 'PoC_Records', ['id', 'title', 'amount', 'split_method', 'created_op_id', 'last_op_id', 'rev', 'deleted', 'updated_at']);

    // 2. Tra cứu History: Kiểm tra nếu opId đã từng được xử lý
    var historyData = historySheet.getDataRange().getValues();
    var historyRowIndex = -1;
    var existingHistoryStatus = '';
    var existingResultStr = '';

    for (var h = 1; h < historyData.length; h++) {
      if (historyData[h][0] === opId) {
        historyRowIndex = h + 1; // 1-indexed trong Sheets
        existingHistoryStatus = historyData[h][2];
        existingResultStr = historyData[h][6];
        break;
      }
    }

    // 2.1 Replay từ History đã ACKED
    if (existingHistoryStatus === 'ACKED' && existingResultStr) {
      try {
        var cachedRecord = JSON.parse(existingResultStr);
        return sendJson({
          ok: true,
          duplicate: true,
          source: 'history_acked',
          opId: opId,
          record: cachedRecord,
          message: 'Thao tác đã được thực thi và xác nhận trước đó (Idempotent Replay).'
        });
      } catch (ex) {
        // Fallback đọc thẳng từ records nếu parse cache lỗi
      }
    }

    // 3. Phục hồi sự cố (Crash Recovery Scan):
    // Trường hợp: History có dòng PENDING_APPLY hoặc không có History, nhưng row nghiệp vụ đã được ghi
    var recValues = recordsSheet.getDataRange().getValues();
    var foundRecRowIndex = -1;
    var foundRec = null;

    for (var r = 1; r < recValues.length; r++) {
      var row = recValues[r];
      var rowId = row[0];
      var rowCreatedOp = row[4];
      var rowLastOp = row[5];

      if (type === 'EXPENSE_CREATE' && (rowCreatedOp === opId || (payload.id && rowId === payload.id))) {
        foundRecRowIndex = r + 1;
        foundRec = parseRecordRow(row);
        break;
      } else if ((type === 'EXPENSE_UPDATE' || type === 'EXPENSE_DELETE') && rowId === payload.id && rowLastOp === opId) {
        foundRecRowIndex = r + 1;
        foundRec = parseRecordRow(row);
        break;
      }
    }

    if (foundRec) {
      // Bản ghi đã tồn tại! Crash xảy ra sau khi ghi nghiệp vụ nhưng trước khi ghi History ACKED
      if (historyRowIndex > 0) {
        historySheet.getRange(historyRowIndex, 3).setValue('ACKED');
        historySheet.getRange(historyRowIndex, 7).setValue(JSON.stringify(foundRec));
      } else {
        historySheet.appendRow([opId, type, 'ACKED', foundRec.id, new Date().toISOString(), JSON.stringify(payload), JSON.stringify(foundRec)]);
      }
      SpreadsheetApp.flush();
      return sendJson({
        ok: true,
        duplicate: true,
        source: 'crash_recovered',
        opId: opId,
        record: foundRec,
        message: 'Bản ghi đã tồn tại từ lần ghi trước đó, đã tự động phục hồi lịch sử.'
      });
    }

    // 4. WAL Bước 1: Ghi nhận PENDING_APPLY vào History nếu chưa có
    if (historyRowIndex < 0) {
      var targetEntityId = payload.id || Utilities.getUuid();
      historySheet.appendRow([opId, type, 'PENDING_APPLY', targetEntityId, new Date().toISOString(), JSON.stringify(payload), '']);
      SpreadsheetApp.flush();
      historyRowIndex = historySheet.getLastRow();
    }

    // 5. Thực thi nghiệp vụ tương ứng với Type
    var resultRecord = null;
    var nowIso = new Date().toISOString();

    if (type === 'EXPENSE_CREATE') {
      var newEntityId = payload.id || Utilities.getUuid();
      var createAmount = parseInt(payload.amount, 10) || 0;
      var createRev = 1;
      var newRow = [
        newEntityId,
        payload.title || '',
        createAmount,
        payload.splitMethod || 'equal',
        opId, // created_op_id
        opId, // last_op_id
        createRev,
        false, // deleted
        nowIso
      ];
      recordsSheet.appendRow(newRow);
      resultRecord = {
        id: newEntityId,
        title: payload.title || '',
        amount: createAmount,
        splitMethod: payload.splitMethod || 'equal',
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
        return sendJson({ ok: false, retryable: false, error: 'ERR_NOT_FOUND', message: 'Không tìm thấy bản ghi để cập nhật.' });
      }

      // KIỂM TRA ĐỐI CHIẾU REVISION CHÍNH XÁC
      if (currentRec.rev !== expectedRev) {
        return sendJson({
          ok: false,
          retryable: false,
          error: 'ERR_STALE_REV',
          currentRecord: currentRec,
          message: 'Phiên bản không khớp. Bản ghi đã bị cập nhật bởi người khác (Kỳ vọng rev=' + expectedRev + ', Server hiện có rev=' + currentRec.rev + ').'
        });
      }

      var newRev = currentRec.rev + 1;
      var updAmount = payload.amount !== undefined ? parseInt(payload.amount, 10) : currentRec.amount;
      var updTitle = payload.title !== undefined ? payload.title : currentRec.title;
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
        return sendJson({ ok: false, retryable: false, error: 'ERR_NOT_FOUND', message: 'Không tìm thấy bản ghi để xóa.' });
      }

      if (currentDelRec.rev !== expDelRev) {
        return sendJson({
          ok: false,
          retryable: false,
          error: 'ERR_STALE_REV',
          currentRecord: currentDelRec,
          message: 'Phiên bản không khớp khi xóa (Kỳ vọng rev=' + expDelRev + ', Server rev=' + currentDelRec.rev + ').'
        });
      }

      var delNewRev = currentDelRec.rev + 1;
      // Ghi Tombstone: deleted = true
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
      return sendJson({ ok: false, retryable: false, error: 'ERR_UNKNOWN_TYPE', message: 'Loại thao tác không hỗ trợ.' });
    }

    // 6. Mô phỏng sự cố có kiểm soát (Debug Crash Simulator)
    if (debugCrashAllowed && debugCrash === 'afterBusinessWrite') {
      SpreadsheetApp.flush(); // Ép lưu dữ liệu vào sheet nhưng cố ý dừng trước khi ghi History ACKED
      throw new Error('SIMULATED_CRASH: Sau khi ghi row nghiệp vụ nhưng trước khi ghi History ACKED.');
    }

    // 7. WAL Bước 3: Cập nhật History sang trạng thái 'ACKED' kèm JSON kết quả đầy đủ
    historySheet.getRange(historyRowIndex, 3).setValue('ACKED');
    historySheet.getRange(historyRowIndex, 4).setValue(resultRecord.id);
    historySheet.getRange(historyRowIndex, 7).setValue(JSON.stringify(resultRecord));

    if (debugCrashAllowed && debugCrash === 'afterAck') {
      SpreadsheetApp.flush();
      throw new Error('SIMULATED_CRASH: Sau khi ghi History ACKED nhưng trước khi trả phản hồi HTTP.');
    }

    // Ép đồng bộ bộ nhớ Sheets trước khi nhả Lock
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
