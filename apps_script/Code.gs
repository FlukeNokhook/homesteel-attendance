/**
 * Code.gs
 * จุดรับ Request หลัก (doGet / doPost) ของ Google Apps Script Web App
 * ออกแบบให้ต่อตรงจาก LIFF และ Gateway ได้เลยตอนนี้ และเสียบ Cloudflare Worker คั่นหน้าได้ในอนาคตโดยไม่แก้โครงสร้าง
 */

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  if (action === 'health') {
    return jsonResponse({ status: 'ok', time: nowStr() });
  }
  return HtmlService.createHtmlOutputFromFile('AdminWeb')
    .setTitle('HomesteelKK • ระบบเวลา ลา และโอที')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    verifyOptionalProxySecret(body);
    const action = String(body.action || '').trim();

    if (action.indexOf('liff_') === 0) {
      return jsonResponse(handleLiffAction(action, body));
    }

    // เตรียมพร้อมสำหรับเฟส 2 (Gateway PC ส่งข้อมูลสแกนนิ้วจาก ZKTeco K50)
    if (action === 'gateway_push') {
      verifyGatewaySecret(body.api_secret);
      const res = withScriptLock(() => ingestRawScans(body.rows || [], 'ZKTECO_GATEWAY', 'GATEWAY'));
      return jsonResponse({ status: 'ok', data: res });
    }

    throw new Error('ไม่รู้จักคำสั่งที่ร้องขอ: ' + action);
  } catch (err) {
    return jsonResponse({ status: 'error', code: err.code || '', message: err.message || 'เกิดข้อผิดพลาดในระบบ' });
  }
}

function handleLiffAction(action, body) {
  const profile = verifyLineIdToken(body.id_token);
  const emp = repoFindEmployeeByLineId(profile.lineUserId);
  if (!emp) {
    return {
      status: 'error',
      code: 'UNREGISTERED_LINE',
      message: 'ยังไม่พบบัญชี LINE ของคุณในรายชื่อพนักงาน รบกวนคัดลอกรหัสด้านล่างส่งให้ผู้ดูแลระบบเพื่อผูกบัญชีนะครับ',
      line_user_id: profile.lineUserId
    };
  }

  const payload = body.payload || {};
  const approver = isApproverRole(emp);

  if (action === 'liff_me') {
    return {
      status: 'ok',
      employee: {
        employee_id: emp.employee_id,
        code: emp.code || emp.employee_id,
        name: emp.name,
        nickname: emp.nickname || '',
        department: emp.department || '',
        role: emp.role || 'employee'
      },
      quotas: getLeaveQuotas(emp.employee_id, todayStr()),
      holidays: repoGetHolidayMap(),
      leaves: listMyLeaves(emp.employee_id),
      ots: listMyOTs(emp.employee_id),
      attendance: listMyAttendance(emp.employee_id, payload.year_month),
      pending_vacations: approver ? listPendingVacationLeaves() : [],
      unack_leaves: approver ? listUnacknowledgedLeaves() : [],
      pending_ots: approver ? listPendingOTs() : []
    };
  }

  if (action === 'liff_submit_leave') {
    const rec = withScriptLock(() => submitLeaveRequest(emp, payload));
    const msg = rec.status === 'PENDING'
      ? 'ส่งคำขอลาพักร้อนเรียบร้อยแล้วครับ รอหัวหน้างานอนุมัตินะครับ'
      : (rec.status === 'WAITING_MEDICAL_CERT'
        ? 'บันทึกใบลาป่วยเรียบร้อยแล้วครับ กรุณาแนบใบรับรองแพทย์เพิ่มเติมในเมนู "ประวัติ" นะครับ'
        : 'บันทึกใบ' + rec.leave_type + 'เรียบร้อยแล้วครับ ระบบแจ้งหัวหน้างานรับทราบแล้ว');
    return { status: 'ok', data: rec, message: msg };
  }

  if (action === 'liff_upload_med_cert') {
    const rec = withScriptLock(() => uploadMedicalCertForLeave(emp, payload.request_id, payload.attachment_base64, payload.attachment_mime));
    return { status: 'ok', data: rec, message: 'แนบใบรับรองแพทย์เรียบร้อยแล้วครับ' };
  }

  if (action === 'liff_submit_ot') {
    const rec = withScriptLock(() => submitOTRequest(emp, payload));
    return { status: 'ok', data: rec, message: 'ส่งคำขอโอทีเรียบร้อยแล้วครับ รอหัวหน้างานอนุมัตินะครับ' };
  }

  if (action === 'liff_report_missed_scan') {
    const rec = withScriptLock(() => submitMissedScan(emp, payload));
    return { status: 'ok', data: rec, message: 'แจ้งลืมสแกนนิ้วเรียบร้อยแล้วครับ ระบบส่งเข้าคิวตรวจสอบให้แล้ว' };
  }

  if (action === 'liff_decide') {
    if (!approver) throw new Error('บัญชีของคุณยังไม่มีสิทธิ์อนุมัติรายการนี้ครับ');
    const approved = !!payload.approved;
    const otOpts = {
      approved_start: payload.approved_start,
      approved_end: payload.approved_end,
      skip_scan_cap: !!payload.skip_scan_cap
    };
    const res = withScriptLock(() => (payload.target_type === 'OT'
      ? decideOT(payload.target_id, approved, emp.employee_id, payload.reject_reason, otOpts)
      : decideVacationLeave(payload.target_id, approved, emp.employee_id, payload.reject_reason)));
    return { status: 'ok', data: res, message: approved ? 'อนุมัติเรียบร้อยแล้วครับ' : 'บันทึกการไม่อนุมัติเรียบร้อยแล้วครับ' };
  }

  if (action === 'liff_acknowledge') {
    if (!approver) throw new Error('บัญชีของคุณยังไม่มีสิทธิ์ดำเนินการนี้ครับ');
    const res = withScriptLock(() => acknowledgeLeave(payload.request_id, emp.employee_id));
    return { status: 'ok', data: res, message: 'กดรับทราบเรียบร้อยแล้วครับ' };
  }

  if (action === 'liff_decide_sick') {
    if (!approver) throw new Error('บัญชีของคุณยังไม่มีสิทธิ์ดำเนินการนี้ครับ');
    const allow = !!payload.allow_benefit;
    const res = withScriptLock(() => decideSickLeaveBenefit(payload.request_id, allow, emp.employee_id, payload.note));
    return {
      status: 'ok',
      data: res,
      message: allow ? 'รับทราบการลาและอนุมัติใช้สิทธิ์เรียบร้อยครับ' : 'บันทึกการรับทราบและไม่อนุมัติการใช้สิทธิ์เรียบร้อยครับ'
    };
  }

  throw new Error('ไม่รู้จักคำสั่งที่ร้องขอ: ' + action);
}

/* ================= Admin Dashboard Endpoints (google.script.run) ================= */

function adminGetInitData(adminSecret, yearMonth) {
  verifyAdminSecret(adminSecret);
  ensureVacationQuotaColumn();
  const ym = yearMonth || Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM');
  const period = withScriptLock(() => repoGetOrCreatePeriod(ym + '-01'));
  return {
    yearMonth: ym,
    period: { year_month: period.year_month, status: period.status, locked_by: period.locked_by, locked_at: period.locked_at },
    employees: repoGetEmployees().filter(isActiveEmp).map(e => ({
      employee_id: e.employee_id, code: e.code || e.employee_id, name: e.name, nickname: e.nickname || '', department: e.department || ''
    })),
    pendingVacations: listPendingVacationLeaves(),
    unackLeaves: listUnacknowledgedLeaves(),
    pendingOTs: listPendingOTs(),
    overview: getMonthOverview(ym)
  };
}

function adminDecideItem(adminSecret, targetType, requestId, isApproved, rejectReason, otOptions) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => (targetType === 'OT'
    ? decideOT(requestId, isApproved, 'ADMIN', rejectReason, otOptions)
    : decideVacationLeave(requestId, isApproved, 'ADMIN', rejectReason)));
}

function adminAcknowledgeLeave(adminSecret, requestId) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => acknowledgeLeave(requestId, 'ADMIN'));
}

function adminDecideSickLeave(adminSecret, requestId, allowBenefit, note) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => decideSickLeaveBenefit(requestId, !!allowBenefit, 'ADMIN', note));
}

function adminGetIndividualTimesheet(adminSecret, employeeId, yearMonth) {
  verifyAdminSecret(adminSecret);
  return getIndividualTimesheet(employeeId, yearMonth);
}

function adminGetMonthlyMatrix(adminSecret, yearMonth) {
  verifyAdminSecret(adminSecret);
  return getMonthlyMatrix(yearMonth);
}

function adminCorrectAttendance(adminSecret, workDate, employeeId, firstIn, lastOut, adminNote, reason) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => adminCorrectDaily(workDate, employeeId, firstIn, lastOut, adminNote, reason, 'ADMIN'));
}

function adminResolveException(adminSecret, kind, targetId, workDate, employeeId) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => resolveExceptionItem(kind, targetId, workDate, employeeId, 'ADMIN'));
}

function adminRecomputeMonth(adminSecret, yearMonth) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => recomputeDailyForMonth(yearMonth));
}

function adminImportManualAttendance(adminSecret, rowsInput) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => ingestRawScans(rowsInput, 'MANUAL_IMPORT', 'ADMIN'));
}

function adminExportTimeClockCsv(adminSecret, yearMonth) {
  verifyAdminSecret(adminSecret);
  return exportTimeClockCsv(yearMonth);
}

function adminExportLeaveOtSummaryCsv(adminSecret, yearMonth) {
  verifyAdminSecret(adminSecret);
  return exportLeaveOtSummaryCsv(yearMonth);
}

function adminSetPeriodStatus(adminSecret, yearMonth, newStatus, reason) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => setPeriodStatus(yearMonth, newStatus, 'ADMIN', reason));
}

function adminGetAttachment(adminSecret, fileId) {
  verifyAdminSecret(adminSecret);
  return getAttachmentDataUrl(fileId);
}

/* ================= Payroll Sheet Integration & Pay Slip ================= */

function adminSyncTimeClockToPayroll(adminSecret, yearMonth) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => syncTimeClockToPayrollSheet(yearMonth, 'ADMIN'));
}

function adminSetupCleanPayroll(adminSecret) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => setupCleanPayrollSheet('ADMIN'));
}

function adminGetPayrollData(adminSecret) {
  verifyAdminSecret(adminSecret);
  return getPayrollDashboardData();
}

function adminUpdatePayrollRow(adminSecret, rowIndex, updates) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => updatePayrollCalculationRow(rowIndex, updates, 'ADMIN'));
}

function adminSavePaySlipPdf(adminSecret, htmlContent, fileName, yearMonth) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => savePaySlipPdfToDrive(htmlContent, fileName, yearMonth, 'ADMIN'));
}

/* ================= Settings & Holidays Management ================= */

function adminGetHolidays(adminSecret) {
  verifyAdminSecret(adminSecret);
  return listHolidays();
}

function adminAddHoliday(adminSecret, holidayDate, holidayName) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => addHoliday(holidayDate, holidayName, 'ADMIN'));
}

function adminUpdateHoliday(adminSecret, oldDate, newDate, newName) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => updateHoliday(oldDate, newDate, newName, 'ADMIN'));
}

function adminDeleteHoliday(adminSecret, holidayDate) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => deleteHoliday(holidayDate, 'ADMIN'));
}

/* ================= Frame Finding & Site Measure Management ================= */

function adminGetMonthBonuses(adminSecret, yearMonth) {
  verifyAdminSecret(adminSecret);
  return getMonthBonusData(yearMonth);
}

function adminAddFrameFinding(adminSecret, payload) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => addFrameFinding(payload, 'ADMIN'));
}

function adminUpdateFrameFinding(adminSecret, recordId, payload) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => updateFrameFinding(recordId, payload, 'ADMIN'));
}

function adminDeleteFrameFinding(adminSecret, recordId) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => deleteFrameFinding(recordId, 'ADMIN'));
}

function adminAddSiteMeasure(adminSecret, payload) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => addSiteMeasure(payload, 'ADMIN'));
}

function adminUpdateSiteMeasure(adminSecret, recordId, payload) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => updateSiteMeasure(recordId, payload, 'ADMIN'));
}

function adminDeleteSiteMeasure(adminSecret, recordId) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => deleteSiteMeasure(recordId, 'ADMIN'));
}

function adminGetMonthCommission(adminSecret, yearMonth) {
  verifyAdminSecret(adminSecret);
  return getMonthCommissionData(yearMonth);
}

function adminSaveMonthCommission(adminSecret, payload) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => saveMonthCommission(payload, 'ADMIN'));
}

function adminGetYearGrossSales(adminSecret, year) {
  verifyAdminSecret(adminSecret);
  return getYearGrossSales(year);
}

function adminSaveYearGrossSales(adminSecret, year, monthlyMap) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => saveYearGrossSales(year, monthlyMap, 'ADMIN'));
}

function adminSavePvdRates(adminSecret, updatesList) {
  verifyAdminSecret(adminSecret);
  return withScriptLock(() => savePvdRates(updatesList, 'ADMIN'));
}
