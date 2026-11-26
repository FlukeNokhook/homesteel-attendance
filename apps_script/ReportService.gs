/**
 * ReportService.gs
 * - แจ้งลืมสแกนนิ้ว (Missed_Scan) และดูเวลาเข้า-ออกของพนักงาน
 * - นำเข้าเวลาสแกนนิ้วแบบ Manual (เฟส 1) และรับข้อมูลจาก Gateway (เฟส 2) ลง Attendance_Raw_YYYY
 * - คำนวณสรุปรายวัน (Attendance_Daily) + ปรับแก้เวลาพร้อม Audit_Log (ไม่แก้ Raw)
 * - รวบรวม Exception List ครบทุกเงื่อนไข
 * - Export CSV ชีต Time Clock (15 คอลัมน์) + สรุปวันลา/โอทีรายคน
 * - จัดการสถานะงวดเงินเดือน (open / review / locked + unlock พร้อม Audit_Log)
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function minutesToHhMm(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  return Math.floor(m / 60) + ':' + pad2(m % 60);
}

function hoursToHhMm(hrs) {
  return minutesToHhMm(Math.round((Number(hrs) || 0) * 60));
}

function normalizeScanTime(input) {
  const s = String(input || '').trim().replace(/\s+/g, ' ');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]) + ' ' + pad2(m[4]) + ':' + m[5] + ':' + (m[6] || '00');
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y > 2400) y -= 543;
    return y + '-' + pad2(m[2]) + '-' + pad2(m[1]) + ' ' + pad2(m[4]) + ':' + m[5] + ':' + (m[6] || '00');
  }
  return '';
}

/* ================= Missed Scan & Employee Attendance ================= */

function submitMissedScan(emp, payload) {
  const workDate = String(payload.work_date || '').trim();
  const scanType = String(payload.scan_type || 'IN').toUpperCase();
  const approxTime = String(payload.approx_time || '').trim();
  const reason = String(payload.reason || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new Error('กรุณาระบุวันที่ให้ถูกต้องครับ');
  if (['IN', 'OUT', 'BOTH'].indexOf(scanType) === -1) throw new Error('กรุณาเลือกประเภทการลืมสแกนครับ');
  if (!reason) throw new Error('รบกวนระบุเหตุผลสั้นๆ ด้วยนะครับ');

  repoAssertPeriodEditable(workDate);

  const rec = {
    report_id: generateId('MS'),
    employee_id: emp.employee_id,
    name: emp.name,
    work_date: workDate,
    scan_type: scanType,
    approx_time: approxTime,
    reason: reason,
    status: 'OPEN',
    resolved_by: '',
    resolved_at: '',
    submitted_at: nowStr()
  };

  repoAppendRow(SHEETS.MISSED_SCAN, rec);
  repoAppendAuditLog(emp.employee_id, 'REPORT_MISSED_SCAN', SHEETS.MISSED_SCAN, rec.report_id, null, rec, 'พนักงานแจ้งลืมสแกนนิ้วผ่าน LINE');
  notifyApproverMissedScan(rec);
  return rec;
}

function listMyAttendance(employeeId, yearMonth) {
  const ym = yearMonth || Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM');
  const { rows } = repoReadAll(SHEETS.ATTENDANCE_DAILY);
  const { rows: missed } = repoReadAll(SHEETS.MISSED_SCAN);
  return {
    yearMonth: ym,
    daily: rows
      .filter(r => String(r.employee_id) === String(employeeId) && String(r.work_date).indexOf(ym) === 0)
      .sort((a, b) => String(b.work_date).localeCompare(String(a.work_date))),
    missedScans: missed
      .filter(m => String(m.employee_id) === String(employeeId))
      .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)))
      .slice(0, 15)
  };
}

/* ================= Raw Attendance Ingest (Manual Phase 1 + Gateway Phase 2) ================= */

function ingestRawScans(rowsInput, source, actor) {
  if (!Array.isArray(rowsInput) || rowsInput.length === 0) {
    throw new Error('ไม่พบข้อมูลสำหรับนำเข้าครับ');
  }

  const empRows = repoGetEmployees();
  const byYear = {};
  const invalidLines = [];
  const unknownIds = new Set();
  const affectedMonths = new Set();
  const receivedAt = nowStr();

  rowsInput.forEach((item, idx) => {
    const idOrFp = String(item.id || item.employee_id || item.fingerprint_id || '').trim();
    const ts = normalizeScanTime(item.timestamp || item.scan_time);
    if (!idOrFp || !ts) {
      invalidLines.push(idx + 1);
      return;
    }
    const emp = empRows.find(e => String(e.fingerprint_id) === idOrFp) ||
                empRows.find(e => String(e.employee_id) === idOrFp) ||
                empRows.find(e => String(e.code) === idOrFp);
    if (!emp) unknownIds.add(idOrFp);

    const empId = emp ? String(emp.employee_id) : idOrFp;
    const fpId = emp ? String(emp.fingerprint_id || emp.employee_id) : idOrFp;
    const deviceId = String(item.device_id || (source === 'MANUAL_IMPORT' ? 'MANUAL' : 'K50'));
    const txKey = item.transaction_key || (deviceId + '|' + fpId + '|' + ts.replace(/[-:\s]/g, ''));
    const year = ts.slice(0, 4);

    (byYear[year] = byYear[year] || []).push({
      transaction_key: txKey,
      device_id: deviceId,
      fingerprint_id: fpId,
      employee_id: empId,
      timestamp: ts,
      source: source,
      received_at: receivedAt
    });
    affectedMonths.add(ts.slice(0, 7));
  });

  let inserted = 0;
  let skipped = 0;

  Object.keys(byYear).forEach(year => {
    const existing = repoReadRawByYear(year).rows;
    const existingKeys = new Set(existing.map(r => String(r.transaction_key)));
    const fresh = [];
    byYear[year].forEach(r => {
      if (existingKeys.has(r.transaction_key)) {
        skipped++;
      } else {
        existingKeys.add(r.transaction_key);
        fresh.push(r);
      }
    });
    if (fresh.length) {
      repoAppendRawBulk(year, fresh);
      inserted += fresh.length;
    }
  });

  if (source === 'MANUAL_IMPORT') {
    repoAppendAuditLog(actor || 'admin', 'MANUAL_IMPORT_RAW', 'Attendance_Raw', 'BATCH_' + Date.now(),
      null, { inserted: inserted, skipped: skipped }, 'นำเข้าเวลาสแกนนิ้วแบบ Manual');
  }

  const recomputeErrors = [];
  affectedMonths.forEach(ym => {
    try {
      recomputeDailyForMonth(ym);
    } catch (e) {
      recomputeErrors.push(e.message);
    }
  });

  return {
    inserted: inserted,
    skipped: skipped,
    invalidLines: invalidLines.slice(0, 20),
    unknownIds: Array.from(unknownIds).slice(0, 20),
    recomputeErrors: recomputeErrors
  };
}

/* ================= Daily Calculation & Admin Corrections ================= */

function isEffectiveLeave(l) {
  const st = String(l.status).toUpperCase();
  const flags = String(l.flags || '');
  if (l.leave_type === 'ลาพักร้อน') return st === 'APPROVED';
  if (st === 'REJECTED' || st === 'ACKNOWLEDGED_UNPAID') return false;
  // ลากิจที่แจ้งล่วงหน้าน้อยกว่า 8 ชม. -> ถือเป็นวันขาดงาน ไม่นับชั่วโมงทำงาน
  if (l.leave_type === 'ลากิจ' && flags.indexOf('PERSONAL_UNDER_8H_UNPAID') !== -1) return false;
  // ลาป่วยไม่มีใบรับรองแพทย์ครั้งที่ 2+ ที่เลยกำหนดวันที่ 30 ของเดือนนั้นแล้ว -> ไม่นับชั่วโมงทำงาน
  if (st === 'WAITING_MEDICAL_CERT' && todayStr() > getMedCertDeadline(l.start_date)) return false;
  return true;
}

function computeDayMetrics(emp, dateStr, scanIn, scanOut, dayScansCount, dayLeaves, dayOTs, offDay, isFuture, settings, existingNote, existingManualStatus) {
  const shiftStart = parseHmToMinutes(settings.WORK_START_TIME || '08:00');
  const shiftEnd = parseHmToMinutes(settings.WORK_END_TIME || '17:00');
  const lunchMin = Number(settings.LUNCH_MINUTES || 60);
  const workHoursDay = Number(settings.WORK_HOURS_PER_DAY || 8);
  const workHoursMin = workHoursDay * 60;
  const graceMin = Number(settings.GRACE_LATE_MINUTES || 0);
  const shortWorkMin = Number(settings.SHORT_WORK_THRESHOLD_HOURS || 4) * 60;

  const leaveHours = offDay ? 0 : Math.min(workHoursDay, dayLeaves.reduce((acc, l) =>
    acc + (String(l.duration_mode) === 'FULL_DAY' ? workHoursDay : Number(l.hours || 0)), 0));
  const leaveMin = leaveHours * 60;
  const leaveType = dayLeaves.map(l => l.leave_type).join(', ');
  const otApprovedHours = dayOTs.reduce((acc, o) => acc + Number(o.approved_hours || o.requested_hours || 0), 0);

  let workMin = 0, lateMin = 0, earlyMin = 0, absentMin = 0, otActualMin = 0, otPaidHours = 0;
  let missingScan = '';
  const flags = [];
  const hasPair = !!(scanIn && scanOut);

  if (dayScansCount === 1 || (scanIn && !scanOut) || (!scanIn && scanOut)) {
    missingScan = !scanIn ? 'MISSING_IN' : 'MISSING_OUT';
    flags.push('ODD_SCAN');
  }

  // กรณีมีทั้งใบลาเต็มวันและมีสแกนนิ้วในวันเดียวกัน
  if (leaveHours >= workHoursDay && (scanIn || scanOut)) {
    flags.push('LEAVE_SCAN_CONFLICT');
  }

  if (hasPair) {
    const inMin = parseHmToMinutes(scanIn);
    const outMin = parseHmToMinutes(scanOut);
    if (!offDay) {
      if (inMin > shiftStart + graceMin) lateMin = inMin - shiftStart;
      if (outMin < shiftEnd) earlyMin = shiftEnd - outMin;
      let remain = leaveMin;
      const cutLate = Math.min(lateMin, remain); lateMin -= cutLate; remain -= cutLate;
      earlyMin = Math.max(0, earlyMin - remain);

      const rs = Math.max(inMin, shiftStart);
      const re = Math.min(outMin, shiftEnd);
      workMin = Math.max(0, re - rs - (rs < 12 * 60 && re > 13 * 60 ? lunchMin : 0));
      if (workMin < shortWorkMin && leaveMin === 0) {
        flags.push('SHORT_WORK');
      }
    } else {
      workMin = Math.max(0, outMin - inMin - (inMin < 12 * 60 && outMin > 13 * 60 ? lunchMin : 0));
    }

    dayOTs.forEach(o => {
      const reqMin = Math.round(Number(o.approved_hours || o.requested_hours || 0) * 60);
      if (String(o.actual_start || '') === 'OFFSITE_OVERRIDE') {
        otActualMin += reqMin;
        otPaidHours += reqMin / 60;
        return;
      }
      const w = otWindow(o.approved_start || o.requested_start, o.approved_end || o.requested_end);
      if (!w) return;
      const overlap = Math.max(0, Math.min(outMin, w.end) - Math.max(inMin, w.start));
      const paidMin = Math.min(reqMin, overlap);
      otActualMin += overlap;
      otPaidHours += paidMin / 60;
      if (paidMin < reqMin) flags.push('OT_CAPPED');
    });
  } else {
    if (!offDay && !isFuture && !scanIn && !scanOut) {
      absentMin = Math.max(0, workHoursMin - leaveMin);
    }
    dayOTs.forEach(o => {
      const reqMin = Math.round(Number(o.approved_hours || o.requested_hours || 0) * 60);
      if (String(o.actual_start || '') === 'OFFSITE_OVERRIDE') {
        otActualMin += reqMin;
        otPaidHours += reqMin / 60;
      } else if (!isFuture) {
        flags.push('OT_NO_SCAN');
      }
    });
  }

  const status = existingManualStatus === 'CORRECTED'
    ? 'CORRECTED'
    : (existingManualStatus === 'RESOLVED'
      ? 'RESOLVED'
      : (isFuture && !offDay && !scanIn && !scanOut
        ? 'UPCOMING'
        : (flags.length ? 'EXCEPTION' : (absentMin > 0 ? 'ABSENT' : (offDay && !scanIn ? 'OFF' : 'NORMAL')))));

  return {
    work_date: dateStr,
    employee_id: String(emp.employee_id),
    code: String(emp.code || emp.employee_id),
    name: emp.name,
    first_in: scanIn,
    last_out: scanOut,
    work_minutes: workMin,
    late_min: lateMin,
    early_leave_min: earlyMin,
    absent_min: absentMin,
    leave_hours: round2(leaveHours),
    leave_type: leaveType,
    ot_approved_hours: round2(otApprovedHours),
    ot_actual_min: otActualMin,
    ot_paid_hours: round2(otPaidHours),
    missing_scan: missingScan,
    status: status,
    flags: Array.from(new Set(flags)).join(','),
    admin_note: existingNote || '',
    period_id: dateStr.slice(0, 7),
    updated_at: nowStr()
  };
}

function recomputeDailyForMonth(yearMonth) {
  if (!/^\d{4}-\d{2}$/.test(String(yearMonth))) throw new Error('รูปแบบเดือนไม่ถูกต้อง');
  const period = repoGetOrCreatePeriod(yearMonth + '-01');
  if (String(period.status).toLowerCase() === 'locked') {
    throw new Error('งวดเดือน ' + yearMonth + ' ล็อกแล้ว จึงไม่คำนวณทับข้อมูลเดิมครับ');
  }

  const settings = repoGetSettings();
  const employees = repoGetEmployees().filter(isActiveEmp);
  const year = yearMonth.slice(0, 4);
  const rawScans = repoReadRawByYear(year).rows;
  const leaves = repoReadAll(SHEETS.LEAVE).rows.filter(isEffectiveLeave);
  const ots = repoReadAll(SHEETS.OT).rows.filter(o => String(o.status).toUpperCase() === 'APPROVED' && String(o.ot_date).indexOf(yearMonth) === 0);
  const holidaySet = repoGetHolidaySet();
  const today = todayStr();

  // คงค่าที่ Admin เคยแก้เวลาไว้เอง (CORRECTED) หรือกดตรวจแล้ว (RESOLVED)
  const existingDaily = repoReadAll(SHEETS.ATTENDANCE_DAILY).rows;
  const preservedMap = {};
  existingDaily.forEach(r => {
    const st = String(r.status);
    if (String(r.work_date).indexOf(yearMonth) === 0 && (st === 'CORRECTED' || st === 'RESOLVED')) {
      preservedMap[String(r.employee_id) + '|' + String(r.work_date)] = r;
    }
  });

  const scanIndex = {};
  rawScans.forEach(s => {
    const t = String(s.timestamp || '');
    if (t.indexOf(yearMonth) !== 0) return;
    const key = String(s.employee_id) + '|' + t.slice(0, 10);
    (scanIndex[key] = scanIndex[key] || []).push(t.slice(11, 16));
  });

  const p = yearMonth.split('-');
  const daysInMonth = new Date(parseInt(p[0], 10), parseInt(p[1], 10), 0).getDate();
  const headers = DB_SCHEMA.Attendance_Daily;
  const newRows = [];

  employees.forEach(emp => {
    const empId = String(emp.employee_id);
    const hireDate = String(emp.hire_date || '');

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = yearMonth + '-' + pad2(d);
      if (hireDate && dateStr < hireDate) continue;
      const offDay = isOffDay(dateStr, holidaySet);
      const isFuture = dateStr > today;

      const dayScans = (scanIndex[empId + '|' + dateStr] || [])
        .sort()
        .filter((t, i, arr) => i === 0 || parseHmToMinutes(t) - parseHmToMinutes(arr[i - 1]) > 2);

      const prev = preservedMap[empId + '|' + dateStr];
      const isCorrected = prev && String(prev.status) === 'CORRECTED';
      const scanIn = isCorrected ? String(prev.first_in || '') : (dayScans.length > 0 ? dayScans[0] : '');
      const scanOut = isCorrected ? String(prev.last_out || '') : (dayScans.length > 1 ? dayScans[dayScans.length - 1] : '');
      const scanCount = isCorrected ? ((scanIn ? 1 : 0) + (scanOut ? 1 : 0)) : dayScans.length;

      const dayLeaves = leaves.filter(l => String(l.employee_id) === empId && dateStr >= String(l.start_date) && dateStr <= String(l.end_date));
      const dayOTs = ots.filter(o => String(o.employee_id) === empId && String(o.ot_date) === dateStr);

      const obj = computeDayMetrics(emp, dateStr, scanIn, scanOut, scanCount, dayLeaves, dayOTs, offDay, isFuture, settings,
        prev ? prev.admin_note : '', prev ? String(prev.status) : '');
      newRows.push(headers.map(h => obj[h]));
    }
  });

  const sheet = repoGetMainDb().getSheetByName(SHEETS.ATTENDANCE_DAILY);
  const lastRow = sheet.getLastRow();
  let keep = [];
  if (lastRow > 1) {
    keep = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues().filter(r => {
      const wd = r[0] instanceof Date ? Utilities.formatDate(r[0], TIMEZONE, 'yyyy-MM-dd') : String(r[0]);
      return wd && wd.indexOf(yearMonth) !== 0;
    });
    sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  }
  repoWriteRowsAt(sheet, 2, keep.concat(newRows));

  return { rowsGenerated: newRows.length };
}

/**
 * เรียกคำนวณรายวันอัตโนมัติหลังอนุมัติ/รับทราบ โดยไม่ทำให้การอนุมัติล้มเหลวหากงวดถูกล็อก
 */
/**
 * อัปเดต Attendance_Daily เฉพาะพนักงานและวันที่ได้รับผลกระทบ (เร็วกว่าคำนวณทั้งเดือนมาก)
 * ใช้หลังกดอนุมัติ/รับทราบใน LIFF และ Admin เพื่อไม่ให้หน่วงเวลาตอบกลับ
 */
function safeRecomputeEmployeeDates(employeeId, startDate, endDate) {
  try {
    const emp = repoFindEmployeeById(employeeId);
    if (!emp) return;
    const sDate = String(startDate || '').trim();
    const eDate = String(endDate || sDate).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sDate)) return;

    const settings = repoGetSettings();
    const holidaySet = repoGetHolidaySet();
    const today = todayStr();
    const dailyData = repoReadAll(SHEETS.ATTENDANCE_DAILY).rows;
    const empLeaves = repoReadAll(SHEETS.LEAVE).rows.filter(l => isEffectiveLeave(l) && String(l.employee_id) === String(emp.employee_id));
    const empOTs = repoReadAll(SHEETS.OT).rows.filter(o => String(o.status).toUpperCase() === 'APPROVED' && String(o.employee_id) === String(emp.employee_id));

    const d = new Date(sDate + 'T00:00:00+07:00');
    const end = new Date(eDate + 'T00:00:00+07:00');
    let guard = 0;
    while (d <= end && guard < 14) {
      const dateStr = Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
      const existing = dailyData.find(r => String(r.employee_id) === String(emp.employee_id) && String(r.work_date) === dateStr);
      if (existing) {
        const scanIn = String(existing.first_in || '');
        const scanOut = String(existing.last_out || '');
        const scanCount = (scanIn ? 1 : 0) + (scanOut ? 1 : 0);
        const dayLeaves = empLeaves.filter(l => dateStr >= String(l.start_date) && dateStr <= String(l.end_date || l.start_date));
        const dayOTs = empOTs.filter(o => String(o.ot_date) === dateStr);
        const computed = computeDayMetrics(emp, dateStr, scanIn, scanOut, scanCount, dayLeaves, dayOTs,
          isOffDay(dateStr, holidaySet), dateStr > today, settings, existing.admin_note, existing.status === 'CORRECTED' ? 'CORRECTED' : '');
        repoUpdateRow(SHEETS.ATTENDANCE_DAILY, existing._rowIndex, computed);
      }
      d.setDate(d.getDate() + 1);
      guard++;
    }
  } catch (e) {
    Logger.log('safeRecomputeEmployeeDates skip: ' + e.message);
  }
}

function safeAutoRecompute(dateStr) {
  try {
    const ym = String(dateStr || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(ym)) {
      recomputeDailyForMonth(ym);
    }
  } catch (e) {
    Logger.log('safeAutoRecompute skip: ' + e.message);
  }
}

/**
 * Admin แก้ไขเวลาเข้า-ออกใน Attendance_Daily พร้อมเหตุผล (ห้ามแก้ Attendance_Raw เด็ดขาด)
 * และปิดสถานะรายการแจ้งลืมสแกนของวันนั้นให้อัตโนมัติ
 */
function adminCorrectDaily(workDate, employeeId, firstIn, lastOut, adminNote, reason, actor) {
  if (!reason) throw new Error('กรุณาระบุเหตุผลการแก้ไขเพื่อบันทึกใน Audit Log ครับ');
  if (String(workDate) > todayStr()) {
    throw new Error('วันที่ ' + workDate + ' ยังไม่ถึงวันทำงาน ไม่สามารถแก้ไขเวลาเข้า-ออกล่วงหน้าได้ครับ');
  }
  repoAssertPeriodEditable(workDate);

  const emp = repoFindEmployeeById(employeeId);
  if (!emp) throw new Error('ไม่พบข้อมูลพนักงานครับ');

  const settings = repoGetSettings();
  const holidaySet = repoGetHolidaySet();
  const offDay = isOffDay(workDate, holidaySet);
  const leaves = repoReadAll(SHEETS.LEAVE).rows.filter(l =>
    isEffectiveLeave(l) && String(l.employee_id) === String(emp.employee_id) &&
    workDate >= String(l.start_date) && workDate <= String(l.end_date));
  const ots = repoReadAll(SHEETS.OT).rows.filter(o =>
    String(o.status).toUpperCase() === 'APPROVED' && String(o.employee_id) === String(emp.employee_id) && String(o.ot_date) === workDate);

  const scanIn = String(firstIn || '').trim();
  const scanOut = String(lastOut || '').trim();
  const scanCount = (scanIn ? 1 : 0) + (scanOut ? 1 : 0);
  const computed = computeDayMetrics(emp, workDate, scanIn, scanOut, scanCount, leaves, ots, offDay, false, settings,
    adminNote || reason, 'CORRECTED');

  const { rows } = repoReadAll(SHEETS.ATTENDANCE_DAILY);
  const target = rows.find(r => String(r.employee_id) === String(emp.employee_id) && String(r.work_date) === workDate);

  if (target) {
    repoUpdateRow(SHEETS.ATTENDANCE_DAILY, target._rowIndex, computed);
    repoAppendAuditLog(actor || 'admin', 'CORRECT_ATTENDANCE', SHEETS.ATTENDANCE_DAILY, emp.employee_id + '|' + workDate,
      { first_in: target.first_in, last_out: target.last_out, admin_note: target.admin_note },
      { first_in: scanIn, last_out: scanOut, admin_note: computed.admin_note }, reason);
  } else {
    repoAppendRow(SHEETS.ATTENDANCE_DAILY, computed);
    repoAppendAuditLog(actor || 'admin', 'CORRECT_ATTENDANCE', SHEETS.ATTENDANCE_DAILY, emp.employee_id + '|' + workDate,
      null, { first_in: scanIn, last_out: scanOut, admin_note: computed.admin_note }, reason);
  }

  // ปิดรายการแจ้งลืมสแกน (Missed_Scan) ของพนักงานและวันเดียวกัน
  const missedRows = repoReadAll(SHEETS.MISSED_SCAN).rows;
  missedRows.forEach(m => {
    if (String(m.employee_id) === String(emp.employee_id) && String(m.work_date) === workDate && String(m.status) === 'OPEN') {
      repoUpdateRow(SHEETS.MISSED_SCAN, m._rowIndex, { status: 'RESOLVED', resolved_by: actor || 'admin', resolved_at: nowStr() });
    }
  });

  return computed;
}

/* ================= Exception List & Individual Report ================= */

function getMonthOverview(yearMonth) {
  const dailyRows = repoReadAll(SHEETS.ATTENDANCE_DAILY).rows.filter(r => String(r.work_date).indexOf(yearMonth) === 0);
  const leaves = repoReadAll(SHEETS.LEAVE).rows.filter(l => String(l.start_date).indexOf(yearMonth) === 0);
  const ots = repoReadAll(SHEETS.OT).rows.filter(o => String(o.ot_date).indexOf(yearMonth) === 0);
  const missed = repoReadAll(SHEETS.MISSED_SCAN).rows.filter(m => String(m.work_date).indexOf(yearMonth) === 0 && String(m.status) === 'OPEN');

  const exceptions = [];

  // 1. เคสจาก Attendance_Daily (ข้ามแถวที่กด "ตรวจแล้ว" RESOLVED)
  dailyRows.forEach(r => {
    if (String(r.status).toUpperCase() === 'RESOLVED') return;
    const flags = String(r.flags || '').split(',').filter(Boolean);
    if (flags.length || Number(r.absent_min) > 0) {
      const code = flags[0] || 'ABSENT';
      const labelMap = {
        ODD_SCAN: 'ลืมสแกนเข้าหรือออก',
        SHORT_WORK: 'ชั่วโมงทำงานน้อยผิดปกติ',
        OT_CAPPED: 'โอทีสแกนจริงน้อยกว่าที่อนุมัติ',
        OT_NO_SCAN: 'มีโอทีอนุมัติแต่ไม่มีสแกนนิ้วครบ',
        LEAVE_SCAN_CONFLICT: 'มีทั้งใบลาเต็มวันและสแกนนิ้วในวันเดียวกัน',
        ABSENT: 'ไม่พบสแกนนิ้วและไม่มีใบลา'
      };
      exceptions.push({
        kind: 'DAILY',
        target_id: r.employee_id + '|' + r.work_date,
        work_date: r.work_date,
        employee_id: r.employee_id,
        name: r.name,
        first_in: r.first_in,
        last_out: r.last_out,
        code: code,
        detail: flags.map(f => labelMap[f] || f).join(' • ') || labelMap.ABSENT
      });
    }
  });

  // 2. เคสแจ้งลืมสแกนนิ้วจากพนักงาน (Missed_Scan)
  missed.forEach(m => {
    exceptions.push({
      kind: 'MISSED_SCAN',
      target_id: m.report_id,
      work_date: m.work_date,
      employee_id: m.employee_id,
      name: m.name,
      first_in: '',
      last_out: '',
      code: 'MISSED_SCAN_REPORT',
      detail: 'พนักงานแจ้งลืมสแกน (' + m.scan_type + (m.approx_time ? ' ประมาณ ' + m.approx_time : '') + '): ' + m.reason
    });
  });

  // 3. เคสจากกฎการลา (ข้าม Flag ที่กดตรวจแล้ว REVIEWED แต่ยังแสดง PENDING_VACATION)
  leaves.forEach(l => {
    const rawFlags = String(l.flags || '').split(',').map(f => f.trim()).filter(f => f && f !== 'REVIEWED');
    if (String(l.status).toUpperCase() === 'PENDING') rawFlags.unshift('PENDING_VACATION');
    if (rawFlags.length) {
      const map = {
        PENDING_VACATION: 'ใบลาพักร้อนรออนุมัติ',
        WAITING_MEDICAL_CERT: 'รอใบรับรองแพทย์',
        SICK_LIMIT_EXCEEDED: 'ลาป่วยเกินโควตาปี',
        PERSONAL_LIMIT_EXCEEDED: 'ลากิจเกินโควตาปี',
        LATE_NOTICE: 'แจ้งลาช้ากว่ากำหนด',
        PERSONAL_UNDER_8H_UNPAID: 'ลากิจล่วงหน้าน้อยกว่า 8 ชม. (ถือเป็นขาดงาน ไม่นับ ชม. ทำงาน)',
        CONSECUTIVE_LEAVE_3PLUS: 'ลาต่อเนื่องตั้งแต่ 3 วันขึ้นไป',
        SAME_DAY_MULTI_LEAVE: 'มีใบลาหลายรายการในวันเดียวกัน'
      };
      exceptions.push({
        kind: 'LEAVE',
        target_id: l.request_id,
        work_date: l.start_date,
        employee_id: l.employee_id,
        name: l.name,
        first_in: '',
        last_out: '',
        code: rawFlags[0],
        detail: l.leave_type + ' • ' + rawFlags.map(f => map[f] || f).join(' • ')
      });
    }
  });

  // 4. เคส OT รออนุมัติ
  ots.filter(o => String(o.status).toUpperCase() === 'PENDING').forEach(o => {
    exceptions.push({
      kind: 'OT',
      target_id: o.request_id,
      work_date: o.ot_date,
      employee_id: o.employee_id,
      name: o.name,
      first_in: '',
      last_out: '',
      code: 'PENDING_OT',
      detail: 'คำขอโอที ' + o.requested_hours + ' ชม. รออนุมัติ (' + (o.job_reference || '-') + ')'
    });
  });

  exceptions.sort((a, b) => String(a.work_date).localeCompare(String(b.work_date)));
  const sum = k => dailyRows.reduce((s, r) => s + Number(r[k] || 0), 0);

  return {
    computed: dailyRows.length > 0,
    lastUpdated: dailyRows.reduce((m, r) => (String(r.updated_at) > m ? String(r.updated_at) : m), ''),
    stats: {
      exceptionCount: exceptions.length,
      lateCount: dailyRows.filter(r => Number(r.late_min) > 0).length,
      absentDays: round2(sum('absent_min') / 480),
      leaveHours: round2(sum('leave_hours')),
      otPaidHours: round2(sum('ot_paid_hours'))
    },
    exceptions: exceptions.slice(0, 300)
  };
}

/**
 * กด "ตรวจแล้ว" เพื่อปิดเคสใน Exception List และบันทึก Audit Log
 */
function resolveExceptionItem(kind, targetId, workDate, employeeId, actor) {
  if (kind === 'DAILY') {
    const { rows } = repoReadAll(SHEETS.ATTENDANCE_DAILY);
    const target = rows.find(r => String(r.employee_id) === String(employeeId) && String(r.work_date) === String(workDate));
    if (!target) throw new Error('ไม่พบข้อมูลรายวันที่ระบุครับ');
    const note = target.admin_note ? (target.admin_note + ' [ตรวจแล้ว]') : 'ตรวจแล้ว';
    repoUpdateRow(SHEETS.ATTENDANCE_DAILY, target._rowIndex, { status: 'RESOLVED', admin_note: note, updated_at: nowStr() });
    repoAppendAuditLog(actor || 'admin', 'RESOLVE_EXCEPTION', SHEETS.ATTENDANCE_DAILY, targetId,
      { status: target.status, flags: target.flags }, { status: 'RESOLVED' }, 'แอดมินกดตรวจแล้ว');
    return { ok: true };
  }
  if (kind === 'MISSED_SCAN') {
    const { rows } = repoReadAll(SHEETS.MISSED_SCAN);
    const target = rows.find(r => String(r.report_id) === String(targetId));
    if (!target) throw new Error('ไม่พบรายการแจ้งลืมสแกนครับ');
    repoUpdateRow(SHEETS.MISSED_SCAN, target._rowIndex, { status: 'RESOLVED', resolved_by: actor || 'admin', resolved_at: nowStr() });
    repoAppendAuditLog(actor || 'admin', 'RESOLVE_EXCEPTION', SHEETS.MISSED_SCAN, targetId,
      { status: target.status }, { status: 'RESOLVED' }, 'แอดมินกดตรวจแล้ว');
    return { ok: true };
  }
  if (kind === 'LEAVE') {
    const { rows } = repoReadAll(SHEETS.LEAVE);
    const target = rows.find(r => String(r.request_id) === String(targetId));
    if (!target) throw new Error('ไม่พบใบลาที่ระบุครับ');
    repoUpdateRow(SHEETS.LEAVE, target._rowIndex, { flags: 'REVIEWED' });
    repoAppendAuditLog(actor || 'admin', 'RESOLVE_EXCEPTION', SHEETS.LEAVE, targetId,
      { flags: target.flags }, { flags: 'REVIEWED' }, 'แอดมินกดตรวจ Flag ใบลาแล้ว');
    return { ok: true };
  }
  throw new Error('ไม่สามารถปิดเคสประเภทนี้ได้โดยตรง (กรุณาไปกดอนุมัติ/ไม่อนุมัติในแท็บ อนุมัติ / รับทราบ)');
}

function getIndividualTimesheet(employeeId, yearMonth) {
  const emp = repoFindEmployeeById(employeeId);
  if (!emp) throw new Error('ไม่พบข้อมูลพนักงานครับ');

  const holidayMap = repoGetHolidayMap();
  const holidaySet = new Set(Object.keys(holidayMap));
  const daily = repoReadAll(SHEETS.ATTENDANCE_DAILY).rows
    .filter(r => String(r.employee_id) === String(emp.employee_id) && String(r.work_date).indexOf(yearMonth) === 0)
    .sort((a, b) => String(a.work_date).localeCompare(String(b.work_date)))
    .map(r => Object.assign({}, r, {
      is_off_day: isOffDay(String(r.work_date), holidaySet),
      holiday_name: holidayMap[String(r.work_date)] || ''
    }));

  const leaves = repoReadAll(SHEETS.LEAVE).rows.filter(l =>
    String(l.employee_id) === String(emp.employee_id) &&
    (String(l.start_date).indexOf(yearMonth) === 0 || String(l.end_date).indexOf(yearMonth) === 0));
  const ots = repoReadAll(SHEETS.OT).rows.filter(o =>
    String(o.employee_id) === String(emp.employee_id) && String(o.ot_date).indexOf(yearMonth) === 0);
  const missedScans = repoReadAll(SHEETS.MISSED_SCAN).rows.filter(m =>
    String(m.employee_id) === String(emp.employee_id) && String(m.work_date).indexOf(yearMonth) === 0);

  const sum = k => daily.reduce((s, r) => s + Number(r[k] || 0), 0);
  const totalLateMin = sum('late_min');
  const totalAbsentMin = sum('absent_min');
  const totalLeaveHours = sum('leave_hours');

  return {
    employee: emp,
    yearMonth: yearMonth,
    daily: daily,
    leaves: leaves,
    ots: ots,
    missedScans: missedScans,
    quotas: getLeaveQuotas(emp.employee_id, yearMonth + '-01'),
    summary: {
      workDays: daily.filter(r => r.first_in).length,
      totalLateMin: totalLateMin,
      lateCount: daily.filter(r => Number(r.late_min) > 0).length,
      totalAbsentMin: totalAbsentMin,
      totalLeaveHours: round2(totalLeaveHours),
      totalOtApproved: round2(sum('ot_approved_hours')),
      totalOtPaid: round2(sum('ot_paid_hours')),
      diligenceEligible: totalLateMin === 0 && totalAbsentMin === 0 && totalLeaveHours === 0
    }
  };
}

/**
 * ตารางเวลาทำงานทั้งเดือนแบบ Matrix (พนักงานทุกคน × วันที่ 1–31) แยกสีดูง่ายในหน้าเดียว
 */
function getMonthlyMatrix(yearMonth) {
  const p = String(yearMonth).split('-');
  const y = parseInt(p[0], 10);
  const m = parseInt(p[1], 10);
  const daysInMonth = new Date(y, m, 0).getDate();
  const dowTh = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  const holidayMap = repoGetHolidayMap();
  const today = todayStr();

  const dayHeaders = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = yearMonth + '-' + pad2(d);
    const dowIdx = new Date(ds + 'T00:00:00+07:00').getDay();
    dayHeaders.push({
      day: d,
      date: ds,
      dow: dowTh[dowIdx],
      isSunday: dowIdx === 0,
      holidayName: holidayMap[ds] || ''
    });
  }

  const employees = repoGetEmployees().filter(isActiveEmp);
  const dailyRows = repoReadAll(SHEETS.ATTENDANCE_DAILY).rows
    .filter(r => String(r.work_date).indexOf(yearMonth) === 0);
  const ots = repoReadAll(SHEETS.OT).rows
    .filter(o => String(o.ot_date).indexOf(yearMonth) === 0 && String(o.status).toUpperCase() === 'APPROVED');

  const dailyMap = {};
  dailyRows.forEach(r => { dailyMap[String(r.employee_id) + '|' + String(r.work_date)] = r; });
  const offsiteSet = new Set();
  ots.forEach(o => {
    if (String(o.actual_start || '') === 'OFFSITE_OVERRIDE') {
      offsiteSet.add(String(o.employee_id) + '|' + String(o.ot_date));
    }
  });

  const rows = employees.map((emp, idx) => {
    const empId = String(emp.employee_id);
    const cells = dayHeaders.map(dh => {
      const r = dailyMap[empId + '|' + dh.date];
      const isFuture = dh.date > today;
      const isOffsite = offsiteSet.has(empId + '|' + dh.date);
      const otHrs = r ? Number(r.ot_paid_hours || 0) : 0;
      const otText = otHrs > 0 ? ('OT' + otHrs) : '';

      let type = 'empty';
      let text = '-';
      if (dh.holidayName && (!r || !r.first_in)) {
        type = 'holiday'; text = 'นักขัตฯ';
      } else if (dh.isSunday && (!r || !r.first_in)) {
        type = 'sunday'; text = 'หยุด';
      } else if (!r || r.status === 'UPCOMING' || (isFuture && !r.first_in && !r.last_out)) {
        type = 'upcoming'; text = '-';
      } else {
        const flags = String(r.flags || '');
        const late = Number(r.late_min || 0);
        const abs = Number(r.absent_min || 0);
        const lvHrs = Number(r.leave_hours || 0);
        const lvType = String(r.leave_type || '');

        if (flags.indexOf('ODD_SCAN') !== -1) {
          type = 'missed'; text = 'ลืมสแกน';
        } else if (abs > 0) {
          type = 'absent'; text = 'ขาด';
        } else if (lvHrs > 0 && !r.first_in) {
          type = 'leave';
          text = lvType.indexOf('ป่วย') !== -1 ? 'ป่วย' : (lvType.indexOf('กิจ') !== -1 ? 'กิจ' : (lvType.indexOf('พักร้อน') !== -1 ? 'พักร้อน' : 'ลา'));
        } else if (isOffsite || r.status === 'CORRECTED') {
          type = 'offsite'; text = 'นอก';
        } else if (late > 0) {
          type = 'late'; text = 'สาย ' + late;
        } else if (r.first_in) {
          type = 'normal'; text = '✓';
        } else {
          type = 'upcoming'; text = '-';
        }
      }

      const tip = r
        ? ((r.first_in || r.last_out) ? ('เข้า ' + (r.first_in || '-') + ' • ออก ' + (r.last_out || '-')) : text) +
          (otText ? ' • ' + otText : '') + (r.admin_note ? ' • ' + r.admin_note : '')
        : (dh.holidayName || (dh.isSunday ? 'วันอาทิตย์' : ''));

      return {
        date: dh.date,
        type: type,
        text: text,
        otText: otText,
        first_in: r ? (r.first_in || '') : '',
        last_out: r ? (r.last_out || '') : '',
        admin_note: r ? (r.admin_note || '') : '',
        isFuture: isFuture,
        tip: tip
      };
    });

    return {
      no: idx + 1,
      employee_id: empId,
      code: emp.code || empId,
      name: emp.name,
      nickname: emp.nickname || emp.name,
      cells: cells
    };
  });

  return { yearMonth: yearMonth, dayHeaders: dayHeaders, rows: rows };
}

/* ================= Export CSV (Excel Time Clock + Leave/OT Summary) ================= */

function csvEscape(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportTimeClockCsv(yearMonth) {
  const headers = [
    'รหัสพนักงาน', 'ชื่อ', 'วันที่', 'ตารางเวลา', 'เวลาทำงานจริง',
    'เวลาต้องทำ', 'โอที ระดับ1', 'โอที ระดับ2', 'โอที ระดับ3', 'มาสาย',
    'ออกก่อนเวลา', 'ขาดงาน', 'พักเที่ยง', 'เวลาเข้างาน', 'เวลาออกงาน'
  ];
  const holidaySet = repoGetHolidaySet();
  const filtered = repoReadAll(SHEETS.ATTENDANCE_DAILY).rows
    .filter(r => String(r.work_date).indexOf(yearMonth) === 0)
    .sort((a, b) => (Number(a.code || a.employee_id) - Number(b.code || b.employee_id)) ||
      String(a.work_date).localeCompare(String(b.work_date)));

  if (!filtered.length) throw new Error('ยังไม่มีข้อมูลสรุปของเดือนนี้ กรุณากด "คำนวณใหม่" ก่อน Export ครับ');

  const lines = [headers.join(',')];
  filtered.forEach(r => {
    const p = String(r.work_date).split('-');
    const off = isOffDay(String(r.work_date), holidaySet);
    lines.push([
      r.code || r.employee_id,
      r.name,
      p[2] + '/' + p[1] + '/' + p[0],
      off ? '' : 'ค่าเริ่มต้น',
      minutesToHhMm(r.work_minutes),
      off ? '0:00' : '8:00',
      hoursToHhMm(r.ot_paid_hours), // ตอนนี้โอทีทั้งหมดลงระดับ 1 ก่อน
      '0:00',
      '0:00',
      minutesToHhMm(r.late_min),
      minutesToHhMm(r.early_leave_min),
      minutesToHhMm(r.absent_min),
      off ? '0:00' : '1:00',
      r.first_in || '',
      r.last_out || ''
    ].map(csvEscape).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}

function exportLeaveOtSummaryCsv(yearMonth) {
  const headers = [
    'รหัสพนักงาน', 'ชื่อ', 'แผนก', 'วันมาทำงาน', 'มาสาย (นาที)', 'ขาดงาน (ชม.)',
    'ลาป่วย (ชม.)', 'ลากิจ (ชม.)', 'ลาพักร้อน (ชม.)', 'รอใบรับรองแพทย์ (รายการ)',
    'โอทีอนุมัติ (ชม.)', 'โอทีจ่ายจริง (ชม.)', 'สิทธิ์เบี้ยขยันเบื้องต้น'
  ];
  const employees = repoGetEmployees().filter(isActiveEmp);
  const daily = repoReadAll(SHEETS.ATTENDANCE_DAILY).rows.filter(r => String(r.work_date).indexOf(yearMonth) === 0);
  const leaves = repoReadAll(SHEETS.LEAVE).rows.filter(l => String(l.start_date).indexOf(yearMonth) === 0 && isEffectiveLeave(l));

  const lines = [headers.join(',')];
  employees.forEach(emp => {
    const id = String(emp.employee_id);
    const ed = daily.filter(r => String(r.employee_id) === id);
    const el = leaves.filter(l => String(l.employee_id) === id);
    const sumD = k => ed.reduce((s, r) => s + Number(r[k] || 0), 0);
    const sumL = type => el.filter(l => l.leave_type === type).reduce((s, l) => s + Number(l.hours || 0), 0);
    const lateMin = sumD('late_min');
    const absMin = sumD('absent_min');
    const leaveHrs = sumD('leave_hours');
    const waitingCert = el.filter(l => String(l.status) === 'WAITING_MEDICAL_CERT').length;

    lines.push([
      emp.code || id, emp.name, emp.department || '',
      ed.filter(r => r.first_in).length,
      lateMin, round2(absMin / 60),
      round2(sumL('ลาป่วย')), round2(sumL('ลากิจ')), round2(sumL('ลาพักร้อน')),
      waitingCert,
      round2(sumD('ot_approved_hours')), round2(sumD('ot_paid_hours')),
      (lateMin === 0 && absMin === 0 && leaveHrs === 0) ? 'ผ่านเกณฑ์' : 'ไม่ผ่าน'
    ].map(csvEscape).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}

/* ================= Period Status (open / review / locked + unlock) ================= */

function setPeriodStatus(yearMonth, newStatus, actor, reason) {
  const st = String(newStatus || '').toLowerCase();
  if (['open', 'review', 'locked'].indexOf(st) === -1) throw new Error('สถานะงวดไม่ถูกต้อง');
  const period = repoGetOrCreatePeriod(yearMonth + '-01');
  if (String(period.status).toLowerCase() === 'locked' && st !== 'locked' && !reason) {
    throw new Error('กรุณาระบุเหตุผลการปลดล็อกงวดเพื่อบันทึกใน Audit Log ครับ');
  }
  const updates = {
    status: st,
    locked_by: st === 'locked' ? (actor || 'admin') : '',
    locked_at: st === 'locked' ? nowStr() : ''
  };
  repoUpdateRow(SHEETS.PAYROLL_PERIOD, period._rowIndex, updates);
  repoAppendAuditLog(actor || 'admin', 'CHANGE_PERIOD_STATUS', SHEETS.PAYROLL_PERIOD, yearMonth,
    { status: period.status }, updates, reason || ('เปลี่ยนสถานะงวดเป็น ' + st));
  return Object.assign({}, period, updates);
}
