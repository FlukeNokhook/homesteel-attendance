/**
 * OTService.gs
 * จัดการคำขอทำโอที (ตอนนี้ใช้ระดับเดียวกันทั้งหมดก่อน และขยายเพิ่มระดับ 2/3 ได้ภายหลัง)
 * พนักงานขอผ่าน LIFF -> แฟน/หัวหน้างานอนุมัติหรือปฏิเสธ
 */

function parseHmToMinutes(hm) {
  const m = String(hm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return NaN;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function otWindow(startTime, endTime) {
  const s = parseHmToMinutes(startTime);
  let e = parseHmToMinutes(endTime);
  if (isNaN(s) || isNaN(e)) return null;
  if (e <= s) e += 24 * 60;
  return { start: s, end: e };
}

function submitOTRequest(emp, payload) {
  const otDate = String(payload.ot_date || '').trim();
  const startTime = String(payload.start_time || '').trim();
  const endTime = String(payload.end_time || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(otDate) || !startTime || !endTime) {
    throw new Error('กรุณาระบุวันที่ และเวลาเริ่ม-สิ้นสุดโอทีให้ครบถ้วนครับ');
  }

  const win = otWindow(startTime, endTime);
  if (!win) throw new Error('รูปแบบเวลาไม่ถูกต้องครับ');
  const diffMin = win.end - win.start;
  if (diffMin < 15 || diffMin > 12 * 60) {
    throw new Error('ระยะเวลาโอทีควรอยู่ระหว่าง 15 นาที ถึง 12 ชั่วโมง รบกวนตรวจสอบเวลาอีกครั้งนะครับ');
  }

  const periodId = repoAssertPeriodEditable(otDate);

  const { rows } = repoReadAll(SHEETS.OT);
  const dup = rows.find(r => {
    if (String(r.employee_id) !== String(emp.employee_id) || String(r.ot_date) !== otDate) return false;
    if (['PENDING', 'APPROVED'].indexOf(String(r.status).toUpperCase()) === -1) return false;
    const w = otWindow(r.requested_start, r.requested_end);
    return w && w.start < win.end && win.start < w.end;
  });
  if (dup) {
    throw new Error('คุณมีคำขอโอทีช่วง ' + dup.requested_start + '-' + dup.requested_end + ' ของวันนี้อยู่แล้วครับ');
  }

  const record = {
    request_id: generateId('OT'),
    employee_id: emp.employee_id,
    name: emp.name,
    ot_date: otDate,
    requested_start: startTime,
    requested_end: endTime,
    approved_start: '',
    approved_end: '',
    actual_start: '',
    actual_end: '',
    requested_hours: Number((diffMin / 60).toFixed(2)),
    approved_hours: '',
    job_reference: String(payload.job_reference || '').trim(),
    reason: String(payload.reason || '').trim(),
    status: 'PENDING',
    approver_id: '',
    approved_at: '',
    reject_reason: '',
    submitted_at: nowStr(),
    period_id: periodId
  };

  repoAppendRow(SHEETS.OT, record);
  repoAppendAuditLog(emp.employee_id, 'CREATE_OT', SHEETS.OT, record.request_id, null, record, 'พนักงานยื่นขอทำโอทีผ่าน LINE');
  notifyApproverNewOT(record);
  return record;
}

function listMyOTs(employeeId) {
  const { rows } = repoReadAll(SHEETS.OT);
  return rows
    .filter(r => String(r.employee_id) === String(employeeId))
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))
    .slice(0, 30);
}

function listPendingOTs() {
  const { rows } = repoReadAll(SHEETS.OT);
  return rows
    .filter(r => String(r.status).toUpperCase() === 'PENDING')
    .sort((a, b) => String(a.ot_date).localeCompare(String(b.ot_date)));
}

function decideOT(requestId, isApproved, actorId, rejectReason) {
  const { rows } = repoReadAll(SHEETS.OT);
  const target = rows.find(r => r.request_id === requestId);
  if (!target) throw new Error('ไม่พบคำขอโอทีที่ระบุครับ');
  if (String(target.status).toUpperCase() !== 'PENDING') {
    throw new Error('คำขอโอทีนี้มีการดำเนินการไปแล้วครับ');
  }

  repoAssertPeriodEditable(target.ot_date);

  const updates = {
    status: isApproved ? 'APPROVED' : 'REJECTED',
    approved_start: isApproved ? target.requested_start : '',
    approved_end: isApproved ? target.requested_end : '',
    approved_hours: isApproved ? target.requested_hours : 0,
    approver_id: actorId,
    approved_at: nowStr(),
    reject_reason: isApproved ? '' : String(rejectReason || '').trim()
  };

  repoUpdateRow(SHEETS.OT, target._rowIndex, updates);
  repoAppendAuditLog(actorId, isApproved ? 'APPROVE_OT' : 'REJECT_OT', SHEETS.OT, requestId,
    { status: target.status }, updates, updates.reject_reason);

  notifyEmployeeDecision(target.employee_id, 'โอที (' + target.requested_hours + ' ชม.)', target.ot_date, isApproved, updates.reject_reason);
  return Object.assign({}, target, updates);
}
