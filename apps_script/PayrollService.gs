/**
 * PayrollService.gs
 * เชื่อมต่อระบบลงเวลา/ลา/โอที (Factory_Payroll_DB) เข้ากับ Google Sheet เงินเดือน (PAYROLL_SHEET_ID)
 * โครงสร้าง Calculation ใหม่แบบ Simple (33 คอลัมน์ A-AG):
 *  - A-F: รหัส, ชื่อ-สกุล, ชื่อเล่น, ตำแหน่ง, วันเริ่มงาน, ฐานเงินเดือน
 *  - G-K: วันมาทำงาน, ชม.ทำงานปกติ, OT จ่ายจริง(ชม.), มาสายเกิน 5 น.(นาที), ขาดงาน(ชม.) [ซิงก์ตรงจาก Attendance_Daily]
 *  - L-R: OT(บาท), ค่าคอมฯ, ค่าวัดหน้างาน, ค่าหาโครง, เบี้ยขยัน, ค่าประจำตำแหน่ง, เงินพิเศษ/มือถือ
 *  - S-AA: หักขาดงาน, หักมาสาย(นาทีจริง), %PVD, หักPVD, หักยูนิฟอร์ม, หักสินค้า, หักเสียหาย, หักอื่นๆ, หักขาดวันห้ามหยุด
 *  - AB-AG: รายได้สุทธิ, ประกันสังคม(5% สูงสุด 875), ภาษี(PND 1), ยอดจ่ายสุทธิ, ธนาคาร, เลขบัญชี
 */

const CLEAN_CALC_HEADERS = [
  'รหัสพนักงาน', 'ชื่อ-นามสกุล', 'ชื่อเล่น', 'ตำแหน่ง', 'วันที่เริ่มงาน', 'ฐานเงินเดือน',
  'วันมาทำงาน', 'ชั่วโมงทำงานปกติ', 'OT จ่ายจริง (ชม.)', 'มาสาย (นาที)', 'ขาดงาน (ชม.)',
  'OT (บาท)', 'ค่าคอมมิชชั่น', 'ค่าวัดหน้างาน', 'ค่าหาโครง', 'เบี้ยขยัน', 'ค่าประจำตำแหน่ง', 'เงินพิเศษ / ค่ามือถือ',
  'หักขาดงาน (บาท)', 'หักมาสาย (บาท)', '% กองทุนสำรองฯ', 'หักกองทุนสำรองฯ',
  'หักค่าชุดยูนิฟอร์ม', 'หักค่าสินค้า', 'หักค่าเสียหาย', 'เงินหักอื่นๆ (ลืมสแกน)', 'หักขาดวันห้ามหยุด',
  'รายได้สุทธิ', 'ประกันสังคม', 'ภาษี (PND 1)', 'ยอดจ่ายเงินสุทธิ', 'ธนาคาร', 'เลขที่บัญชี'
];

function normEmpCode(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s.replace(/^0+/, '') || s;
}

function getPayrollDb() {
  const cfg = getAppConfig();
  if (!cfg.PAYROLL_SHEET_ID) {
    throw new Error('ยังไม่ได้ตั้งค่า PAYROLL_SHEET_ID ใน Script Properties (นำ ID ของ Google Sheet เงินเดือนมาใส่ก่อนครับ)');
  }
  return SpreadsheetApp.openById(cfg.PAYROLL_SHEET_ID);
}

/**
 * จัดระเบียบ Google Sheet เงินเดือน:
 * 1. สำรองชีต Calculation เดิมเป็น Calculation_Backup (ดึงฐานเงินเดือน/ธนาคาร/ค่าประจำตำแหน่งเดิมมาด้วย)
 * 2. สร้างชีต Calculation ใหม่แบบเรียบง่าย (33 คอลัมน์ A-AG) ผูกสูตรอัตโนมัติครบ
 * 3. ลบชีตที่ไม่ได้ใช้ (Sheet1, Sheet2, Attendant, เบี้ยขยันและเงินรางวัล) โดยเก็บ Time Clock ไว้ตรวจเทียบ
 */
function setupCleanPayrollSheet(actor) {
  const ss = getPayrollDb();

  // อ่านข้อมูลฐานเงินเดือน/ธนาคารเดิมจาก Calculation (ถ้ามี) เพื่อไม่ให้ต้องกรอกใหม่
  const oldMap = {};
  const oldCalc = ss.getSheetByName('Calculation');
  if (oldCalc && oldCalc.getLastRow() >= 3) {
    const lastCol = oldCalc.getLastColumn();
    const vals = oldCalc.getRange(1, 1, oldCalc.getLastRow(), Math.min(lastCol, 63)).getValues();
    const isAlreadyClean = String(vals[0][6] || '').indexOf('วันมาทำงาน') !== -1;
    for (let r = (isAlreadyClean ? 1 : 2); r < vals.length; r++) {
      const row = vals[r];
      const name = String(row[1] || '').trim();
      const nick = String(row[2] || '').trim();
      if (!name && !nick) continue;
      const info = isAlreadyClean ? {
        base_salary: Number(row[5]) || 0,
        position_allowance: Number(row[16]) || 0,
        phone_allowance: Number(row[17]) || 0,
        pvd_rate: Number(row[20]) || 0,
        bank: String(row[31] || ''),
        bank_account: String(row[32] || '')
      } : {
        base_salary: Number(row[5]) || 0,
        position_allowance: Number(row[46]) || 0,
        phone_allowance: Number(row[47]) || 0,
        pvd_rate: (Number(row[5]) > 0 && Number(row[50]) < 0) ? Math.round((Math.abs(Number(row[50])) / Number(row[5])) * 1000) / 1000 : 0,
        bank: String(row[61] || ''),
        bank_account: String(row[62] || '')
      };
      if (name) oldMap[name] = info;
      if (nick) oldMap[nick] = info;
    }

    // สำรองชีตเดิมไว้เป็น Calculation_Backup
    const oldBackup = ss.getSheetByName('Calculation_Backup');
    if (oldBackup) ss.deleteSheet(oldBackup);
    oldCalc.setName('Calculation_Backup');
  }

  const sheet = ss.insertSheet('Calculation', 0);
  sheet.getRange(1, 1, 1, CLEAN_CALC_HEADERS.length).setValues([CLEAN_CALC_HEADERS])
    .setFontWeight('bold').setBackground('#1e3a8a').setFontColor('#ffffff').setWrap(true);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(3);

  // เติมรายชื่อพนักงานจาก Factory_Payroll_DB > Employees
  const emps = repoGetEmployees().filter(isActiveEmp);
  const rows = emps.map((e, idx) => {
    const r = idx + 2;
    const old = oldMap[String(e.name || '').trim()] || oldMap[String(e.nickname || '').trim()] || {};
    return [
      e.code || e.employee_id,
      e.name || '',
      e.nickname || '',
      e.position || '',
      e.hire_date || '',
      old.base_salary || 0,
      0, 0, 0, 0, 0,
      `=ROUND(I${r}*(F${r}/240)*1.5, 2)`,
      `=IFERROR(VLOOKUP(C${r}, 'ค่าคอมฯ'!X:AA, 4, 0), 0)`,
      0,
      0,
      0,
      old.position_allowance || 0,
      old.phone_allowance || 0,
      `=ROUND(-K${r}*(F${r}/240), 2)`,
      `=ROUND(-(J${r}/60)*(F${r}/240), 2)`,
      old.pvd_rate || 0,
      `=ROUND(-F${r}*U${r}, 2)`,
      0, 0, 0, 0, 0,
      `=ROUND(F${r}+SUM(L${r}:T${r})+SUM(V${r}:AA${r}), 0)`,
      `=IF(F${r}<100, 0, -ROUND(MIN(F${r}*0.05, 875), 0))`,
      0,
      `=ROUNDUP(AB${r}+AC${r}+AD${r}, 0)`,
      old.bank || '',
      old.bank_account || ''
    ];
  });

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@');
    sheet.getRange(2, 33, rows.length, 1).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, CLEAN_CALC_HEADERS.length).setValues(rows);
    sheet.getRange(2, 6, rows.length, 1).setNumberFormat('#,##0.00');
    sheet.getRange(2, 12, rows.length, 9).setNumberFormat('#,##0.00');
    sheet.getRange(2, 21, rows.length, 1).setNumberFormat('0.0%');
    sheet.getRange(2, 22, rows.length, 10).setNumberFormat('#,##0.00');
  }

  // ลบชีตที่ไม่ได้ใช้ออก (ยังคง Time Clock, ค่าคอมฯ, ค่าวัดหน้างาน, ค่าหาโครง, Uniform, PND 1, สรุปบัญชีเงินเดือน, Calculation_Backup ไว้)
  const unusedTabs = ['Sheet1', 'Sheet2', 'Attendant', 'เบี้ยขยันและเงินรางวัล'];
  const deleted = [];
  unusedTabs.forEach(tabName => {
    const s = ss.getSheetByName(tabName);
    if (s) {
      ss.deleteSheet(s);
      deleted.push(tabName);
    }
  });

  repoAppendAuditLog(actor || 'admin', 'SETUP_CLEAN_PAYROLL', 'Calculation', 'INIT',
    null, { employeesAdded: rows.length, deletedTabs: deleted }, 'จัดโครงสร้างชีต Calculation ใหม่และลบชีตที่ไม่ได้ใช้');

  return { employeesAdded: rows.length, deletedTabs: deleted, sheetUrl: ss.getUrl() };
}

/**
 * ส่งข้อมูลของเดือนที่เลือกเข้า Google Sheet เงินเดือน:
 * 1. เขียนชีต "Time Clock" (15 คอลัมน์) เผื่อไว้ตรวจเทียบในช่วงแรก
 * 2. เขียนสรุปรายคนตรงเข้าชีต "Calculation" (วันมาทำงาน, ชม.ทำงาน, OT, นาทีสาย, ขาดงาน, เบี้ยขยันเบื้องต้น)
 */
function syncTimeClockToPayrollSheet(yearMonth, actor) {
  const payrollSs = getPayrollDb();

  // 1) เขียนชีต Time Clock (15 คอลัมน์)
  let tcSheet = payrollSs.getSheetByName('Time Clock');
  if (!tcSheet) tcSheet = payrollSs.insertSheet('Time Clock');

  const tcHeaders = [
    'รหัสพนักงาน', 'ชื่อ', 'วันที่', 'ตารางเวลา', 'เวลาทำงานจริง',
    'เวลาต้องทำ', 'โอที ระดับ1', 'โอที ระดับ2', 'โอที ระดับ3', 'มาสาย',
    'ออกก่อนเวลา', 'ขาดงาน', 'พักเที่ยง', 'เวลาเข้างาน', 'เวลาออกงาน'
  ];
  const holidaySet = repoGetHolidaySet();
  const dailyRows = repoReadAll(SHEETS.ATTENDANCE_DAILY).rows
    .filter(r => String(r.work_date).indexOf(yearMonth) === 0)
    .sort((a, b) => (Number(a.code || a.employee_id) - Number(b.code || b.employee_id)) ||
      String(a.work_date).localeCompare(String(b.work_date)));

  if (!dailyRows.length) {
    throw new Error('ยังไม่มีข้อมูลรายวันของเดือน ' + yearMonth + ' กรุณากด "คำนวณใหม่" ก่อนส่งข้อมูลครับ');
  }

  const tcData = [tcHeaders];
  const byEmp = {};

  dailyRows.forEach(r => {
    const p = String(r.work_date).split('-');
    const off = isOffDay(String(r.work_date), holidaySet);
    tcData.push([
      r.code || r.employee_id, r.name, p[2] + '/' + p[1] + '/' + p[0],
      off ? '' : 'ค่าเริ่มต้น',
      minutesToHhMm(r.work_minutes), off ? '0:00' : '8:00',
      hoursToHhMm(r.ot_paid_hours), '0:00', '0:00',
      minutesToHhMm(r.late_min), minutesToHhMm(r.early_leave_min), minutesToHhMm(r.absent_min),
      off ? '0:00' : '1:00', r.first_in || '', r.last_out || ''
    ]);

    const key = normEmpCode(r.code || r.employee_id);
    if (!byEmp[key]) {
      byEmp[key] = { workDays: 0, workMin: 0, otHours: 0, lateMin: 0, absentMin: 0, leaveHours: 0, missingScanCount: 0, days: [] };
    }
    if (r.first_in) byEmp[key].workDays++;
    byEmp[key].workMin += Number(r.work_minutes || 0);
    byEmp[key].otHours += Number(r.ot_paid_hours || 0);
    byEmp[key].lateMin += Number(r.late_min || 0);
    byEmp[key].absentMin += Number(r.absent_min || 0);
    byEmp[key].leaveHours += Number(r.leave_hours || 0);
    if (String(r.missing_scan || '').trim()) byEmp[key].missingScanCount++;
    byEmp[key].days.push(r);
  });

  tcSheet.clearContents();
  if (tcData.length > tcSheet.getMaxRows()) {
    tcSheet.insertRowsAfter(tcSheet.getMaxRows(), tcData.length - tcSheet.getMaxRows());
  }
  tcSheet.getRange(1, 1, tcData.length, tcHeaders.length).setValues(tcData);

  // 2) ส่งสรุปรายคนตรงเข้าชีต Calculation (โครงสร้างใหม่ A-AG) + เพิ่มพนักงานใหม่ที่เป็น ACTIVE ให้อัตโนมัติ
  let calcUpdated = 0;
  let calcAdded = 0;
  const calcSheet = payrollSs.getSheetByName('Calculation');
  if (calcSheet && calcSheet.getLastRow() >= 1 && String(calcSheet.getRange(1, 7).getValue()).indexOf('วันมาทำงาน') !== -1) {
    // ตรวจหาพนักงาน ACTIVE ที่ยังไม่มีใน Calculation แล้วเพิ่มแถวพร้อมสูตรให้อัตโนมัติ
    const existingCodes = new Set();
    if (calcSheet.getLastRow() >= 2) {
      calcSheet.getRange(2, 1, calcSheet.getLastRow() - 1, 1).getValues().forEach(c => {
        const k = normEmpCode(c[0]);
        if (k) existingCodes.add(k);
      });
    }
    const activeEmps = repoGetEmployees().filter(isActiveEmp);
    const missingEmps = activeEmps.filter(e => !existingCodes.has(normEmpCode(e.code || e.employee_id)));
    if (missingEmps.length) {
      const startRow = calcSheet.getLastRow() + 1;
      const newRows = missingEmps.map((e, idx) => {
        const r = startRow + idx;
        return [
          e.code || e.employee_id, e.name || '', e.nickname || '', e.position || '', e.hire_date || '', 0,
          0, 0, 0, 0, 0,
          `=ROUND(I${r}*(F${r}/240)*1.5, 2)`,
          `=IFERROR(VLOOKUP(C${r}, 'ค่าคอมฯ'!X:AA, 4, 0), 0)`,
          0,
          0,
          0, 0, 0,
          `=ROUND(-K${r}*(F${r}/240), 2)`,
          `=ROUND(-(J${r}/60)*(F${r}/240), 2)`,
          0,
          `=ROUND(-F${r}*U${r}, 2)`,
          0, 0, 0, 0, 0,
          `=ROUND(F${r}+SUM(L${r}:T${r})+SUM(V${r}:AA${r}), 0)`,
          `=IF(F${r}<100, 0, -ROUND(MIN(F${r}*0.05, 875), 0))`,
          0,
          `=ROUNDUP(AB${r}+AC${r}+AD${r}, 0)`,
          '', ''
        ];
      });
      if (startRow + newRows.length - 1 > calcSheet.getMaxRows()) {
        calcSheet.insertRowsAfter(calcSheet.getMaxRows(), newRows.length);
      }
      calcSheet.getRange(startRow, 1, newRows.length, 1).setNumberFormat('@');
      calcSheet.getRange(startRow, 33, newRows.length, 1).setNumberFormat('@');
      calcSheet.getRange(startRow, 1, newRows.length, CLEAN_CALC_HEADERS.length).setValues(newRows);
      calcSheet.getRange(startRow, 6, newRows.length, 1).setNumberFormat('#,##0.00');
      calcSheet.getRange(startRow, 12, newRows.length, 9).setNumberFormat('#,##0.00');
      calcSheet.getRange(startRow, 21, newRows.length, 1).setNumberFormat('0.0%');
      calcSheet.getRange(startRow, 22, newRows.length, 10).setNumberFormat('#,##0.00');
      calcAdded = newRows.length;
    }

    const lastRow = calcSheet.getLastRow();
    if (lastRow >= 2) {
      ensureBonusSheets();
      ensureEmployeeProfileColumns();
      const empByCode = {};
      repoReadAll(SHEETS.EMPLOYEES).rows.forEach(e => {
        const k = normEmpCode(e.code || e.employee_id);
        if (k) empByCode[k] = e;
      });

      const prevStreakMap = getPrevMonthDiligenceStreaks(yearMonth);
      const codes = calcSheet.getRange(2, 1, lastRow - 1, 1).getValues();
      const profileGrid = calcSheet.getRange(2, 2, lastRow - 1, 4).getValues(); // B-E: name, nickname, position, hire_date
      const baseSalaryCol = calcSheet.getRange(2, 6, lastRow - 1, 1).getValues(); // F: ฐานเงินเดือน
      const statsGrid = calcSheet.getRange(2, 7, lastRow - 1, 5).getValues();   // G-K
      const diligenceCol = calcSheet.getRange(2, 16, lastRow - 1, 1).getValues(); // P: เบี้ยขยัน
      const pvdCol = calcSheet.getRange(2, 21, lastRow - 1, 1).getValues();       // U: % PVD
      const uniformCol = calcSheet.getRange(2, 23, lastRow - 1, 1).getValues();   // W: หักชุดยูนิฟอร์ม
      const otherDedCol = calcSheet.getRange(2, 26, lastRow - 1, 1).getValues();  // Z: เงินหักอื่นๆ (ลืมสแกน)
      const forbidCol = calcSheet.getRange(2, 27, lastRow - 1, 1).getValues();    // AA: หักขาดวันห้ามหยุด
      const bankGrid = calcSheet.getRange(2, 32, lastRow - 1, 2).getValues();     // AF-AG: bank, account
      const monthlyLogs = [];

      for (let i = 0; i < codes.length; i++) {
        const code = normEmpCode(codes[i][0]);
        const emp = empByCode[code];
        const baseSalary = Number(baseSalaryCol[i][0]) || 0;
        let uniformDeduct = 0;

        if (emp) {
          if (emp.name) profileGrid[i][0] = emp.name;
          if (emp.nickname) profileGrid[i][1] = emp.nickname;
          if (emp.position) profileGrid[i][2] = emp.position;
          if (emp.hire_date) profileGrid[i][3] = repoNormalizeDate(emp.hire_date);
          if (emp.pvd_rate !== undefined && String(emp.pvd_rate).trim() !== '') {
            const rawPvd = Number(String(emp.pvd_rate).replace('%', '').trim());
            if (!isNaN(rawPvd)) {
              pvdCol[i][0] = rawPvd > 1 ? Math.round(rawPvd * 100) / 10000 : rawPvd;
            }
          }
          if (emp.bank_name) bankGrid[i][0] = String(emp.bank_name);
          if (emp.bank_account) bankGrid[i][1] = String(emp.bank_account);

          // หักมัดจำชุดยูนิฟอร์มอัตโนมัติ (เป้า 4,000 บาท)
          const paid = Number(emp.uniform_deposit_paid) || 0;
          const monthly = Number(emp.uniform_monthly_deduct) || 0;
          if (monthly > 0 && paid < 4000) {
            uniformDeduct = Math.min(monthly, Math.max(0, 4000 - paid));
            uniformCol[i][0] = -round2(uniformDeduct);
          } else if (monthly > 0 && paid >= 4000) {
            uniformCol[i][0] = 0;
          }
        }

        const st = byEmp[code];
        if (!st) continue;
        statsGrid[i] = [
          st.workDays,
          round2(st.workMin / 60),
          round2(st.otHours),
          Math.round(st.lateMin),
          round2(st.absentMin / 60)
        ];

        // 1) เบี้ยขยันต่อเนื่องอัตโนมัติ (500 -> 650 -> 800)
        const eligible = (st.lateMin === 0 && st.absentMin === 0 && st.leaveHours === 0 && st.workDays > 0);
        let streak = 0;
        let dilAmt = 0;
        if (eligible) {
          streak = (prevStreakMap[code] || 0) + 1;
          dilAmt = streak >= 3 ? 800 : (streak === 2 ? 650 : 500);
        }
        diligenceCol[i][0] = dilAmt;

        // 2) หักลืมสแกนนิ้วอัตโนมัติ (-10 บาท/ครั้ง)
        const missedPenalty = st.missingScanCount > 0 ? -(st.missingScanCount * 10) : 0;
        otherDedCol[i][0] = missedPenalty;

        // 3) หักขาดวันห้ามหยุดอัตโนมัติ (หยุดติดกัน >= 3 วัน -> ตั้งแต่วันที่ 3 หักรวม 3 เท่า)
        const forbid = computeForbidAbsentDeduction(st.days, baseSalary);
        forbidCol[i][0] = forbid.deductAmount;

        monthlyLogs.push({
          year_month: yearMonth,
          employee_id: emp ? String(emp.employee_id) : code,
          code: emp ? String(emp.code || code) : String(codes[i][0] || code),
          name: emp ? String(emp.name || '') : String(profileGrid[i][0] || ''),
          work_days: st.workDays,
          late_min: Math.round(st.lateMin),
          absent_min: Math.round(st.absentMin),
          leave_hours: round2(st.leaveHours),
          diligence_eligible: eligible ? 'TRUE' : 'FALSE',
          diligence_streak: streak,
          diligence_amount: dilAmt,
          missing_scan_count: st.missingScanCount,
          forbid_absent_days: forbid.daysCount,
          forbid_absent_deduct: forbid.deductAmount,
          uniform_deducted: round2(uniformDeduct),
          uniform_applied: 'FALSE',
          updated_at: nowStr()
        });
        calcUpdated++;
      }

      calcSheet.getRange(2, 2, lastRow - 1, 4).setValues(profileGrid);
      calcSheet.getRange(2, 7, lastRow - 1, 5).setValues(statsGrid);
      calcSheet.getRange(2, 16, lastRow - 1, 1).setValues(diligenceCol);
      calcSheet.getRange(2, 21, lastRow - 1, 1).setNumberFormat('0.0%').setValues(pvdCol);
      calcSheet.getRange(2, 23, lastRow - 1, 1).setValues(uniformCol);
      calcSheet.getRange(2, 26, lastRow - 1, 1).setValues(otherDedCol);
      calcSheet.getRange(2, 27, lastRow - 1, 1).setValues(forbidCol);
      calcSheet.getRange(2, 32, lastRow - 1, 2).setNumberFormat('@').setValues(bankGrid);

      upsertPayrollMonthlyLogs(yearMonth, monthlyLogs);
    }
  }

  // ซิงก์ยอดรวม ค่าวัดหน้างาน (N), ค่าหาโครง (O), ค่าคอมมิชชั่น (M), และอัปเดต สรุปบัญชีเงินเดือน
  syncBonusTotalsToCalculation(yearMonth);
  syncCommissionToCalculation(yearMonth);
  SpreadsheetApp.flush();
  updateMonthlyAccountingSummary(yearMonth, actor);

  repoAppendAuditLog(actor || 'admin', 'SYNC_PAYROLL', 'Calculation', yearMonth,
    null, { timeClockRows: tcData.length - 1, calcUpdated: calcUpdated, calcAdded: calcAdded }, 'ส่งข้อมูลเวลาเข้า Calculation + Time Clock');

  return { rowsWritten: tcData.length - 1, calcUpdated: calcUpdated, calcAdded: calcAdded, sheetUrl: payrollSs.getUrl() };
}

/**
 * อ่านข้อมูลสรุปเงินเดือนและสลิปจากชีต Calculation (รองรับโครงสร้างใหม่ A-AG และแจ้งเตือนถ้ายังเป็นโครงสร้างเก่า)
 */
function getPayrollDashboardData() {
  const payrollSs = getPayrollDb();
  const sheet = payrollSs.getSheetByName('Calculation');
  if (!sheet) throw new Error('ไม่พบชีต "Calculation" ใน Google Sheet เงินเดือนครับ');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { sheetUrl: payrollSs.getUrl(), isCleanLayout: true, periodTitle: '', employees: [] };

  const isCleanLayout = String(sheet.getRange(1, 7).getValue()).indexOf('วันมาทำงาน') !== -1;
  const maxCol = isCleanLayout ? 33 : Math.min(sheet.getLastColumn(), 63);
  const values = sheet.getRange(1, 1, lastRow, maxCol).getValues();

  const numVal = v => { const n = Number(v); return isNaN(n) ? 0 : Math.round(n * 100) / 100; };
  const dateFmt = v => (v instanceof Date ? Utilities.formatDate(v, TIMEZONE, 'dd/MM/yyyy') : String(v || ''));

  const empProfileByCode = {};
  repoGetEmployees().forEach(e => {
    const k = normEmpCode(e.code || e.employee_id);
    if (k) empProfileByCode[k] = e;
  });

  const employees = [];
  const startRow = isCleanLayout ? 1 : 2;
  for (let r = startRow; r < values.length; r++) {
    const row = values[r];
    const code = String(row[0] || '').trim();
    const name = String(row[1] || '').trim();
    const nickname = String(row[2] || '').trim();
    if (!name && !nickname) continue;
    if (name.indexOf('รวม') === 0 || code.indexOf('รวม') === 0) continue;
    const prof = empProfileByCode[normEmpCode(code)] || {};

    if (isCleanLayout) {
      employees.push({
        rowIndex: r + 1,
        code: code, name: name, nickname: nickname, position: String(row[3] || ''),
        title: String(prof.title || ''),
        national_id: String(prof.national_id || ''),
        email: String(prof.email || ''),
        pvd_join_date: repoNormalizeDate(prof.pvd_join_date || ''),
        hire_date: dateFmt(row[4]), hire_date_iso: repoNormalizeDate(prof.hire_date || row[4]),
        base_salary: numVal(row[5]),
        work_days: numVal(row[6]), work_hours: numVal(row[7]), ot15_hours: numVal(row[8]), late_min: numVal(row[9]), absent_hours: numVal(row[10]),
        ot_baht: numVal(row[11]), commission: numVal(row[12]), measurement: numVal(row[13]), frame_bonus: numVal(row[14]),
        diligence: numVal(row[15]), position_allowance: numVal(row[16]), phone_allowance: numVal(row[17]),
        deduct_absent: numVal(row[18]), deduct_late: numVal(row[19]),
        pvd_rate: (Number(row[20]) || 0) || ((Number(prof.pvd_rate) || 0) / 100),
        deduct_pvd: numVal(row[21]),
        deduct_uniform: numVal(row[22]), deduct_goods: numVal(row[23]), deduct_damage: numVal(row[24]),
        deduct_other: numVal(row[25]), deduct_forbid_absent: numVal(row[26]),
        gross_income: numVal(row[27]), sso: numVal(row[28]), tax: numVal(row[29]), net_pay: numVal(row[30]),
        bank: String(prof.bank_name || row[31] || ''), bank_account: String(prof.bank_account || row[32] || '')
      });
    } else {
      employees.push({
        rowIndex: r + 1,
        code: code, name: name, nickname: nickname, position: String(row[3] || ''),
        hire_date: dateFmt(row[4]), hire_date_iso: repoNormalizeDate(row[4]),
        base_salary: numVal(row[5]),
        work_hours: numVal(row[37]), ot15_hours: numVal(row[38]),
        ot_baht: numVal(row[41]), commission: numVal(row[42]), measurement: numVal(row[43]), frame_bonus: numVal(row[44]),
        diligence: numVal(row[45]), position_allowance: numVal(row[46]), phone_allowance: numVal(row[47]),
        deduct_absent: numVal(row[48]), deduct_pvd: numVal(row[50]), deduct_uniform: numVal(row[51]),
        deduct_goods: numVal(row[52]), deduct_damage: numVal(row[53]), deduct_other: numVal(row[54]),
        deduct_forbid_absent: numVal(row[55]), deduct_late: numVal(row[56]),
        gross_income: numVal(row[57]), sso: numVal(row[58]), tax: numVal(row[59]), net_pay: numVal(row[60]),
        bank: String(row[61] || ''), bank_account: String(row[62] || '')
      });
    }
  }

  return {
    sheetUrl: payrollSs.getUrl(),
    isCleanLayout: isCleanLayout,
    periodTitle: isCleanLayout ? '' : String(values[0][6] || ''),
    logoDataUrl: typeof COMPANY_LOGO_DATA_URL !== 'undefined' ? COMPANY_LOGO_DATA_URL : '',
    employees: employees
  };
}

/**
 * แปลงสลิปเงินเดือน HTML (พร้อมโลโก้บริษัท) เป็นไฟล์ PDF แล้วบันทึกเข้า Google Drive แบบ Private
 * โครงสร้างโฟลเดอร์: <DRIVE_FOLDER_ID>/PaySlips/<YYYY-MM>/
 */
function savePaySlipPdfToDrive(htmlContent, fileName, yearMonth, actor) {
  const cfg = getAppConfig();
  if (!cfg.DRIVE_FOLDER_ID) {
    throw new Error('ยังไม่ได้ตั้งค่า DRIVE_FOLDER_ID ใน Script Properties ครับ');
  }
  const root = DriveApp.getFolderById(cfg.DRIVE_FOLDER_ID);
  const slipsRoot = getOrCreateSubFolder(root, 'PaySlips');
  const monthFolder = getOrCreateSubFolder(slipsRoot, String(yearMonth || todayStr().slice(0, 7)));

  const safeName = String(fileName || 'PaySlip.pdf').replace(/[\\/:*?"<>|]/g, '_');
  const pdfBlob = Utilities.newBlob(htmlContent, 'text/html', 'slip.html')
    .getAs('application/pdf')
    .setName(safeName.endsWith('.pdf') ? safeName : safeName + '.pdf');

  // หากมีไฟล์ชื่อซ้ำในเดือนเดียวกัน ให้ลบไฟล์เก่าก่อนแล้วสร้างใหม่ (อัปเดตเวอร์ชันล่าสุด)
  const existing = monthFolder.getFilesByName(pdfBlob.getName());
  while (existing.hasNext()) existing.next().setTrashed(true);

  const file = monthFolder.createFile(pdfBlob);
  repoAppendAuditLog(actor || 'admin', 'SAVE_PAYSLIP_PDF', 'Drive_PaySlips', file.getId(),
    null, { fileName: file.getName(), yearMonth: yearMonth }, 'บันทึกสลิปเงินเดือน PDF ลง Google Drive');

  return {
    fileId: file.getId(),
    fileName: file.getName(),
    fileUrl: file.getUrl(),
    folderUrl: monthFolder.getUrl()
  };
}

function updatePayrollCalculationRow(rowIndex, updates, actor) {
  const payrollSs = getPayrollDb();
  const sheet = payrollSs.getSheetByName('Calculation');
  if (!sheet) throw new Error('ไม่พบชีต "Calculation" ใน Google Sheet เงินเดือนครับ');

  const isCleanLayout = String(sheet.getRange(1, 7).getValue()).indexOf('วันมาทำงาน') !== -1;
  const colMap = isCleanLayout ? {
    base_salary: 6, diligence: 16, position_allowance: 17, phone_allowance: 18,
    deduct_uniform: 23, deduct_goods: 24, deduct_damage: 25, deduct_other: 26, deduct_forbid_absent: 27, tax: 30
  } : {
    base_salary: 6, diligence: 46, position_allowance: 47, phone_allowance: 48,
    deduct_goods: 53, deduct_damage: 54, deduct_other: 55, deduct_forbid_absent: 56
  };

  const before = {};
  const after = {};
  Object.keys(colMap).forEach(key => {
    if (updates[key] !== undefined && updates[key] !== '') {
      const cell = sheet.getRange(rowIndex, colMap[key]);
      before[key] = cell.getValue();
      const val = Number(updates[key]);
      if (!isNaN(val)) { cell.setValue(val); after[key] = val; }
    }
  });

  SpreadsheetApp.flush();
  repoAppendAuditLog(actor || 'admin', 'EDIT_PAYROLL_ROW', 'Calculation', 'ROW_' + rowIndex, before, after, 'แก้ไขตัวเลขเงินเดือนจาก Dashboard');
  return { ok: true };
}

/* ================= Frame Finding (ค่าหาโครง) & Site Measure (ค่าวัดหน้างาน) ================= */

function calcFrameFindingFee(salesAmount) {
  const s = Number(salesAmount) || 0;
  if (s >= 200000) return 200;
  if (s >= 150000) return 150;
  if (s >= 100000) return 100;
  if (s >= 50000) return 50;
  if (s >= 1) return 40;
  return 0;
}

function calcSiteMeasureFee(salesAmount) {
  const s = Number(salesAmount) || 0;
  if (s >= 1000000) return 500;
  if (s >= 100000) return 300;
  if (s >= 20000) return 100;
  if (s >= 1) return 50;
  return 0;
}

function parseParticipantsJson(str) {
  try {
    const arr = JSON.parse(String(str || '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function getMonthBonusData(yearMonth) {
  ensureBonusSheets();
  const ym = String(yearMonth || '').trim();
  const frameRows = repoReadAll(SHEETS.FRAME_FINDING).rows
    .filter(r => String(r.year_month || '').trim() === ym)
    .map(r => ({
      record_id: String(r.record_id || ''),
      year_month: ym,
      employee_id: String(r.employee_id || ''),
      code: String(r.code || ''),
      name: String(r.name || ''),
      nickname: String(r.nickname || ''),
      bill_no: String(r.bill_no || ''),
      customer_name: String(r.customer_name || ''),
      sales_amount: Number(r.sales_amount) || 0,
      amount: Number(r.amount) || 0,
      note: String(r.note || ''),
      created_at: String(r.created_at || '')
    }));

  const allMeasureRows = repoReadAll(SHEETS.SITE_MEASURE).rows;
  const freqCount = {};
  allMeasureRows.forEach(r => {
    parseParticipantsJson(r.participants_json).forEach(p => {
      const id = String(p.employee_id || '').trim();
      if (id) freqCount[id] = (freqCount[id] || 0) + 1;
    });
  });
  const frequentMeasureEmpIds = Object.keys(freqCount)
    .sort((a, b) => freqCount[b] - freqCount[a])
    .slice(0, 6);

  const measureRows = allMeasureRows
    .filter(r => String(r.year_month || '').trim() === ym)
    .map(r => ({
      record_id: String(r.record_id || ''),
      year_month: ym,
      bill_no: String(r.bill_no || ''),
      customer_name: String(r.customer_name || ''),
      sales_amount: Number(r.sales_amount) || 0,
      total_amount: Number(r.total_amount) || 0,
      participants: parseParticipantsJson(r.participants_json),
      participants_summary: String(r.participants_summary || ''),
      note: String(r.note || ''),
      created_at: String(r.created_at || '')
    }));

  const frameByEmp = {};
  frameRows.forEach(r => {
    const k = normEmpCode(r.code || r.employee_id);
    if (!frameByEmp[k]) frameByEmp[k] = { code: r.code, name: r.name, nickname: r.nickname, count: 0, total: 0 };
    frameByEmp[k].count++;
    frameByEmp[k].total = round2(frameByEmp[k].total + r.amount);
  });

  const measureByEmp = {};
  measureRows.forEach(r => {
    r.participants.forEach(p => {
      const k = normEmpCode(p.code || p.employee_id);
      if (!measureByEmp[k]) measureByEmp[k] = { code: p.code, name: p.name, nickname: p.nickname, count: 0, total: 0 };
      measureByEmp[k].count++;
      measureByEmp[k].total = round2(measureByEmp[k].total + (Number(p.amount) || 0));
    });
  });

  return {
    yearMonth: ym,
    frameFindings: frameRows,
    siteMeasures: measureRows,
    frameSummary: Object.values(frameByEmp).sort((a, b) => b.total - a.total),
    measureSummary: Object.values(measureByEmp).sort((a, b) => b.total - a.total),
    frequentMeasureEmpIds: frequentMeasureEmpIds
  };
}

/**
 * รวมยอด ค่าวัดหน้างาน (คอลัมน์ N) และ ค่าหาโครง (คอลัมน์ O) ของเดือนที่เลือก
 * แล้วอัปเดตลงชีต Calculation ใน HomesteelKK_Salary โดยจับคู่จากรหัสพนักงาน (code)
 */
function syncBonusTotalsToCalculation(yearMonth) {
  try {
    ensureBonusSheets();
    const ym = String(yearMonth || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) return false;
    const cfg = getAppConfig();
    if (!cfg.PAYROLL_SHEET_ID) return false;

    const payrollSs = getPayrollDb();
    const calcSheet = payrollSs.getSheetByName('Calculation');
    if (!calcSheet || calcSheet.getLastRow() < 2) return false;
    if (String(calcSheet.getRange(1, 7).getValue()).indexOf('วันมาทำงาน') === -1) return false;

    const frameTotals = {};
    repoReadAll(SHEETS.FRAME_FINDING).rows
      .filter(r => String(r.year_month || '').trim() === ym)
      .forEach(r => {
        const k = normEmpCode(r.code || r.employee_id);
        frameTotals[k] = round2((frameTotals[k] || 0) + (Number(r.amount) || 0));
      });

    const measureTotals = {};
    repoReadAll(SHEETS.SITE_MEASURE).rows
      .filter(r => String(r.year_month || '').trim() === ym)
      .forEach(r => {
        parseParticipantsJson(r.participants_json).forEach(p => {
          const k = normEmpCode(p.code || p.employee_id);
          measureTotals[k] = round2((measureTotals[k] || 0) + (Number(p.amount) || 0));
        });
      });

    const lastRow = calcSheet.getLastRow();
    const codes = calcSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const measureCol = [];
    const frameCol = [];
    for (let i = 0; i < codes.length; i++) {
      const k = normEmpCode(codes[i][0]);
      measureCol.push([measureTotals[k] || 0]);
      frameCol.push([frameTotals[k] || 0]);
    }
    calcSheet.getRange(2, 14, lastRow - 1, 1).setValues(measureCol); // N: ค่าวัดหน้างาน
    calcSheet.getRange(2, 15, lastRow - 1, 1).setValues(frameCol);   // O: ค่าหาโครง
    SpreadsheetApp.flush();
    return true;
  } catch (e) {
    Logger.log('syncBonusTotalsToCalculation skip: ' + e.message);
    return false;
  }
}

function addFrameFinding(payload, actor) {
  ensureBonusSheets();
  const ym = String(payload.year_month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('กรุณาระบุเดือนให้ถูกต้องครับ');
  const emp = repoFindEmployeeById(payload.employee_id);
  if (!emp) throw new Error('กรุณาเลือกพนักงานที่หาโครงครับ');

  const sales = Number(payload.sales_amount) || 0;
  const amount = (payload.amount !== undefined && payload.amount !== '' && payload.amount !== null)
    ? Number(payload.amount) : calcFrameFindingFee(sales);
  if (isNaN(amount) || amount < 0) throw new Error('จำนวนเงินค่าหาโครงไม่ถูกต้องครับ');
  const customer = String(payload.customer_name || '').trim();
  const billNo = String(payload.bill_no || '').trim();
  if (!customer && !billNo) throw new Error('กรุณาระบุเลขที่บิลหรือชื่อลูกค้าอย่างน้อย 1 ช่องครับ');

  const rec = {
    record_id: generateId('FF'),
    year_month: ym,
    employee_id: String(emp.employee_id),
    code: String(emp.code || emp.employee_id),
    name: String(emp.name || ''),
    nickname: String(emp.nickname || ''),
    bill_no: billNo,
    customer_name: customer,
    sales_amount: round2(sales),
    amount: round2(amount),
    note: String(payload.note || '').trim(),
    created_by: actor || 'admin',
    created_at: nowStr()
  };

  repoAppendRow(SHEETS.FRAME_FINDING, rec);
  repoAppendAuditLog(actor || 'admin', 'ADD_FRAME_FINDING', SHEETS.FRAME_FINDING, rec.record_id, null, rec, 'เพิ่มรายการค่าหาโครงจาก Dashboard');
  const synced = syncBonusTotalsToCalculation(ym);
  return { ok: true, synced: synced, data: getMonthBonusData(ym) };
}

function updateFrameFinding(recordId, payload, actor) {
  ensureBonusSheets();
  const rows = repoReadAll(SHEETS.FRAME_FINDING).rows;
  const target = rows.find(r => String(r.record_id) === String(recordId));
  if (!target) throw new Error('ไม่พบรายการค่าหาโครงที่ต้องการแก้ไขครับ');

  const emp = repoFindEmployeeById(payload.employee_id || target.employee_id);
  if (!emp) throw new Error('ไม่พบข้อมูลพนักงานครับ');
  const sales = Number(payload.sales_amount) || 0;
  const amount = (payload.amount !== undefined && payload.amount !== '' && payload.amount !== null)
    ? Number(payload.amount) : calcFrameFindingFee(sales);
  if (isNaN(amount) || amount < 0) throw new Error('จำนวนเงินค่าหาโครงไม่ถูกต้องครับ');

  const updates = {
    employee_id: String(emp.employee_id),
    code: String(emp.code || emp.employee_id),
    name: String(emp.name || ''),
    nickname: String(emp.nickname || ''),
    bill_no: String(payload.bill_no || '').trim(),
    customer_name: String(payload.customer_name || '').trim(),
    sales_amount: round2(sales),
    amount: round2(amount),
    note: String(payload.note || '').trim()
  };
  repoUpdateRow(SHEETS.FRAME_FINDING, target._rowIndex, updates);
  repoAppendAuditLog(actor || 'admin', 'UPDATE_FRAME_FINDING', SHEETS.FRAME_FINDING, recordId, target, updates, 'แก้ไขรายการค่าหาโครงจาก Dashboard');
  const ym = String(target.year_month || '').trim();
  const synced = syncBonusTotalsToCalculation(ym);
  return { ok: true, synced: synced, data: getMonthBonusData(ym) };
}

function deleteFrameFinding(recordId, actor) {
  ensureBonusSheets();
  const rows = repoReadAll(SHEETS.FRAME_FINDING).rows;
  const target = rows.find(r => String(r.record_id) === String(recordId));
  if (!target) throw new Error('ไม่พบรายการค่าหาโครงที่ต้องการลบครับ');

  const ym = String(target.year_month || '').trim();
  repoDeleteRow(SHEETS.FRAME_FINDING, target._rowIndex);
  repoAppendAuditLog(actor || 'admin', 'DELETE_FRAME_FINDING', SHEETS.FRAME_FINDING, recordId, target, null, 'ลบรายการค่าหาโครงจาก Dashboard');
  const synced = syncBonusTotalsToCalculation(ym);
  return { ok: true, synced: synced, data: getMonthBonusData(ym) };
}

function buildSiteMeasureParticipants(rawList) {
  if (!Array.isArray(rawList) || !rawList.length) {
    throw new Error('กรุณาเลือกพนักงานที่ไปวัดหน้างานอย่างน้อย 1 คนครับ');
  }
  const out = [];
  rawList.forEach(item => {
    const emp = repoFindEmployeeById(item.employee_id);
    if (!emp) throw new Error('ไม่พบข้อมูลพนักงานรหัส ' + item.employee_id);
    const amt = round2(Number(item.amount) || 0);
    if (amt < 0) throw new Error('จำนวนเงินส่วนแบ่งต้องไม่ติดลบครับ');
    out.push({
      employee_id: String(emp.employee_id),
      code: String(emp.code || emp.employee_id),
      name: String(emp.name || ''),
      nickname: String(emp.nickname || ''),
      amount: amt
    });
  });
  const summary = out.map(p => `${p.code}-${p.nickname || p.name} (${p.amount})`).join(', ');
  const total = round2(out.reduce((s, p) => s + p.amount, 0));
  return { list: out, summary: summary, total: total };
}

function addSiteMeasure(payload, actor) {
  ensureBonusSheets();
  const ym = String(payload.year_month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('กรุณาระบุเดือนให้ถูกต้องครับ');
  const customer = String(payload.customer_name || '').trim();
  const billNo = String(payload.bill_no || '').trim();
  if (!customer && !billNo) throw new Error('กรุณาระบุเลขที่บิลหรือชื่อลูกค้าอย่างน้อย 1 ช่องครับ');

  const sales = Number(payload.sales_amount) || 0;
  const parts = buildSiteMeasureParticipants(payload.participants);
  const totalAmt = (payload.total_amount !== undefined && payload.total_amount !== '' && payload.total_amount !== null)
    ? round2(Number(payload.total_amount) || 0) : parts.total;

  const rec = {
    record_id: generateId('SM'),
    year_month: ym,
    bill_no: billNo,
    customer_name: customer,
    sales_amount: round2(sales),
    total_amount: totalAmt,
    participants_json: JSON.stringify(parts.list),
    participants_summary: parts.summary,
    note: String(payload.note || '').trim(),
    created_by: actor || 'admin',
    created_at: nowStr()
  };

  repoAppendRow(SHEETS.SITE_MEASURE, rec);
  repoAppendAuditLog(actor || 'admin', 'ADD_SITE_MEASURE', SHEETS.SITE_MEASURE, rec.record_id, null, rec, 'เพิ่มรายการค่าวัดหน้างานจาก Dashboard');
  const synced = syncBonusTotalsToCalculation(ym);
  return { ok: true, synced: synced, data: getMonthBonusData(ym) };
}

function updateSiteMeasure(recordId, payload, actor) {
  ensureBonusSheets();
  const rows = repoReadAll(SHEETS.SITE_MEASURE).rows;
  const target = rows.find(r => String(r.record_id) === String(recordId));
  if (!target) throw new Error('ไม่พบรายการค่าวัดหน้างานที่ต้องการแก้ไขครับ');

  const sales = Number(payload.sales_amount) || 0;
  const parts = buildSiteMeasureParticipants(payload.participants);
  const totalAmt = (payload.total_amount !== undefined && payload.total_amount !== '' && payload.total_amount !== null)
    ? round2(Number(payload.total_amount) || 0) : parts.total;

  const updates = {
    bill_no: String(payload.bill_no || '').trim(),
    customer_name: String(payload.customer_name || '').trim(),
    sales_amount: round2(sales),
    total_amount: totalAmt,
    participants_json: JSON.stringify(parts.list),
    participants_summary: parts.summary,
    note: String(payload.note || '').trim()
  };
  repoUpdateRow(SHEETS.SITE_MEASURE, target._rowIndex, updates);
  repoAppendAuditLog(actor || 'admin', 'UPDATE_SITE_MEASURE', SHEETS.SITE_MEASURE, recordId, target, updates, 'แก้ไขรายการค่าวัดหน้างานจาก Dashboard');
  const ym = String(target.year_month || '').trim();
  const synced = syncBonusTotalsToCalculation(ym);
  return { ok: true, synced: synced, data: getMonthBonusData(ym) };
}

function deleteSiteMeasure(recordId, actor) {
  ensureBonusSheets();
  const rows = repoReadAll(SHEETS.SITE_MEASURE).rows;
  const target = rows.find(r => String(r.record_id) === String(recordId));
  if (!target) throw new Error('ไม่พบรายการค่าวัดหน้างานที่ต้องการลบครับ');

  const ym = String(target.year_month || '').trim();
  repoDeleteRow(SHEETS.SITE_MEASURE, target._rowIndex);
  repoAppendAuditLog(actor || 'admin', 'DELETE_SITE_MEASURE', SHEETS.SITE_MEASURE, recordId, target, null, 'ลบรายการค่าวัดหน้างานจาก Dashboard');
  const synced = syncBonusTotalsToCalculation(ym);
  return { ok: true, synced: synced, data: getMonthBonusData(ym) };
}

/* ================= Monthly Commission (ค่าคอมมิชชั่น) ================= */

function defaultCommissionTeam(dept) {
  const d = String(dept || '').trim();
  if (d.indexOf('ขาย') !== -1) return 'sales';
  if (d.indexOf('ผลิต') !== -1 || d.indexOf('จัดส่ง') !== -1 || d.indexOf('วัดหน้างาน') !== -1) return 'prod';
  return 'none';
}

function getMonthCommissionData(yearMonth) {
  ensureBonusSheets();
  const ym = String(yearMonth || '').trim();
  const [yNum, mStr] = ym.split('-');
  const prevYm = (Number(yNum) - 1) + '-' + (mStr || '01');

  const commRows = repoReadAll(SHEETS.COMMISSION_MONTHLY).rows;
  const savedRow = commRows.find(r => String(r.year_month || '').trim() === ym) || null;
  const prevRow = commRows.find(r => String(r.year_month || '').trim() === prevYm) || null;

  // คำนวณชั่วโมงทำงานปกติ + วันลาที่ได้สิทธิ์ (ไม่รวม OT และไม่นับวันขาด) จาก Attendance_Daily
  const hoursByEmp = {};
  repoReadAll(SHEETS.ATTENDANCE_DAILY).rows
    .filter(r => String(r.work_date || '').indexOf(ym) === 0)
    .forEach(r => {
      const id = String(r.employee_id || '').trim();
      const hrs = (Number(r.work_minutes || 0) / 60) + Number(r.leave_hours || 0);
      hoursByEmp[id] = round2((hoursByEmp[id] || 0) + hrs);
    });

  let savedAllocs = null;
  if (savedRow && savedRow.allocations_json) {
    try { savedAllocs = JSON.parse(String(savedRow.allocations_json)); } catch (_) { savedAllocs = null; }
  }
  const savedAllocMap = {};
  if (Array.isArray(savedAllocs)) {
    savedAllocs.forEach(a => { savedAllocMap[String(a.employee_id)] = a; });
  }

  const emps = repoGetEmployees().filter(isActiveEmp).map(e => {
    const id = String(e.employee_id);
    const autoHrs = hoursByEmp[id] || 0;
    const prev = savedAllocMap[id];
    const team = prev ? prev.team : defaultCommissionTeam(e.department);
    return {
      employee_id: id,
      code: String(e.code || id),
      name: String(e.name || ''),
      nickname: String(e.nickname || ''),
      department: String(e.department || ''),
      position: String(e.position || ''),
      team: team,
      included: prev ? !!prev.included : (team === 'sales' || team === 'prod'),
      auto_hours: autoHrs,
      hours: prev !== undefined && prev.hours !== undefined ? Number(prev.hours) : autoHrs,
      amount: prev ? Number(prev.amount || 0) : 0
    };
  });

  const saved = savedRow ? {
    year_month: ym,
    gross_sales: Number(savedRow.gross_sales) || 0,
    prev_year_sales: Number(savedRow.prev_year_sales) || 0,
    capital: savedRow.capital !== '' ? Number(savedRow.capital) : 100000,
    credit_note: Number(savedRow.credit_note) || 0,
    incident_case: Number(savedRow.incident_case) || 0,
    supercoil: savedRow.supercoil !== '' ? Number(savedRow.supercoil) : 18000,
    pv_project_sales: Number(savedRow.pv_project_sales) || 0,
    extra_prod_sales: Number(savedRow.extra_prod_sales) || 0,
    sales_kpi_deduct: Number(savedRow.sales_kpi_deduct) || 0,
    prod_kpi_deduct: Number(savedRow.prod_kpi_deduct) || 0,
    updated_at: String(savedRow.updated_at || '')
  } : null;

  return {
    yearMonth: ym,
    prevYearMonth: prevYm,
    prevYearAutoSales: prevRow ? (Number(prevRow.gross_sales) || 0) : 0,
    saved: saved,
    employees: emps
  };
}

function saveMonthCommission(payload, actor) {
  ensureBonusSheets();
  const ym = String(payload.year_month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('กรุณาระบุเดือนให้ถูกต้องครับ');

  const gross = Number(payload.gross_sales) || 0;
  const prevYear = Number(payload.prev_year_sales) || 0;
  const capital = Number(payload.capital) || 0;
  const creditNote = Number(payload.credit_note) || 0;
  const incident = Number(payload.incident_case) || 0;
  const supercoil = Number(payload.supercoil) || 0;
  const pvSales = Number(payload.pv_project_sales) || 0;
  const extraProd = Number(payload.extra_prod_sales) || 0;
  const salesKpi = Math.abs(Number(payload.sales_kpi_deduct) || 0);
  const prodKpi = Math.abs(Number(payload.prod_kpi_deduct) || 0);

  const netSales = round2(gross - (capital + creditNote + incident + supercoil));
  const frontStore = round2(netSales - pvSales);
  const isHigherYoY = (prevYear > 0 && gross > prevYear);
  const rateFull = isHigherYoY ? 0.15 : 0.10;
  const rateHalf = isHigherYoY ? 0.075 : 0.05;

  const salesPool = Math.max(0, round2(
    round2(frontStore * (rateFull / 100)) + round2(pvSales * (rateHalf / 100)) - salesKpi
  ));
  const prodPool = Math.max(0, round2(
    round2((frontStore + extraProd) * (rateFull / 100)) + round2(pvSales * (rateHalf / 100)) - prodKpi
  ));

  const members = Array.isArray(payload.members) ? payload.members : [];
  const salesMembers = members.filter(m => m.team === 'sales' && m.included && Number(m.hours) > 0);
  const prodMembers = members.filter(m => m.team === 'prod' && m.included && Number(m.hours) > 0);
  const salesHrsTotal = round2(salesMembers.reduce((s, m) => s + Number(m.hours || 0), 0));
  const prodHrsTotal = round2(prodMembers.reduce((s, m) => s + Number(m.hours || 0), 0));

  const empMap = {};
  repoGetEmployees().forEach(e => { empMap[String(e.employee_id)] = e; });

  const allocations = members.map(m => {
    const e = empMap[String(m.employee_id)] || {};
    const hrs = round2(Number(m.hours) || 0);
    let amt = 0;
    if (m.included && hrs > 0) {
      if (m.team === 'sales' && salesHrsTotal > 0) amt = round2((salesPool / salesHrsTotal) * hrs);
      else if (m.team === 'prod' && prodHrsTotal > 0) amt = round2((prodPool / prodHrsTotal) * hrs);
    }
    return {
      employee_id: String(m.employee_id),
      code: String(e.code || m.code || m.employee_id),
      name: String(e.name || m.name || ''),
      nickname: String(e.nickname || m.nickname || ''),
      team: String(m.team || 'none'),
      included: !!m.included,
      hours: hrs,
      amount: amt
    };
  });

  const rec = {
    year_month: ym,
    gross_sales: round2(gross),
    prev_year_sales: round2(prevYear),
    capital: round2(capital),
    credit_note: round2(creditNote),
    incident_case: round2(incident),
    supercoil: round2(supercoil),
    net_sales: netSales,
    pv_project_sales: round2(pvSales),
    front_store_sales: frontStore,
    extra_prod_sales: round2(extraProd),
    rate_full_pct: rateFull,
    rate_half_pct: rateHalf,
    sales_kpi_deduct: round2(salesKpi),
    prod_kpi_deduct: round2(prodKpi),
    sales_pool: salesPool,
    prod_pool: prodPool,
    sales_hours_total: salesHrsTotal,
    prod_hours_total: prodHrsTotal,
    allocations_json: JSON.stringify(allocations),
    updated_by: actor || 'admin',
    updated_at: nowStr()
  };

  const existing = repoReadAll(SHEETS.COMMISSION_MONTHLY).rows.find(r => String(r.year_month || '').trim() === ym);
  if (existing) {
    repoUpdateRow(SHEETS.COMMISSION_MONTHLY, existing._rowIndex, rec);
  } else {
    repoAppendRow(SHEETS.COMMISSION_MONTHLY, rec);
  }

  repoAppendAuditLog(actor || 'admin', 'SAVE_COMMISSION', SHEETS.COMMISSION_MONTHLY, ym,
    existing || null, { gross_sales: gross, prev_year_sales: prevYear, rate_full_pct: rateFull, sales_pool: salesPool, prod_pool: prodPool },
    'บันทึกค่าคอมมิชชั่นประจำเดือนจาก Dashboard');

  const synced = syncCommissionToCalculation(ym);
  return { ok: true, synced: synced, data: getMonthCommissionData(ym) };
}

function syncCommissionToCalculation(yearMonth) {
  try {
    ensureBonusSheets();
    const ym = String(yearMonth || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) return false;
    const cfg = getAppConfig();
    if (!cfg.PAYROLL_SHEET_ID) return false;

    const savedRow = repoReadAll(SHEETS.COMMISSION_MONTHLY).rows.find(r => String(r.year_month || '').trim() === ym);
    if (!savedRow || !savedRow.allocations_json) return false;

    const allocs = parseParticipantsJson(savedRow.allocations_json);
    const commByCode = {};
    allocs.forEach(a => {
      const k = normEmpCode(a.code || a.employee_id);
      if (k) commByCode[k] = round2((commByCode[k] || 0) + (Number(a.amount) || 0));
    });

    const payrollSs = getPayrollDb();
    const calcSheet = payrollSs.getSheetByName('Calculation');
    if (!calcSheet || calcSheet.getLastRow() < 2) return false;
    if (String(calcSheet.getRange(1, 7).getValue()).indexOf('วันมาทำงาน') === -1) return false;

    const lastRow = calcSheet.getLastRow();
    const codes = calcSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const commCol = codes.map(c => [commByCode[normEmpCode(c[0])] || 0]);
    calcSheet.getRange(2, 13, lastRow - 1, 1).setValues(commCol);
    SpreadsheetApp.flush();
    return true;
  } catch (e) {
    Logger.log('syncCommissionToCalculation skip: ' + e.message);
    return false;
  }
}

function getYearGrossSales(year) {
  ensureBonusSheets();
  const y = String(year || '').trim();
  const rows = repoReadAll(SHEETS.COMMISSION_MONTHLY).rows;
  const map = {};
  rows.forEach(r => {
    const ym = String(r.year_month || '').trim();
    if (ym.indexOf(y + '-') === 0) {
      map[ym] = Number(r.gross_sales) || 0;
    }
  });
  return { year: y, months: map };
}

function saveYearGrossSales(year, monthlyMap, actor) {
  ensureBonusSheets();
  const y = String(year || '').trim();
  if (!/^\d{4}$/.test(y)) throw new Error('รูปแบบปีไม่ถูกต้องครับ');
  const existingRows = repoReadAll(SHEETS.COMMISSION_MONTHLY).rows;
  const byYm = {};
  existingRows.forEach(r => { byYm[String(r.year_month || '').trim()] = r; });

  let savedCount = 0;
  for (let m = 1; m <= 12; m++) {
    const ym = y + '-' + pad2(m);
    if (monthlyMap[ym] === undefined || monthlyMap[ym] === '') continue;
    const val = round2(Number(monthlyMap[ym]) || 0);
    if (byYm[ym]) {
      repoUpdateRow(SHEETS.COMMISSION_MONTHLY, byYm[ym]._rowIndex, {
        gross_sales: val,
        updated_by: actor || 'admin',
        updated_at: nowStr()
      });
    } else if (val > 0) {
      repoAppendRow(SHEETS.COMMISSION_MONTHLY, {
        year_month: ym,
        gross_sales: val,
        prev_year_sales: 0, capital: 100000, credit_note: 0, incident_case: 0, supercoil: 18000,
        net_sales: 0, pv_project_sales: 0, front_store_sales: 0, extra_prod_sales: 0,
        rate_full_pct: 0.1, rate_half_pct: 0.05, sales_kpi_deduct: 0, prod_kpi_deduct: 0,
        sales_pool: 0, prod_pool: 0, sales_hours_total: 0, prod_hours_total: 0,
        allocations_json: '[]', updated_by: actor || 'admin', updated_at: nowStr()
      });
    }
    savedCount++;
  }
  repoAppendAuditLog(actor || 'admin', 'SAVE_YEAR_GROSS_SALES', SHEETS.COMMISSION_MONTHLY, y, null, monthlyMap, 'บันทึกยอดขายย้อนหลังรายปีสำหรับเทียบ YoY');
  return { ok: true, savedCount: savedCount };
}

function savePvdRates(updatesList, actor) {
  if (!Array.isArray(updatesList) || !updatesList.length) {
    throw new Error('ไม่มีข้อมูลอัตรา PVD ที่เปลี่ยนแปลงครับ');
  }
  ensureEmployeeProfileColumns();
  const payrollSs = getPayrollDb();
  const sheet = payrollSs.getSheetByName('Calculation');
  if (!sheet || sheet.getLastRow() < 2) throw new Error('ไม่พบชีต "Calculation" ในไฟล์เงินเดือนครับ');
  if (String(sheet.getRange(1, 7).getValue()).indexOf('วันมาทำงาน') === -1) {
    throw new Error('ชีต Calculation ยังไม่ใช่โครงสร้างใหม่ครับ');
  }

  const empRows = repoReadAll(SHEETS.EMPLOYEES).rows;
  const empByCode = {};
  empRows.forEach(e => {
    const k = normEmpCode(e.code || e.employee_id);
    if (k) empByCode[k] = e;
  });

  const changed = [];
  updatesList.forEach(item => {
    const rIdx = Number(item.rowIndex);
    if (!rIdx || rIdx < 2) return;
    const pct = Math.max(0, Math.min(15, Number(item.pvd_pct) || 0));
    const dec = Math.round(pct * 100) / 10000; // เช่น 3 -> 0.03, 2.5 -> 0.025
    const cell = sheet.getRange(rIdx, 21); // คอลัมน์ U (% กองทุนสำรองฯ)
    const oldVal = Number(cell.getValue()) || 0;
    const calcCode = normEmpCode(sheet.getRange(rIdx, 1).getValue());
    const empRec = empByCode[calcCode];

    const calcChanged = Math.abs(oldVal - dec) > 0.00001;
    const empChanged = empRec && String(empRec.pvd_rate || '') !== String(pct);

    if (calcChanged) {
      cell.setValue(dec).setNumberFormat('0.0%');
    }
    if (empChanged) {
      repoUpdateRow(SHEETS.EMPLOYEES, empRec._rowIndex, { pvd_rate: String(pct) });
    }
    if (calcChanged || empChanged) {
      changed.push({ rowIndex: rIdx, code: calcCode, oldPct: Math.round(oldVal * 1000) / 10, newPct: pct });
    }
  });

  SpreadsheetApp.flush();
  if (changed.length) {
    repoClearCache();
    repoAppendAuditLog(actor || 'admin', 'UPDATE_PVD_RATES', 'Employees+Calculation', 'PVD_BATCH', null, changed, 'แก้ไขอัตรากองทุนสำรองเลี้ยงชีพ (PVD) จาก Dashboard');
  }
  return { ok: true, updatedCount: changed.length, payroll: getPayrollDashboardData() };
}

/* ================= Employee Directory Management (Admin Only / PDPA) ================= */

function listAllEmployeesAdmin() {
  ensureEmployeeProfileColumns();
  return repoReadAll(SHEETS.EMPLOYEES).rows.map(e => ({
    rowIndex: e._rowIndex,
    employee_id: String(e.employee_id || ''),
    code: String(e.code || ''),
    title: String(e.title || ''),
    name: String(e.name || ''),
    nickname: String(e.nickname || ''),
    department: String(e.department || ''),
    position: String(e.position || ''),
    fingerprint_id: String(e.fingerprint_id || ''),
    line_user_id: String(e.line_user_id || ''),
    role: String(e.role || 'employee'),
    supervisor_id: String(e.supervisor_id || ''),
    status: String(e.status || 'ACTIVE'),
    hire_date: repoNormalizeDate(e.hire_date || ''),
    vacation_quota: e.vacation_quota !== '' ? String(e.vacation_quota) : '6',
    national_id: String(e.national_id || ''),
    email: String(e.email || ''),
    phone: String(e.phone || ''),
    address: String(e.address || ''),
    bank_name: String(e.bank_name || ''),
    bank_account: String(e.bank_account || ''),
    pvd_join_date: repoNormalizeDate(e.pvd_join_date || ''),
    pvd_rate: e.pvd_rate !== undefined && e.pvd_rate !== '' ? String(e.pvd_rate) : '0',
    uniform_deposit_paid: e.uniform_deposit_paid !== undefined && e.uniform_deposit_paid !== '' ? String(e.uniform_deposit_paid) : '0',
    uniform_monthly_deduct: e.uniform_monthly_deduct !== undefined && e.uniform_monthly_deduct !== '' ? String(e.uniform_monthly_deduct) : '0'
  }));
}

function saveEmployeeAdmin(payload, actor) {
  ensureEmployeeProfileColumns();
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('กรุณาระบุชื่อ-นามสกุลพนักงานครับ');

  const rows = repoReadAll(SHEETS.EMPLOYEES).rows;
  const isEdit = !!payload.isEdit;
  const target = isEdit ? rows.find(r => String(r.employee_id) === String(payload.original_employee_id || payload.employee_id)) : null;

  let empId = String(payload.employee_id || '').trim();
  if (!isEdit && !empId) {
    const maxId = rows.reduce((m, r) => Math.max(m, Number(r.employee_id) || 0), 0);
    empId = String(maxId + 1);
  }
  if (!isEdit && rows.some(r => String(r.employee_id) === empId)) {
    throw new Error('รหัส employee_id ' + empId + ' ซ้ำกับที่มีอยู่แล้วครับ');
  }

  const fpId = String(payload.fingerprint_id || '').trim();
  if (fpId && rows.some(r => String(r.fingerprint_id) === fpId && (!target || r._rowIndex !== target._rowIndex))) {
    throw new Error('รหัสสแกนนิ้ว (fingerprint_id) ' + fpId + ' ซ้ำกับพนักงานคนอื่นครับ');
  }

  const pvdPct = Math.max(0, Math.min(15, Number(payload.pvd_rate) || 0));
  const uniPaid = Math.max(0, Number(payload.uniform_deposit_paid) || 0);
  const uniMonthly = Math.max(0, Number(payload.uniform_monthly_deduct) || 0);
  const rec = {
    employee_id: empId,
    code: String(payload.code || '').trim(),
    title: String(payload.title || '').trim(),
    name: name,
    nickname: String(payload.nickname || '').trim(),
    department: String(payload.department || '').trim(),
    position: String(payload.position || '').trim(),
    fingerprint_id: fpId,
    line_user_id: String(payload.line_user_id || '').trim(),
    role: String(payload.role || 'employee').trim().toLowerCase(),
    supervisor_id: String(payload.supervisor_id || '').trim(),
    status: String(payload.status || 'ACTIVE').trim().toUpperCase(),
    hire_date: repoNormalizeDate(payload.hire_date || ''),
    vacation_quota: String(payload.vacation_quota !== undefined && payload.vacation_quota !== '' ? payload.vacation_quota : '6').trim(),
    national_id: String(payload.national_id || '').trim(),
    email: String(payload.email || '').trim(),
    phone: String(payload.phone || '').trim(),
    address: String(payload.address || '').trim(),
    bank_name: String(payload.bank_name || '').trim(),
    bank_account: String(payload.bank_account || '').trim(),
    pvd_join_date: repoNormalizeDate(payload.pvd_join_date || ''),
    pvd_rate: String(pvdPct),
    uniform_deposit_paid: String(round2(uniPaid)),
    uniform_monthly_deduct: String(round2(uniMonthly))
  };

  if (target) {
    repoUpdateRow(SHEETS.EMPLOYEES, target._rowIndex, rec);
    repoAppendAuditLog(actor || 'admin', 'UPDATE_EMPLOYEE', SHEETS.EMPLOYEES, empId,
      { name: target.name, status: target.status, role: target.role },
      { name: rec.name, status: rec.status, role: rec.role, pvd_join_date: rec.pvd_join_date, pvd_rate: rec.pvd_rate, uniform_deposit_paid: rec.uniform_deposit_paid }, 'แก้ไขทะเบียนพนักงานจาก Dashboard');
  } else {
    repoAppendRow(SHEETS.EMPLOYEES, rec);
    repoAppendAuditLog(actor || 'admin', 'ADD_EMPLOYEE', SHEETS.EMPLOYEES, empId, null,
      { name: rec.name, code: rec.code, department: rec.department }, 'เพิ่มพนักงานใหม่จาก Dashboard');
  }
  repoClearCache();

  // ซิงก์ชื่อ ตำแหน่ง วันเริ่มงาน ธนาคาร เลขบัญชี และ % PVD เข้า Calculation หากมีแถวพนักงานคนนี้อยู่แล้ว
  try {
    const cfg = getAppConfig();
    if (cfg.PAYROLL_SHEET_ID && rec.code) {
      const calcSheet = getPayrollDb().getSheetByName('Calculation');
      if (calcSheet && calcSheet.getLastRow() >= 2 && String(calcSheet.getRange(1, 7).getValue()).indexOf('วันมาทำงาน') !== -1) {
        const codes = calcSheet.getRange(2, 1, calcSheet.getLastRow() - 1, 1).getValues();
        const k = normEmpCode(rec.code);
        for (let i = 0; i < codes.length; i++) {
          if (normEmpCode(codes[i][0]) === k) {
            const rIdx = i + 2;
            calcSheet.getRange(rIdx, 2, 1, 4).setValues([[rec.name, rec.nickname, rec.position, rec.hire_date]]);
            if (payload.pvd_rate !== undefined && payload.pvd_rate !== '') {
              calcSheet.getRange(rIdx, 21).setValue(Math.round(pvdPct * 100) / 10000).setNumberFormat('0.0%');
            }
            if (rec.bank_name || rec.bank_account) {
              calcSheet.getRange(rIdx, 32, 1, 2).setNumberFormat('@').setValues([[rec.bank_name, rec.bank_account]]);
            }
            break;
          }
        }
      }
    }
  } catch (e) {
    Logger.log('syncEmpToCalculation skip: ' + e.message);
  }

  return { ok: true, employees: listAllEmployeesAdmin() };
}

/* ================= Payroll Automations: Diligence Streak, Forbid Absent 3x, Uniform, Accounting Summary ================= */

function getPrevYearMonth(ym) {
  const [y, m] = String(ym || '').split('-').map(Number);
  if (!y || !m) return '';
  return m === 1 ? (y - 1) + '-12' : y + '-' + pad2(m - 1);
}

/**
 * อ่านจำนวนเดือนต่อเนื่องที่ผ่านเกณฑ์เบี้ยขยันของเดือนก่อนหน้าจาก Payroll_Monthly_Log
 */
function getPrevMonthDiligenceStreaks(yearMonth) {
  const prevYm = getPrevYearMonth(yearMonth);
  const map = {};
  if (!prevYm) return map;
  ensureBonusSheets();
  repoReadAll(SHEETS.PAYROLL_MONTHLY_LOG).rows
    .filter(r => String(r.year_month || '').trim() === prevYm)
    .forEach(r => {
      const k = normEmpCode(r.code || r.employee_id);
      if (k) map[k] = Number(r.diligence_streak) || 0;
    });
  return map;
}

/**
 * หักขาดวันห้ามหยุด: หยุด/ลา/ขาดติดต่อกัน >= 3 วันทำงาน -> ตั้งแต่วันที่ 3 หักรวม 3 เท่าของค่าแรงรายวัน
 * (ถ้าวันนั้นเป็นวันขาดที่คอลัมน์ S หักไปแล้ว 1 เท่า ให้หักเพิ่มที่ AA อีก 2 เท่า; ถ้าเป็นวันลา ให้หัก 3 เท่าที่ AA)
 */
function computeForbidAbsentDeduction(empDailyRows, baseSalary) {
  if (!empDailyRows || !empDailyRows.length || !baseSalary) return { daysCount: 0, deductAmount: 0 };
  const sorted = empDailyRows.slice().sort((a, b) => String(a.work_date).localeCompare(String(b.work_date)));
  const dailyWage = baseSalary / 30;
  let streak = 0;
  let forbidDays = 0;
  let totalDeduct = 0;

  sorted.forEach(r => {
    const st = String(r.status || '').toUpperCase();
    if (st === 'OFF' || st === 'UPCOMING') return; // วันหยุดประจำสัปดาห์/นักขัตฯ ไม่ตัดและไม่นับเพิ่ม
    const absMin = Number(r.absent_min || 0);
    const leaveHrs = Number(r.leave_hours || 0);
    const isDayOff = (absMin >= 240) || (leaveHrs >= 4); // หยุด/ลา/ขาดอย่างน้อยครึ่งวันขึ้นไป
    if (isDayOff) {
      streak++;
      if (streak >= 3) {
        forbidDays++;
        const alreadyDeductedRatio = Math.min(1, absMin / 480); // คอลัมน์ S หักไปแล้วเท่าไหร่ของวัน (0..1)
        const extraMultiplier = Math.max(0, 3 - alreadyDeductedRatio);
        totalDeduct += dailyWage * extraMultiplier;
      }
    } else {
      streak = 0;
    }
  });
  return { daysCount: forbidDays, deductAmount: totalDeduct > 0 ? -round2(totalDeduct) : 0 };
}

function upsertPayrollMonthlyLogs(yearMonth, logs) {
  if (!logs || !logs.length) return;
  ensureBonusSheets();
  const sheet = repoGetMainDb().getSheetByName(SHEETS.PAYROLL_MONTHLY_LOG);
  const headers = DB_SCHEMA.Payroll_Monthly_Log;
  const existingRows = repoReadAll(SHEETS.PAYROLL_MONTHLY_LOG).rows;

  // รักษาสถานะ uniform_applied เดิมไว้ไม่ให้ถูกรีเซ็ตหากงวดนั้นเคยทบยอดมัดจำยูนิฟอร์มไปแล้ว
  const appliedMap = {};
  existingRows.filter(r => String(r.year_month || '').trim() === yearMonth).forEach(r => {
    if (String(r.uniform_applied).toUpperCase() === 'TRUE') {
      appliedMap[normEmpCode(r.code || r.employee_id)] = 'TRUE';
    }
  });

  const keep = existingRows
    .filter(r => String(r.year_month || '').trim() !== yearMonth)
    .map(r => headers.map(h => (r[h] !== undefined && r[h] !== null ? r[h] : '')));

  const added = logs.map(obj => {
    const k = normEmpCode(obj.code || obj.employee_id);
    if (appliedMap[k] === 'TRUE') obj.uniform_applied = 'TRUE';
    return headers.map(h => (obj[h] !== undefined && obj[h] !== null ? obj[h] : ''));
  });

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  repoWriteRowsAt(sheet, 2, keep.concat(added));
}

/**
 * ทบยอดมัดจำชุดยูนิฟอร์มที่หักในเดือนนั้นเข้า Employees.uniform_deposit_paid เมื่อปิดงวด (Lock)
 * (กันทบซ้ำด้วย flag uniform_applied = TRUE)
 */
function applyUniformDepositsOnLock(yearMonth, actor) {
  try {
    ensureBonusSheets();
    ensureEmployeeProfileColumns();
    const logs = repoReadAll(SHEETS.PAYROLL_MONTHLY_LOG).rows
      .filter(r => String(r.year_month || '').trim() === yearMonth && String(r.uniform_applied).toUpperCase() !== 'TRUE');
    if (!logs.length) return 0;

    const empRows = repoReadAll(SHEETS.EMPLOYEES).rows;
    const empByCode = {};
    empRows.forEach(e => { empByCode[normEmpCode(e.code || e.employee_id)] = e; });

    let count = 0;
    logs.forEach(log => {
      const amt = Math.abs(Number(log.uniform_deducted) || 0);
      if (amt <= 0) return;
      const emp = empByCode[normEmpCode(log.code || log.employee_id)];
      if (!emp) return;
      const newPaid = Math.min(4000, round2((Number(emp.uniform_deposit_paid) || 0) + amt));
      repoUpdateRow(SHEETS.EMPLOYEES, emp._rowIndex, { uniform_deposit_paid: String(newPaid) });
      repoUpdateRow(SHEETS.PAYROLL_MONTHLY_LOG, log._rowIndex, { uniform_applied: 'TRUE', updated_at: nowStr() });
      count++;
    });
    if (count > 0) {
      repoClearCache();
      repoAppendAuditLog(actor || 'admin', 'APPLY_UNIFORM_DEPOSIT', SHEETS.EMPLOYEES, yearMonth, null, { updatedEmployees: count }, 'ทบยอดมัดจำชุดยูนิฟอร์มสะสมเมื่อปิดงวด');
    }
    return count;
  } catch (e) {
    Logger.log('applyUniformDepositsOnLock skip: ' + e.message);
    return 0;
  }
}

/**
 * อัปเดตชีต "สรุปบัญชีเงินเดือน" ในไฟล์ HomesteelKK_Salary อัตโนมัติตามเดือนที่เลือก (Jan-Dec)
 */
function updateMonthlyAccountingSummary(yearMonth, actor) {
  const ym = String(yearMonth || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error('รูปแบบเดือนไม่ถูกต้องครับ');
  const [yr, mo] = ym.split('-').map(Number);
  const targetCol = mo + 1; // Jan=B(2), Feb=C(3), ..., Dec=M(13)

  const payrollSs = getPayrollDb();
  const sumSheet = payrollSs.getSheetByName('สรุปบัญชีเงินเดือน');
  if (!sumSheet) return { ok: false, message: 'ไม่พบชีต "สรุปบัญชีเงินเดือน"' };

  const data = getPayrollDashboardData();
  const emps = data.employees || [];
  if (!emps.length) return { ok: false, message: 'ไม่มีข้อมูลพนักงานใน Calculation' };

  const empMetaByCode = {};
  repoReadAll(SHEETS.EMPLOYEES).rows.forEach(e => {
    empMetaByCode[normEmpCode(e.code || e.employee_id)] = e;
  });

  const refDate = new Date(yr, mo, 0); // วันสิ้นเดือนของงวด
  const acc = {
    salExec: 0, salProd: 0, salOffice: 0, salInternProd: 0, salInternOffice: 0,
    otProd: 0, otOffice: 0, otInternProd: 0, otInternOffice: 0,
    commProd: 0, commOffice: 0, commInternProd: 0, commInternOffice: 0,
    otherExec: 0, otherProd: 0, otherOffice: 0, otherInternProd: 0,
    roundingDiff: 0,
    uniformDeposit: 0, sso: 0, pvd: 0,
    deductAtt: 0, deductDamage: 0, deductGoods: 0,
    empCount: emps.length
  };

  emps.forEach(e => {
    const meta = empMetaByCode[normEmpCode(e.code)] || {};
    const dept = String(meta.department || e.position || '');
    const isExec = dept.indexOf('Executive') !== -1 || dept.indexOf('บริหาร') !== -1;
    const isOffice = !isExec && (dept.indexOf('บัญชี') !== -1 || dept.indexOf('ขาย') !== -1 || dept.indexOf('IT') !== -1 || dept.indexOf('ออฟฟิศ') !== -1);

    let isIntern = false;
    const hireIso = e.hire_date_iso || repoNormalizeDate(meta.hire_date || '');
    if (hireIso && /^\d{4}-\d{2}-\d{2}$/.test(hireIso)) {
      const h = new Date(hireIso + 'T00:00:00');
      let mDiff = (refDate.getFullYear() - h.getFullYear()) * 12 + (refDate.getMonth() - h.getMonth());
      if (refDate.getDate() < h.getDate()) mDiff--;
      if (mDiff <= 3) isIntern = true;
    }

    const commDil = (Number(e.commission) || 0) + (Number(e.measurement) || 0) + (Number(e.frame_bonus) || 0) + (Number(e.diligence) || 0);
    const otherInc = (Number(e.position_allowance) || 0) + (Number(e.phone_allowance) || 0);

    if (isExec) {
      acc.salExec += Number(e.base_salary) || 0;
      acc.otherExec += otherInc;
    } else if (isOffice) {
      if (isIntern) {
        acc.salInternOffice += Number(e.base_salary) || 0;
        acc.otInternOffice += Number(e.ot_baht) || 0;
        acc.commInternOffice += commDil;
      } else {
        acc.salOffice += Number(e.base_salary) || 0;
        acc.otOffice += Number(e.ot_baht) || 0;
        acc.commOffice += commDil;
        acc.otherOffice += otherInc;
      }
    } else {
      if (isIntern) {
        acc.salInternProd += Number(e.base_salary) || 0;
        acc.otInternProd += Number(e.ot_baht) || 0;
        acc.commInternProd += commDil;
        acc.otherInternProd += otherInc;
      } else {
        acc.salProd += Number(e.base_salary) || 0;
        acc.otProd += Number(e.ot_baht) || 0;
        acc.commProd += commDil;
        acc.otherProd += otherInc;
      }
    }

    acc.uniformDeposit += Number(e.deduct_uniform) || 0;
    acc.sso += Number(e.sso) || 0;
    acc.pvd += Number(e.deduct_pvd) || 0;
    acc.deductAtt += (Number(e.deduct_absent) || 0) + (Number(e.deduct_late) || 0) + (Number(e.deduct_other) || 0) + (Number(e.deduct_forbid_absent) || 0);
    acc.deductDamage += Number(e.deduct_damage) || 0;
    acc.deductGoods += Number(e.deduct_goods) || 0;

    const exactSum = (Number(e.base_salary) || 0) + (Number(e.ot_baht) || 0) + commDil + otherInc +
      (Number(e.deduct_absent) || 0) + (Number(e.deduct_late) || 0) + (Number(e.deduct_pvd) || 0) +
      (Number(e.deduct_uniform) || 0) + (Number(e.deduct_goods) || 0) + (Number(e.deduct_damage) || 0) +
      (Number(e.deduct_other) || 0) + (Number(e.deduct_forbid_absent) || 0) + (Number(e.sso) || 0) + (Number(e.tax) || 0);
    acc.roundingDiff += (Number(e.net_pay) || 0) - exactSum;
  });

  const lastRow = Math.min(sumSheet.getLastRow(), 35);
  const labels = sumSheet.getRange(1, 1, lastRow, 1).getValues();
  const labelRules = [
    ['เงินเดือนบริหาร', acc.salExec],
    ['เงินเดือน-ทีมผลิต', acc.salProd],
    ['เงินเดือนออฟฟิศ', acc.salOffice],
    ['เงินเดือนฝึกงาน-ทีมผลิต', acc.salInternProd],
    ['เงินเดือนฝึกงาน-ออฟฟิศ', acc.salInternOffice],
    ['ค่าล่วงเวลา-ทีมผลิต', acc.otProd],
    ['ค่าล่วงเวลาออฟฟิศ', acc.otOffice],
    ['ค่าล่วงเวลาฝึกงาน-ทีมผลิต', acc.otInternProd],
    ['ค่าล่วงเวลาฝึกงานออฟฟิศ', acc.otInternOffice],
    ['ค่าคอมต่างๆ +เบี้ยขยัน-ทีมผลิต', acc.commProd],
    ['ค่าคอมต่างๆ +เบี้ยขยัน-ออฟฟิศ', acc.commOffice],
    ['ค่าคอมต่างๆ +เบี้ยขยัน ฝึกงาน-ทีมผลิต', acc.commInternProd],
    ['ค่าคอมต่างๆ +เบี้ยขยัน ฝึกงาน-ออฟฟิศ', acc.commInternOffice],
    ['รายได้อื่นๆ -ทีมบริหาร', acc.otherExec],
    ['รายได้อื่นๆ -ทีมผลิต', acc.otherProd],
    ['รายได้อื่นๆ ออฟฟิศ', acc.otherOffice],
    ['รายได้อื่นๆ  ฝึกงาน -ทีมผลิต', acc.otherInternProd],
    ['ปัดเศษสตางค์', acc.roundingDiff],
    ['ค่าชุดยูนิฟอร์ม มัดจำ', acc.uniformDeposit],
    ['ค่าประกันสังคม', acc.sso],
    ['กองทุนสำรองเลี้ยงชีพ', acc.pvd],
    ['หักขาดลามาสายไม่สแกนนิ้ว', acc.deductAtt],
    ['หักค่าเสียหายจากการทำงาน', acc.deductDamage],
    ['หักค่าสินค้า', acc.deductGoods],
    ['จำนวนพนักงาน', acc.empCount]
  ];

  let updatedRows = 0;
  for (let r = 1; r < labels.length; r++) {
    const txt = String(labels[r][0] || '').trim();
    if (!txt) continue;
    for (let j = 0; j < labelRules.length; j++) {
      if (txt.indexOf(labelRules[j][0]) !== -1) {
        sumSheet.getRange(r + 1, targetCol).setValue(round2(labelRules[j][1]));
        updatedRows++;
        break;
      }
    }
  }
  SpreadsheetApp.flush();
  repoAppendAuditLog(actor || 'admin', 'SYNC_ACCOUNTING_SUMMARY', 'สรุปบัญชีเงินเดือน', ym, null, { updatedRows: updatedRows, empCount: acc.empCount }, 'อัปเดตสรุปบัญชีเงินเดือนอัตโนมัติ');
  return { ok: true, updatedRows: updatedRows, month: ym };
}
