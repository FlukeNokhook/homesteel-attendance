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
      `=IFERROR(SUMIF('ค่าหาโครง'!B:B, C${r}, 'ค่าหาโครง'!F:F), 0)`,
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

    const key = String(r.code || r.employee_id);
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

  // 2) ส่งสรุปรายคนตรงเข้าชีต Calculation (โครงสร้างใหม่ A-AG)
  let calcUpdated = 0;
  const calcSheet = payrollSs.getSheetByName('Calculation');
  if (calcSheet && calcSheet.getLastRow() >= 2 && String(calcSheet.getRange(1, 7).getValue()).indexOf('วันมาทำงาน') !== -1) {
    const lastRow = calcSheet.getLastRow();
    const codes = calcSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const statsGrid = calcSheet.getRange(2, 7, lastRow - 1, 5).getValues(); // G-K
    const diligenceCol = calcSheet.getRange(2, 16, lastRow - 1, 1).getValues(); // P

    for (let i = 0; i < codes.length; i++) {
      const code = String(codes[i][0] || '').trim();
      const st = byEmp[code];
      if (!st) continue;
      statsGrid[i] = [
        st.workDays,
        round2(st.workMin / 60),
        round2(st.otHours),
        Math.round(st.lateMin),
        round2(st.absentMin / 60)
      ];
      // เบี้ยขยันเบื้องต้น: ถ้าไม่สาย ไม่ขาด ไม่ลาเลย และยังเป็น 0 -> ตั้งขั้น 1 (500); ถ้าผิดเงื่อนไข -> 0
      const eligible = (st.lateMin === 0 && st.absentMin === 0 && st.leaveHours === 0 && st.workDays > 0);
      if (!eligible) diligenceCol[i][0] = 0;
      else if (!Number(diligenceCol[i][0])) diligenceCol[i][0] = 500;
      calcUpdated++;
    }
    calcSheet.getRange(2, 7, lastRow - 1, 5).setValues(statsGrid);
    calcSheet.getRange(2, 16, lastRow - 1, 1).setValues(diligenceCol);
  }

  repoAppendAuditLog(actor || 'admin', 'SYNC_PAYROLL', 'Calculation', yearMonth,
    null, { timeClockRows: tcData.length - 1, calcUpdated: calcUpdated }, 'ส่งข้อมูลเวลาเข้า Calculation + Time Clock');

  return { rowsWritten: tcData.length - 1, calcUpdated: calcUpdated, sheetUrl: payrollSs.getUrl() };
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
        deduct_absent: numVal(row[18]), deduct_late: numVal(row[19]), pvd_rate: numVal(row[20]), deduct_pvd: numVal(row[21]),
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
