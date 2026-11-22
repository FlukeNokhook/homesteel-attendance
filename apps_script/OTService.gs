/**
 * OTService.gs
 * จัดการคำขอทำโอที:
 * - แสดงเวลาสแกนเข้า-ออกจริงของวันนั้นให้ผู้อนุมัติเห็นก่อนกดอนุมัติ
 * - ผู้อนุมัติสามารถแก้ไขเวลาเริ่ม-สิ้นสุด OT ก่อนกดอนุมัติได้
 * - รองรับตัวเลือก "จ่าย OT เต็มตามที่อนุมัติ (งานนอกสถานที่/ไม่เทียบสแกนนิ้ว)" โดยไม่แก้เวลาสแกนดิบ
 * - คำนวณ Attendance_Daily อัตโนมัติหลังอนุมัติ
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

/**
 * ดึงเวลาสแกนเข้า-ออกจริงของพนักงานในวันที่ระบุ (ดูจาก Attendance_Daily ก่อน ถ้ายังไม่มีค่อยดูจาก Attendance_Raw_YYYY)
 */
function getActualScanForDate(employeeId, dateStr) {
  const empId = String(employeeId);
  const daily = repoReadAll(SHEETS.ATTENDANCE_DAILY).rows.find(r =>
    String(r.employee_id) === empId && String(r.work_date) === dateStr
  );
  if (daily && (daily.first_in || daily.last_out)) {
    return { first_in: String(daily.first_in || ''), last_out: String(daily.last_out || '') };
  }
  try {
    const year = String(dateStr).slice(0, 4);
    const scans = repoReadRawByYear(year).rows
      .filter(s => String(s.employee_id) === empId && String(s.timestamp || '').indexOf(dateStr) === 0)
      .map(s => String(s.timestamp).slice(11, 16))
      .sort()
      .filter((t, i, arr) => i === 0 || parseHmToMinutes(t) - parseHmToMinutes(arr[i - 1]) > 2);
    return {
      first_in: scans.length > 0 ? scans[0] : '',
      last_out: scans.length > 1 ? scans[scans.length - 1] : ''
    };
  } catch (_) {
    return { first_in: '', last_out: '' };
  }
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

  const actualScan = getActualScanForDate(emp.employee_id, otDate);
  notifyApproverNewOT(record, actualScan);
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
    .sort((a, b) => String(a.ot_date).localeCompare(String(b.ot_date)))
    .map(r => {
      const scan = getActualScanForDate(r.employee_id, r.ot_date);
      return Object.assign({}, r, {
        actual_first_in: scan.first_in,
        actual_last_out: scan.last_out
      });
    });
}

/**
 * อนุมัติ / ไม่อนุมัติ OT
 * options (ไม่บังคับ): { approved_start, approved_end, skip_scan_cap }
 */
function decideOT(requestId, isApproved, actorId, rejectReason, options) {
  const { rows } = repoReadAll(SHEETS.OT);
  const target = rows.find(r => r.request_id === requestId);
  if (!target) throw new Error('ไม่พบคำขอโอทีที่ระบุครับ');
  if (String(target.status).toUpperCase() !== 'PENDING') {
    throw new Error('คำขอโอทีนี้มีการดำเนินการไปแล้วครับ');
  }

  repoAssertPeriodEditable(target.ot_date);

  const opts = options || {};
  let appStart = target.requested_start;
  let appEnd = target.requested_end;
  let appHours = Number(target.requested_hours || 0);

  if (isApproved && (opts.approved_start || opts.approved_end)) {
    appStart = String(opts.approved_start || target.requested_start).trim();
    appEnd = String(opts.approved_end || target.requested_end).trim();
    const w = otWindow(appStart, appEnd);
    if (!w || (w.end - w.start) < 1) {
      throw new Error('เวลาอนุมัติโอทีไม่ถูกต้องครับ');
    }
    appHours = Number(((w.end - w.start) / 60).toFixed(2));
  }

  const skipScanCap = isApproved && !!opts.skip_scan_cap;
  const updates = {
    status: isApproved ? 'APPROVED' : 'REJECTED',
    approved_start: isApproved ? appStart : '',
    approved_end: isApproved ? appEnd : '',
    actual_start: skipScanCap ? 'OFFSITE_OVERRIDE' : '',
    approved_hours: isApproved ? appHours : 0,
    approver_id: actorId,
    approved_at: nowStr(),
    reject_reason: isApproved ? '' : String(rejectReason || '').trim()
  };

  repoUpdateRow(SHEETS.OT, target._rowIndex, updates);
  repoAppendAuditLog(actorId, isApproved ? 'APPROVE_OT' : 'REJECT_OT', SHEETS.OT, requestId,
    { status: target.status, requested_start: target.requested_start, requested_end: target.requested_end },
    updates, skipScanCap ? 'อนุมัติ OT แบบจ่ายเต็ม (งานนอกสถานที่/ไม่เทียบสแกน)' : updates.reject_reason);

  notifyEmployeeDecision(
    target.employee_id,
    'โอที (' + (isApproved ? appHours : target.requested_hours) + ' ชม.)',
    target.ot_date,
    isApproved,
    updates.reject_reason
  );

  // อัปเดต Attendance_Daily เฉพาะวันและพนักงานคนนี้ (เร็วกว่าคำนวณใหม่ทั้งเดือน)
  if (isApproved) safeRecomputeEmployeeDates(target.employee_id, target.ot_date, target.ot_date);
  return Object.assign({}, target, updates);
}
