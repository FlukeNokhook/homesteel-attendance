/**
 * PayrollService.gs
 * เชื่อมต่อระบบลงเวลา/ลา/โอที (Factory_Payroll_DB) เข้ากับ Google Sheet คำนวณเงินเดือน (PAYROLL_SHEET_ID)
 * - ส่งข้อมูล 15 คอลัมน์ลงชีต Time Clock อัตโนมัติ (1 คลิก ไม่ต้องดาวน์โหลด CSV)
 * - อ่านยอดคำนวณสดจากชีต Calculation (รวมค่าคอมฯ, ค่าวัดหน้างาน, ค่าหาโครง, ประกันสังคม, ภาษี PND 1)
 * - ให้แก้ไขรายได้/รายการหักจากหน้า Dashboard ได้โดยตรง (ซิงก์กับ Google Sheet เงินเดือนทันที พร้อม Audit Log)
 * - ส่งข้อมูลสลิปเงินเดือนสำหรับพิมพ์รายคน หรือ พิมพ์ทั้งหมดทีเดียว
 */

function getPayrollDb() {
  const cfg = getAppConfig();
  if (!cfg.PAYROLL_SHEET_ID) {
    throw new Error('ยังไม่ได้ตั้งค่า PAYROLL_SHEET_ID ใน Script Properties (กรุณานำ ID ของ Google Sheet เงินเดือนมาใส่ก่อนครับ)');
  }
  return SpreadsheetApp.openById(cfg.PAYROLL_SHEET_ID);
}

/**
 * ส่งข้อมูล Attendance_Daily ของเดือนที่เลือกเข้าชีต "Time Clock" ใน Google Sheet เงินเดือนอัตโนมัติ
 */
function syncTimeClockToPayrollSheet(yearMonth, actor) {
  const payrollSs = getPayrollDb();
  let tcSheet = payrollSs.getSheetByName('Time Clock');
  if (!tcSheet) {
    tcSheet = payrollSs.insertSheet('Time Clock');
  }

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

  if (!filtered.length) {
    throw new Error('ยังไม่มีข้อมูลรายวันของเดือน ' + yearMonth + ' กรุณากด "คำนวณใหม่" ก่อนส่งข้อมูลครับ');
  }

  const rows = [headers];
  filtered.forEach(r => {
    const p = String(r.work_date).split('-');
    const off = isOffDay(String(r.work_date), holidaySet);
    rows.push([
      r.code || r.employee_id,
      r.name,
      p[2] + '/' + p[1] + '/' + p[0],
      off ? '' : 'ค่าเริ่มต้น',
      minutesToHhMm(r.work_minutes),
      off ? '0:00' : '8:00',
      hoursToHhMm(r.ot_paid_hours),
      '0:00',
      '0:00',
      minutesToHhMm(r.late_min),
      minutesToHhMm(r.early_leave_min),
      minutesToHhMm(r.absent_min),
      off ? '0:00' : '1:00',
      r.first_in || '',
      r.last_out || ''
    ]);
  });

  tcSheet.clearContents();
  if (rows.length > tcSheet.getMaxRows()) {
    tcSheet.insertRowsAfter(tcSheet.getMaxRows(), rows.length - tcSheet.getMaxRows());
  }
  tcSheet.getRange(1, 1, rows.length, headers.length).setValues(rows);

  repoAppendAuditLog(actor || 'admin', 'SYNC_PAYROLL_TIMECLOCK', 'Payroll_TimeClock', yearMonth,
    null, { rowsWritten: rows.length - 1 }, 'ส่งข้อมูล Time Clock เข้า Google Sheet เงินเดือน');

  return { rowsWritten: rows.length - 1, sheetUrl: payrollSs.getUrl() };
}

/**
 * อ่านข้อมูลสรุปเงินเดือนและสลิปของพนักงานทุกคนจากชีต Calculation (โครงสร้างตาม Excel เดิม)
 * คอลัมน์อ้างอิง (1-based):
 * A(1)=รหัส, B(2)=ชื่อ-สกุล, C(3)=ชื่อเล่น, D(4)=ตำแหน่ง, E(5)=วันเริ่มงาน, F(6)=ฐานเงินเดือน
 * AL(38)=ชม.ทำงานปกติ, AM(39)=OT1.5, AN(40)=OT2, AO(41)=OT3, AP(42)=OT(บาท)
 * AQ(43)=ค่าคอมฯ, AR(44)=ค่าวัดหน้างาน, AS(45)=ค่าหาโครง, AT(46)=เบี้ยขยัน, AU(47)=ค่าประจำตำแหน่ง, AV(48)=เงินพิเศษ/มือถือ
 * AW(49)=หักขาดงาน, AX(50)=หักประกัน, AY(51)=หักกองทุน, AZ(52)=หักยูนิฟอร์ม, BA(53)=หักค่าสินค้า,
 * BB(54)=หักค่าเสียหาย, BC(55)=เงินหักอื่นๆ, BD(56)=หักขาดวันห้ามหยุด, BE(57)=หักสายเกินกำหนด
 * BF(58)=รายได้สุทธิ, BG(59)=ประกันสังคม, BH(60)=ภาษี, BI(61)=ยอดจ่ายเงิน, BJ(62)=ธนาคาร, BK(63)=เลขบัญชี
 */
function getPayrollDashboardData() {
  const payrollSs = getPayrollDb();
  const sheet = payrollSs.getSheetByName('Calculation');
  if (!sheet) throw new Error('ไม่พบชีต "Calculation" ใน Google Sheet เงินเดือนครับ');

  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return { sheetUrl: payrollSs.getUrl(), periodTitle: '', employees: [] };

  const maxCol = Math.min(sheet.getLastColumn(), 63);
  const values = sheet.getRange(1, 1, lastRow, maxCol).getValues();
  const periodTitle = String(values[0][6] || ''); // G1 เช่น "เดือน สิงหาคม 2569"

  const numVal = v => {
    const n = Number(v);
    return isNaN(n) ? 0 : Math.round(n * 100) / 100;
  };
  const dateFmt = v => (v instanceof Date ? Utilities.formatDate(v, TIMEZONE, 'dd/MM/yyyy') : String(v || ''));

  const employees = [];
  for (let r = 2; r < values.length; r++) {
    const row = values[r];
    const code = String(row[0] || '').trim();
    const name = String(row[1] || '').trim();
    const nickname = String(row[2] || '').trim();
    if (!name && !nickname) continue;
    // ข้ามแถวสรุปรวมด้านล่าง
    if (name.indexOf('รวม') === 0 || code.indexOf('รวม') === 0) continue;

    employees.push({
      rowIndex: r + 1,
      code: code,
      name: name,
      nickname: nickname,
      position: String(row[3] || ''),
      hire_date: dateFmt(row[4]),
      base_salary: numVal(row[5]),
      work_hours: numVal(row[37]),
      ot15_hours: numVal(row[38]),
      ot20_hours: numVal(row[39]),
      ot30_hours: numVal(row[40]),
      ot_baht: numVal(row[41]),
      commission: numVal(row[42]),
      measurement: numVal(row[43]),
      frame_bonus: numVal(row[44]),
      diligence: numVal(row[45]),
      position_allowance: numVal(row[46]),
      phone_allowance: numVal(row[47]),
      deduct_absent: numVal(row[48]),
      deduct_pvd: numVal(row[50]),
      deduct_uniform: numVal(row[51]),
      deduct_goods: numVal(row[52]),
      deduct_damage: numVal(row[53]),
      deduct_other: numVal(row[54]),
      deduct_forbid_absent: numVal(row[55]),
      deduct_late: numVal(row[56]),
      gross_income: numVal(row[57]),
      sso: numVal(row[58]),
      tax: numVal(row[59]),
      net_pay: numVal(row[60]),
      bank: String(row[61] || ''),
      bank_account: String(row[62] || '')
    });
  }

  return {
    sheetUrl: payrollSs.getUrl(),
    periodTitle: periodTitle,
    employees: employees
  };
}

/**
 * แก้ไขตัวเลขรายได้/รายการหักของพนักงาน 1 แถวในชีต Calculation จากหน้า Dashboard
 * (ไม่ไปทับคอลัมน์ที่เป็นสูตร เช่น ประกันสังคม, ภาษี PND 1, ยอดสุทธิ)
 */
function updatePayrollCalculationRow(rowIndex, updates, actor) {
  const payrollSs = getPayrollDb();
  const sheet = payrollSs.getSheetByName('Calculation');
  if (!sheet) throw new Error('ไม่พบชีต "Calculation" ใน Google Sheet เงินเดือนครับ');

  const colMap = {
    base_salary: 6,          // F
    diligence: 46,           // AT
    position_allowance: 47,  // AU
    phone_allowance: 48,     // AV
    deduct_goods: 53,        // BA (ใส่ค่าลบ เช่น -200)
    deduct_damage: 54,       // BB
    deduct_other: 55,        // BC
    deduct_forbid_absent: 56 // BD
  };

  const before = {};
  const after = {};
  Object.keys(colMap).forEach(key => {
    if (updates[key] !== undefined && updates[key] !== '') {
      const col = colMap[key];
      const cell = sheet.getRange(rowIndex, col);
      before[key] = cell.getValue();
      const val = Number(updates[key]);
      if (!isNaN(val)) {
        cell.setValue(val);
        after[key] = val;
      }
    }
  });

  SpreadsheetApp.flush();
  repoAppendAuditLog(actor || 'admin', 'EDIT_PAYROLL_ROW', 'Calculation', 'ROW_' + rowIndex, before, after, 'แก้ไขตัวเลขเงินเดือนจาก Dashboard');
  return { ok: true };
}
