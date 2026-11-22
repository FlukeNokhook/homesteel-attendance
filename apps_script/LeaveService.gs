/**
 * LeaveService.gs
 * ระบบกฎการลา (Leave Rules Engine):
 * - ไม่ปฏิเสธใบลาอัตโนมัติ (Never auto-reject) — บันทึกทุกใบลาแล้วติด Flag ให้ Admin ตรวจ
 * - รองรับเฉพาะ เต็มวัน (FULL_DAY) และ รายชั่วโมง (HOURS)
 * - ลาพักร้อน: รออนุมัติ (PENDING -> APPROVED / REJECTED)
 * - ลากิจ: บันทึกทันที (RECORDED) + แจ้งหัวหน้ารับทราบ + เช็กโควตา 3 วัน/ปี + ADVANCE/URGENT/LATE_NOTICE
 * - ลาป่วย: บันทึกทันที (RECORDED หรือ WAITING_MEDICAL_CERT) + นับครั้งที่ไม่มีใบรับรองแพทย์ของเดือน
 *   + ผู้อนุมัติเลือกได้ 2 ปุ่ม: "รับทราบและอนุมัติใช้สิทธิ์ได้" (ACKNOWLEDGED_PAID) หรือ "รับทราบและไม่อนุมัติการใช้สิทธิ์" (ACKNOWLEDGED_UNPAID)
 * - ตรวจจับการลาต่อเนื่องกัน >= 3 วันทำงาน (รวมทุกประเภทการลา) เพื่อแจ้ง Alert ผู้อนุมัติ
 */

function countLeaveDays(startDate, endDate) {
  const settings = repoGetSettings();
  const workingOnly = String(settings.COUNT_WORKING_DAYS_ONLY || 'TRUE').toUpperCase() === 'TRUE';
  const holidaySet = workingOnly ? repoGetHolidaySet() : new Set();

  let count = 0;
  const d = new Date(startDate + 'T00:00:00+07:00');
  const end = new Date(endDate + 'T00:00:00+07:00');
  while (d <= end) {
    const ds = Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
    if (!workingOnly || !isOffDay(ds, holidaySet)) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

function daysBetween(dateA, dateB) {
  const a = new Date(dateA + 'T00:00:00+07:00');
  const b = new Date(dateB + 'T00:00:00+07:00');
  return Math.round((b - a) / 86400000);
}

function shiftWorkingDay(dateStr, delta, holidaySet) {
  const d = new Date(dateStr + 'T00:00:00+07:00');
  for (let i = 0; i < 14; i++) {
    d.setDate(d.getDate() + delta);
    const ds = Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
    if (!isOffDay(ds, holidaySet)) return ds;
  }
  return dateStr;
}

/**
 * ตรวจจับการลาต่อเนื่องกันตั้งแต่ 3 วันทำงานขึ้นไป (รวมทุกประเภทลา: พักร้อน + กิจ + ป่วย + อื่นๆ)
 * ข้ามวันอาทิตย์และวันหยุดนักขัตฤกษ์ให้อัตโนมัติ
 */
function checkConsecutiveLeaves(employeeId, startDate, endDate, allLeaves, currentLeaveObj) {
  const holidaySet = repoGetHolidaySet();
  const dayMap = {};

  const addLeaveToMap = l => {
    const d = new Date(String(l.start_date) + 'T00:00:00+07:00');
    const e = new Date(String(l.end_date || l.start_date) + 'T00:00:00+07:00');
    let guard = 0;
    while (d <= e && guard < 60) {
      const ds = Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
      if (!isOffDay(ds, holidaySet)) {
        const sub = l.leave_type === 'ลาป่วย'
          ? (l.sub_type === 'SICK_WITH_CERT' ? 'มีใบรับรองฯ' : 'ไม่มีใบรับรองฯ')
          : '';
        dayMap[ds] = l.leave_type + (sub ? ' (' + sub + ')' : '');
      }
      d.setDate(d.getDate() + 1);
      guard++;
    }
  };

  allLeaves
    .filter(r => String(r.employee_id) === String(employeeId) && String(r.status).toUpperCase() !== 'REJECTED')
    .forEach(addLeaveToMap);
  if (currentLeaveObj) addLeaveToMap(currentLeaveObj);

  // เดินย้อนหลังและเดินหน้าจากช่วงวันที่ลา
  let curStart = startDate;
  while (true) {
    const prev = shiftWorkingDay(curStart, -1, holidaySet);
    if (dayMap[prev]) curStart = prev;
    else break;
  }
  let curEnd = endDate;
  while (true) {
    const next = shiftWorkingDay(curEnd, 1, holidaySet);
    if (dayMap[next]) curEnd = next;
    else break;
  }

  const timeline = [];
  const d = new Date(curStart + 'T00:00:00+07:00');
  const e = new Date(curEnd + 'T00:00:00+07:00');
  let guard = 0;
  while (d <= e && guard < 60) {
    const ds = Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
    if (dayMap[ds]) timeline.push(ds.slice(8, 10) + '/' + ds.slice(5, 7) + ' ' + dayMap[ds]);
    d.setDate(d.getDate() + 1);
    guard++;
  }

  return {
    consecutiveDays: timeline.length,
    isAlert: timeline.length >= 3,
    summaryText: timeline.length >= 3 ? ('ลาต่อเนื่อง ' + timeline.length + ' วันทำงาน: ' + timeline.join(' → ')) : ''
  };
}

/**
 * คำนวณสิทธิ์วันลาและประวัติการป่วยของเดือนนี้ (แสดงทั้งฝั่งพนักงานและฝั่งผู้อนุมัติ)
 */
function getLeaveQuotas(employeeId, refDateStr, preloadedRows) {
  const ref = refDateStr || todayStr();
  const year = ref.slice(0, 4);
  const ym = ref.slice(0, 7);

  const personalLimit = repoGetSettingNum('PERSONAL_LEAVE_LIMIT_DAYS', 3);
  const sickLimit = repoGetSettingNum('SICK_LEAVE_LIMIT_DAYS', 30);
  const sickNoCertMonthlyLimit = repoGetSettingNum('SICK_NO_CERT_MONTHLY_DAYS', 1);

  const rows = preloadedRows || repoReadAll(SHEETS.LEAVE).rows;
  const activeLeaves = rows.filter(r =>
    String(r.employee_id) === String(employeeId) &&
    String(r.status).toUpperCase() !== 'REJECTED'
  );

  let personalUsedYear = 0;
  let sickUsedYear = 0;
  let sickNoCertUsedMonth = 0;
  let sickCountMonth = 0;
  let sickWithCertCountMonth = 0;
  let sickNoCertCountMonth = 0;

  activeLeaves.forEach(l => {
    const sd = String(l.start_date || '');
    const d = Number(l.days || 0);
    if (sd.indexOf(year) === 0) {
      if (l.leave_type === 'ลากิจ') personalUsedYear += d;
      if (l.leave_type === 'ลาป่วย') sickUsedYear += d;
    }
    if (sd.indexOf(ym) === 0 && l.leave_type === 'ลาป่วย') {
      sickCountMonth++;
      if (String(l.sub_type) === 'SICK_WITH_CERT') {
        sickWithCertCountMonth++;
      } else {
        sickNoCertCountMonth++;
        sickNoCertUsedMonth += d;
      }
    }
  });

  return {
    year: year,
    yearMonth: ym,
    personalLimit: personalLimit,
    personalUsedYear: round2(personalUsedYear),
    personalRemaining: round2(Math.max(0, personalLimit - personalUsedYear)),
    sickLimit: sickLimit,
    sickUsedYear: round2(sickUsedYear),
    sickRemainingYear: round2(Math.max(0, sickLimit - sickUsedYear)),
    sickNoCertMonthlyLimit: sickNoCertMonthlyLimit,
    sickNoCertUsedMonth: round2(sickNoCertUsedMonth),
    sickNoCertRemainingMonth: round2(Math.max(0, sickNoCertMonthlyLimit - sickNoCertUsedMonth)),
    sickCountMonth: sickCountMonth,
    sickWithCertCountMonth: sickWithCertCountMonth,
    sickNoCertCountMonth: sickNoCertCountMonth
  };
}

function submitLeaveRequest(emp, payload) {
  const startDate = String(payload.start_date || '').trim();
  const durationMode = String(payload.duration_mode || 'FULL_DAY').toUpperCase();
  const endDate = durationMode === 'FULL_DAY' ? String(payload.end_date || startDate).trim() : startDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('กรุณาระบุวันที่ลาให้ถูกต้องครับ');
  if (endDate < startDate) throw new Error('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มลาครับ');

  const leaveType = String(payload.leave_type || '').trim();
  if (LEAVE_TYPES.indexOf(leaveType) === -1) throw new Error('กรุณาเลือกประเภทการลาครับ');

  const reason = String(payload.reason || '').trim();
  if (!reason) throw new Error('รบกวนระบุเหตุผลการลาสั้นๆ ด้วยนะครับ');

  const periodId = repoAssertPeriodEditable(startDate);
  if (endDate.slice(0, 7) !== startDate.slice(0, 7)) repoAssertPeriodEditable(endDate);

  const workHoursPerDay = repoGetSettingNum('WORK_HOURS_PER_DAY', 8);
  let hours = 0;
  let days = 0;

  if (durationMode === 'HOURS') {
    hours = Number(payload.hours || 0);
    if (!(hours >= 0.5 && hours < workHoursPerDay)) {
      throw new Error('จำนวนชั่วโมงลาต้องอยู่ระหว่าง 0.5 - ' + (workHoursPerDay - 0.5) + ' ชั่วโมงครับ');
    }
    days = Number((hours / workHoursPerDay).toFixed(3));
  } else {
    days = countLeaveDays(startDate, endDate);
    if (days === 0) throw new Error('ช่วงวันที่เลือกเป็นวันหยุดทั้งหมด ไม่จำเป็นต้องยื่นใบลาครับ');
    hours = days * workHoursPerDay;
  }

  let fileId = '';
  if (payload.attachment_base64) {
    const fname = 'leave_' + emp.employee_id + '_' + startDate + '_' + Date.now() + '.jpg';
    fileId = saveAttachmentToDrive(payload.attachment_base64, fname, payload.attachment_mime, startDate.slice(0, 7));
  }

  const allLeaves = repoReadAll(SHEETS.LEAVE).rows;
  const today = todayStr();
  const diffDays = daysBetween(today, startDate);
  const quotas = getLeaveQuotas(emp.employee_id, startDate, allLeaves);
  const flags = [];

  let subType = '';
  let noticeType = 'NORMAL';
  let urgentReason = String(payload.urgent_reason || '').trim();
  let status = 'RECORDED';
  let sickNoCertSeq = 0;

  if (leaveType === 'ลาพักร้อน') {
    status = 'PENDING';
    noticeType = diffDays > 0 ? 'ADVANCE' : (diffDays === 0 ? 'SAME_DAY' : 'LATE');
    if (diffDays < 0) flags.push('LATE_NOTICE');
  } else if (leaveType === 'ลากิจ') {
    status = 'RECORDED';
    const advanceDays = repoGetSettingNum('PERSONAL_ADVANCE_DAYS', 1);
    if (diffDays >= advanceDays) {
      noticeType = 'ADVANCE';
    } else if (diffDays === 0) {
      noticeType = 'URGENT';
      if (!urgentReason) urgentReason = 'เหตุกะทันหัน';
    } else {
      noticeType = 'LATE';
      flags.push('LATE_NOTICE');
    }
    if (quotas.personalUsedYear + days > quotas.personalLimit) {
      flags.push('PERSONAL_LIMIT_EXCEEDED');
    }
  } else if (leaveType === 'ลาป่วย') {
    subType = fileId ? 'SICK_WITH_CERT' : 'SICK_NO_CERT';
    const sickReasonType = String(payload.sick_reason_type || 'SUDDEN').toUpperCase();
    if (sickReasonType === 'APPOINTMENT') {
      noticeType = diffDays > 0 ? 'APPOINTMENT_ADVANCE' : 'APPOINTMENT_LATE';
      if (diffDays <= 0) flags.push('LATE_NOTICE');
    } else {
      noticeType = diffDays >= 0 ? 'SUDDEN' : 'LATE';
      if (diffDays < 0) flags.push('LATE_NOTICE');
    }
    if (quotas.sickUsedYear + days > quotas.sickLimit) {
      flags.push('SICK_LIMIT_EXCEEDED');
    }
    if (subType === 'SICK_NO_CERT') {
      sickNoCertSeq = quotas.sickNoCertCountMonth + 1;
      if (sickNoCertSeq > 1 || (quotas.sickNoCertUsedMonth + days > quotas.sickNoCertMonthlyLimit)) {
        status = 'WAITING_MEDICAL_CERT';
        flags.push('WAITING_MEDICAL_CERT');
      } else {
        status = 'RECORDED';
      }
    } else {
      status = 'RECORDED';
    }
  } else {
    status = 'RECORDED';
  }

  // ตรวจจับการลาต่อเนื่อง >= 3 วันทำงาน (รวมทุกประเภทลา)
  const consec = checkConsecutiveLeaves(emp.employee_id, startDate, endDate, allLeaves, {
    leave_type: leaveType, sub_type: subType, start_date: startDate, end_date: endDate
  });
  if (consec.isAlert) {
    flags.push('CONSECUTIVE_LEAVE_3PLUS');
  }

  const record = {
    request_id: generateId('LV'),
    employee_id: emp.employee_id,
    name: emp.name,
    leave_type: leaveType,
    sub_type: subType,
    start_date: startDate,
    end_date: endDate,
    duration_mode: durationMode === 'HOURS' ? 'HOURS' : 'FULL_DAY',
    hours: hours,
    days: days,
    reason: reason,
    notice_type: noticeType,
    urgent_reason: urgentReason,
    attachment_file_id: fileId,
    status: status,
    flags: flags.join(','),
    approver_id: '',
    approved_at: '',
    reject_reason: '',
    submitted_at: nowStr(),
    period_id: periodId
  };

  repoAppendRow(SHEETS.LEAVE, record);
  repoAppendAuditLog(emp.employee_id, 'CREATE_LEAVE', SHEETS.LEAVE, record.request_id, null, record, 'พนักงานยื่นใบลาผ่าน LINE');

  const updatedQuotas = getLeaveQuotas(emp.employee_id, startDate, allLeaves.concat([record]));
  notifyApproverNewLeave(record, {
    sickNoCertSeq: sickNoCertSeq,
    quotas: updatedQuotas,
    consecutiveAlert: consec.summaryText
  });

  return record;
}

function uploadMedicalCertForLeave(emp, requestId, base64Data, mimeType) {
  const { rows } = repoReadAll(SHEETS.LEAVE);
  const target = rows.find(r => r.request_id === requestId && String(r.employee_id) === String(emp.employee_id));
  if (!target) throw new Error('ไม่พบใบลาที่ระบุครับ');
  if (target.leave_type !== 'ลาป่วย') throw new Error('สามารถแนบใบรับรองแพทย์ได้เฉพาะใบลาป่วยครับ');

  repoAssertPeriodEditable(target.start_date);
  if (!base64Data) throw new Error('กรุณาเลือกรูปใบรับรองแพทย์ก่อนส่งครับ');

  const fname = 'medcert_' + emp.employee_id + '_' + target.start_date + '_' + Date.now() + '.jpg';
  const fileId = saveAttachmentToDrive(base64Data, fname, mimeType || 'image/jpeg', String(target.start_date).slice(0, 7));

  const remainFlags = String(target.flags || '')
    .split(',').map(f => f.trim()).filter(f => f && f !== 'WAITING_MEDICAL_CERT');

  const updates = {
    attachment_file_id: fileId,
    sub_type: 'SICK_WITH_CERT',
    status: target.status === 'WAITING_MEDICAL_CERT' ? 'RECORDED' : target.status,
    flags: remainFlags.join(',')
  };

  repoUpdateRow(SHEETS.LEAVE, target._rowIndex, updates);
  repoAppendAuditLog(emp.employee_id, 'UPLOAD_MEDICAL_CERT', SHEETS.LEAVE, requestId,
    { status: target.status, sub_type: target.sub_type, flags: target.flags },
    updates, 'พนักงานแนบใบรับรองแพทย์เพิ่มเติม');

  const updated = Object.assign({}, target, updates);
  notifyApproverMedicalCertUploaded(updated);
  return updated;
}

function listMyLeaves(employeeId) {
  const { rows } = repoReadAll(SHEETS.LEAVE);
  return rows
    .filter(r => String(r.employee_id) === String(employeeId))
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))
    .slice(0, 30);
}

function listPendingVacationLeaves() {
  const allRows = repoReadAll(SHEETS.LEAVE).rows;
  return allRows
    .filter(r => String(r.status).toUpperCase() === 'PENDING')
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))
    .map(r => enrichLeaveForApprover(r, allRows));
}

function listUnacknowledgedLeaves() {
  const allRows = repoReadAll(SHEETS.LEAVE).rows;
  return allRows
    .filter(r => ['RECORDED', 'WAITING_MEDICAL_CERT'].indexOf(String(r.status).toUpperCase()) !== -1 && !r.approved_at)
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))
    .slice(0, 50)
    .map(r => enrichLeaveForApprover(r, allRows));
}

/**
 * แนบข้อมูลประวัติการป่วยของเดือนนั้น + ลำดับครั้งที่ไม่มีใบรับรองแพทย์ + Alert ลาติดกัน 3 วัน
 * เพื่อให้ฝั่งผู้อนุมัติเห็นภาพครบก่อนกดตัดสินใจ
 */
function enrichLeaveForApprover(rec, allRows) {
  const out = Object.assign({}, rec);
  const consec = checkConsecutiveLeaves(rec.employee_id, rec.start_date, rec.end_date, allRows, null);
  out.consecutive_alert = consec.summaryText;

  if (rec.leave_type === 'ลาป่วย') {
    const ym = String(rec.start_date || '').slice(0, 7);
    const quotas = getLeaveQuotas(rec.employee_id, rec.start_date, allRows);
    // หาลำดับครั้งที่เท่าไหร่ของเดือน (สำหรับลาป่วยไม่มีใบรับรองแพทย์ เรียงตามเวลาที่ยื่น)
    let noCertSeq = 0;
    if (String(rec.sub_type) === 'SICK_NO_CERT') {
      const sameMonthNoCert = allRows
        .filter(r =>
          String(r.employee_id) === String(rec.employee_id) &&
          r.leave_type === 'ลาป่วย' &&
          String(r.sub_type) === 'SICK_NO_CERT' &&
          String(r.start_date).indexOf(ym) === 0 &&
          String(r.status).toUpperCase() !== 'REJECTED'
        )
        .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
      noCertSeq = sameMonthNoCert.findIndex(r => r.request_id === rec.request_id) + 1;
    }
    out.sick_info = {
      noCertSeq: noCertSeq,
      monthTotalCount: quotas.sickCountMonth,
      monthWithCertCount: quotas.sickWithCertCountMonth,
      monthNoCertCount: quotas.sickNoCertCountMonth,
      yearUsedDays: quotas.sickUsedYear,
      yearRemainingDays: quotas.sickRemainingYear,
      yearLimit: quotas.sickLimit
    };
  }
  return out;
}

function decideVacationLeave(requestId, isApproved, actorId, rejectReason) {
  const { rows } = repoReadAll(SHEETS.LEAVE);
  const target = rows.find(r => r.request_id === requestId);
  if (!target) throw new Error('ไม่พบใบลาที่ระบุครับ');
  if (String(target.status).toUpperCase() !== 'PENDING') {
    throw new Error('ใบลานี้มีการดำเนินการไปแล้วครับ');
  }

  repoAssertPeriodEditable(target.start_date);

  const updates = {
    status: isApproved ? 'APPROVED' : 'REJECTED',
    approver_id: actorId,
    approved_at: nowStr(),
    reject_reason: isApproved ? '' : String(rejectReason || '').trim()
  };

  repoUpdateRow(SHEETS.LEAVE, target._rowIndex, updates);
  repoAppendAuditLog(actorId, isApproved ? 'APPROVE_LEAVE' : 'REJECT_LEAVE', SHEETS.LEAVE, requestId,
    { status: target.status }, updates, updates.reject_reason);

  notifyEmployeeDecision(target.employee_id, target.leave_type, target.start_date, isApproved, updates.reject_reason);
  safeAutoRecompute(target.start_date);
  return Object.assign({}, target, updates);
}

/**
 * ผู้อนุมัติตัดสินใจใบลาป่วย (2 ปุ่มชัดเจน):
 * - allowBenefit = true  -> รับทราบการลา และ อนุมัติใช้สิทธิ์ได้ (ACKNOWLEDGED_PAID)
 * - allowBenefit = false -> รับทราบการลา และ ไม่อนุมัติการใช้สิทธิ์ (ACKNOWLEDGED_UNPAID)
 */
function decideSickLeaveBenefit(requestId, allowBenefit, actorId, note) {
  const { rows } = repoReadAll(SHEETS.LEAVE);
  const target = rows.find(r => r.request_id === requestId);
  if (!target) throw new Error('ไม่พบใบลาป่วยที่ระบุครับ');
  if (target.leave_type !== 'ลาป่วย') throw new Error('ฟังก์ชันนี้ใช้สำหรับใบลาป่วยเท่านั้นครับ');

  repoAssertPeriodEditable(target.start_date);

  const newStatus = allowBenefit ? 'ACKNOWLEDGED_PAID' : 'ACKNOWLEDGED_UNPAID';
  const updates = {
    status: newStatus,
    approver_id: actorId,
    approved_at: nowStr(),
    reject_reason: allowBenefit ? '' : String(note || 'ไม่อนุมัติการใช้สิทธิ์ลาป่วยแบบได้รับค่าจ้าง').trim()
  };

  repoUpdateRow(SHEETS.LEAVE, target._rowIndex, updates);
  repoAppendAuditLog(actorId, allowBenefit ? 'SICK_ACK_PAID' : 'SICK_ACK_UNPAID', SHEETS.LEAVE, requestId,
    { status: target.status }, updates, updates.reject_reason);

  notifyEmployeeSickDecision(target.employee_id, target.start_date, allowBenefit, updates.reject_reason);
  safeAutoRecompute(target.start_date);
  return Object.assign({}, target, updates);
}

function acknowledgeLeave(requestId, actorId) {
  const { rows } = repoReadAll(SHEETS.LEAVE);
  const target = rows.find(r => r.request_id === requestId);
  if (!target) throw new Error('ไม่พบใบลาที่ระบุครับ');

  const updates = {
    approver_id: actorId,
    approved_at: nowStr()
  };
  if (String(target.status).toUpperCase() === 'RECORDED') {
    updates.status = 'ACKNOWLEDGED';
  }

  repoUpdateRow(SHEETS.LEAVE, target._rowIndex, updates);
  repoAppendAuditLog(actorId, 'ACKNOWLEDGE_LEAVE', SHEETS.LEAVE, requestId,
    { status: target.status }, updates, 'รับทราบใบลา');

  notifyEmployeeAcknowledged(target.employee_id, target.leave_type, target.start_date);
  safeAutoRecompute(target.start_date);
  return Object.assign({}, target, updates);
}
