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
      byEmp[key] = { workDays: 0, workMin: 0, otHours: 0, lateMin: 0, absentMin: 0, leaveHours: 0 };
    }
    if (r.first_in) byEmp[key].workDays++;
    byEmp[key].workMin += Number(r.work_minutes || 0);
    byEmp[key].otHours += Number(r.ot_paid_hours || 0);
    byEmp[key].lateMin += Number(r.late_min || 0);
    byEmp[key].absentMin += Number(r.absent_min || 0);
    byEmp[key].leaveHours += Number(r.leave_hours || 0);
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
      const codes = calcSheet.getRange(2, 1, lastRow - 1, 1).getValues();
      const statsGrid = calcSheet.getRange(2, 7, lastRow - 1, 5).getValues(); // G-K
      const diligenceCol = calcSheet.getRange(2, 16, lastRow - 1, 1).getValues(); // P

      for (let i = 0; i < codes.length; i++) {
        const code = normEmpCode(codes[i][0]);
        const st = byEmp[code];
        if (!st) continue;
        statsGrid[i] = [
          st.workDays,
          round2(st.workMin / 60),
          round2(st.otHours),
          Math.round(st.lateMin),
          round2(st.absentMin / 60)
        ];
        const eligible = (st.lateMin === 0 && st.absentMin === 0 && st.leaveHours === 0 && st.workDays > 0);
        if (!eligible) diligenceCol[i][0] = 0;
        else if (!Number(diligenceCol[i][0])) diligenceCol[i][0] = 500;
        calcUpdated++;
      }
      calcSheet.getRange(2, 7, lastRow - 1, 5).setValues(statsGrid);
      calcSheet.getRange(2, 16, lastRow - 1, 1).setValues(diligenceCol);
    }
  }

  // ซิงก์ยอดรวม ค่าวัดหน้างาน (N), ค่าหาโครง (O), และ ค่าคอมมิชชั่น (M) ของเดือนนี้เข้าชีต Calculation ด้วย
  syncBonusTotalsToCalculation(yearMonth);
  syncCommissionToCalculation(yearMonth);

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

  const employees = [];
  const startRow = isCleanLayout ? 1 : 2;
  for (let r = startRow; r < values.length; r++) {
    const row = values[r];
    const code = String(row[0] || '').trim();
    const name = String(row[1] || '').trim();
    const nickname = String(row[2] || '').trim();
    if (!name && !nickname) continue;
    if (name.indexOf('รวม') === 0 || code.indexOf('รวม') === 0) continue;

    if (isCleanLayout) {
      employees.push({
        rowIndex: r + 1,
        code: code, name: name, nickname: nickname, position: String(row[3] || ''), hire_date: dateFmt(row[4]),
        base_salary: numVal(row[5]),
        work_days: numVal(row[6]), work_hours: numVal(row[7]), ot15_hours: numVal(row[8]), late_min: numVal(row[9]), absent_hours: numVal(row[10]),
        ot_baht: numVal(row[11]), commission: numVal(row[12]), measurement: numVal(row[13]), frame_bonus: numVal(row[14]),
        diligence: numVal(row[15]), position_allowance: numVal(row[16]), phone_allowance: numVal(row[17]),
        deduct_absent: numVal(row[18]), deduct_late: numVal(row[19]), pvd_rate: Number(row[20]) || 0, deduct_pvd: numVal(row[21]),
        deduct_uniform: numVal(row[22]), deduct_goods: numVal(row[23]), deduct_damage: numVal(row[24]),
        deduct_other: numVal(row[25]), deduct_forbid_absent: numVal(row[26]),
        gross_income: numVal(row[27]), sso: numVal(row[28]), tax: numVal(row[29]), net_pay: numVal(row[30]),
        bank: String(row[31] || ''), bank_account: String(row[32] || '')
      });
    } else {
      employees.push({
        rowIndex: r + 1,
        code: code, name: name, nickname: nickname, position: String(row[3] || ''), hire_date: dateFmt(row[4]),
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
  const payrollSs = getPayrollDb();
  const sheet = payrollSs.getSheetByName('Calculation');
  if (!sheet || sheet.getLastRow() < 2) throw new Error('ไม่พบชีต "Calculation" ในไฟล์เงินเดือนครับ');
  if (String(sheet.getRange(1, 7).getValue()).indexOf('วันมาทำงาน') === -1) {
    throw new Error('ชีต Calculation ยังไม่ใช่โครงสร้างใหม่ครับ');
  }

  const changed = [];
  updatesList.forEach(item => {
    const rIdx = Number(item.rowIndex);
    if (!rIdx || rIdx < 2) return;
    const pct = Math.max(0, Math.min(15, Number(item.pvd_pct) || 0));
    const dec = Math.round(pct * 100) / 10000; // เช่น 3 -> 0.03, 2.5 -> 0.025
    const cell = sheet.getRange(rIdx, 21); // คอลัมน์ U (% กองทุนสำรองฯ)
    const oldVal = Number(cell.getValue()) || 0;
    if (Math.abs(oldVal - dec) > 0.00001) {
      cell.setValue(dec).setNumberFormat('0.0%');
      changed.push({ rowIndex: rIdx, oldPct: Math.round(oldVal * 1000) / 10, newPct: pct });
    }
  });

  SpreadsheetApp.flush();
  if (changed.length) {
    repoAppendAuditLog(actor || 'admin', 'UPDATE_PVD_RATES', 'Calculation', 'PVD_BATCH', null, changed, 'แก้ไขอัตรากองทุนสำรองเลี้ยงชีพ (PVD) จาก Dashboard');
  }
  return { ok: true, updatedCount: changed.length, payroll: getPayrollDashboardData() };
}
