/**
 * Setup.gs
 * รัน setupDatabase() ครั้งแรกเพื่อสร้างแท็บและหัวตารางทั้งหมดใน Factory_Payroll_DB
 * (รันซ้ำได้อย่างปลอดภัย ไม่ลบข้อมูลเดิม)
 */

const DB_SCHEMA = {
  Employees: [
    'employee_id', 'code', 'name', 'nickname', 'department', 'position',
    'fingerprint_id', 'line_user_id', 'role', 'supervisor_id', 'status', 'hire_date', 'vacation_quota',
    'title', 'national_id', 'email', 'phone', 'address', 'bank_name', 'bank_account', 'pvd_join_date', 'pvd_rate',
    'uniform_deposit_paid', 'uniform_monthly_deduct'
  ],
  Attendance_Daily: [
    'work_date', 'employee_id', 'code', 'name', 'first_in', 'last_out',
    'work_minutes', 'late_min', 'early_leave_min', 'absent_min',
    'leave_hours', 'leave_type', 'ot_approved_hours', 'ot_actual_min',
    'ot_paid_hours', 'missing_scan', 'status', 'flags', 'admin_note',
    'period_id', 'updated_at'
  ],
  Leave: [
    'request_id', 'employee_id', 'name', 'leave_type', 'sub_type',
    'start_date', 'end_date', 'duration_mode', 'hours', 'days',
    'reason', 'notice_type', 'urgent_reason', 'attachment_file_id',
    'status', 'flags', 'approver_id', 'approved_at', 'reject_reason',
    'submitted_at', 'period_id'
  ],
  OT: [
    'request_id', 'employee_id', 'name', 'ot_date',
    'requested_start', 'requested_end', 'approved_start', 'approved_end',
    'actual_start', 'actual_end', 'requested_hours', 'approved_hours',
    'job_reference', 'reason', 'status', 'approver_id', 'approved_at',
    'reject_reason', 'submitted_at', 'period_id'
  ],
  Missed_Scan: [
    'report_id', 'employee_id', 'name', 'work_date', 'scan_type',
    'approx_time', 'reason', 'status', 'resolved_by', 'resolved_at', 'submitted_at'
  ],
  Audit_Log: [
    'log_id', 'timestamp', 'who', 'action', 'target_table',
    'target_id', 'before', 'after', 'reason'
  ],
  Payroll_Period: [
    'year_month', 'start_date', 'end_date', 'status', 'locked_by', 'locked_at'
  ],
  Settings: [
    'key', 'value', 'description'
  ],
  Holidays: [
    'holiday_date', 'holiday_name'
  ],
  Frame_Finding: [
    'record_id', 'year_month', 'employee_id', 'code', 'name', 'nickname',
    'bill_no', 'customer_name', 'sales_amount', 'amount', 'note', 'created_by', 'created_at'
  ],
  Site_Measure: [
    'record_id', 'year_month', 'bill_no', 'customer_name', 'sales_amount', 'total_amount',
    'participants_json', 'participants_summary', 'note', 'created_by', 'created_at'
  ],
  Commission_Monthly: [
    'year_month', 'gross_sales', 'prev_year_sales', 'capital', 'credit_note', 'incident_case', 'supercoil',
    'net_sales', 'pv_project_sales', 'front_store_sales', 'extra_prod_sales',
    'rate_full_pct', 'rate_half_pct', 'sales_kpi_deduct', 'prod_kpi_deduct',
    'sales_pool', 'prod_pool', 'sales_hours_total', 'prod_hours_total',
    'allocations_json', 'updated_by', 'updated_at'
  ],
  Payroll_Monthly_Log: [
    'year_month', 'employee_id', 'code', 'name', 'work_days', 'late_min', 'absent_min', 'leave_hours',
    'diligence_eligible', 'diligence_streak', 'diligence_amount', 'missing_scan_count',
    'forbid_absent_days', 'forbid_absent_deduct', 'uniform_deducted', 'uniform_applied', 'updated_at'
  ]
};

const RAW_HEADERS = [
  'transaction_key', 'device_id', 'fingerprint_id', 'employee_id',
  'timestamp', 'source', 'received_at'
];

const SETTINGS_SEED = [
  ['WORK_START_TIME', '08:00', 'เวลาเข้างานมาตรฐาน'],
  ['WORK_END_TIME', '17:00', 'เวลาเลิกงานมาตรฐาน'],
  ['LUNCH_MINUTES', '60', 'เวลาพักเที่ยง (นาที)'],
  ['WORK_HOURS_PER_DAY', '8', 'จำนวนชั่วโมงทำงานต่อวัน (ใช้นับวันลาจากชั่วโมง)'],
  ['GRACE_LATE_MINUTES', '0', 'นาทีอนุโลมก่อนนับมาสาย'],
  ['SHORT_WORK_THRESHOLD_HOURS', '4', 'ชั่วโมงทำงานขั้นต่ำ หากน้อยกว่านี้จะแจ้งเตือนใน Exception List'],
  ['PERSONAL_LEAVE_LIMIT_DAYS', '3', 'โควตาลากิจต่อปี (วันทำงาน)'],
  ['PERSONAL_ADVANCE_DAYS', '1', 'จำนวนวันล่วงหน้าสำหรับลากิจปกติ'],
  ['SICK_LEAVE_LIMIT_DAYS', '30', 'โควตาลาป่วยรวมต่อปี (วันทำงาน)'],
  ['SICK_NO_CERT_MONTHLY_DAYS', '1', 'โควตาลาป่วยแบบไม่มีใบรับรองแพทย์ต่อเดือน (วัน)'],
  ['COUNT_WORKING_DAYS_ONLY', 'TRUE', 'TRUE = นับเฉพาะวันทำงาน (ไม่นับวันอาทิตย์และวันหยุดในแท็บ Holidays)']
];

function setupDatabase() {
  const ss = repoGetMainDb();

  Object.keys(DB_SCHEMA).forEach(sheetName => {
    const headers = DB_SCHEMA[sheetName];
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers])
        .setFontWeight('bold').setBackground('#1e3a8a').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
    sheet.autoResizeColumns(1, headers.length);
  });

  // สร้างแท็บ Attendance_Raw_YYYY สำหรับปีปัจจุบัน
  const currentYear = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy');
  repoGetRawSheet(currentYear);

  // เติม Settings เริ่มต้นถ้ายังไม่มี
  const existingSettings = repoReadAll(SHEETS.SETTINGS).rows;
  const existingKeys = new Set(existingSettings.map(r => String(r.key)));
  const missingSettings = SETTINGS_SEED
    .filter(row => !existingKeys.has(row[0]))
    .map(row => ({ key: row[0], value: row[1], description: row[2] }));
  if (missingSettings.length) repoAppendBulk(SHEETS.SETTINGS, missingSettings);

  // Dropdown ช่วยกรอก Employees
  const empSheet = ss.getSheetByName(SHEETS.EMPLOYEES);
  const empHeaders = DB_SCHEMA.Employees;
  const roleCol = empHeaders.indexOf('role') + 1;
  const statusCol = empHeaders.indexOf('status') + 1;
  empSheet.getRange(2, roleCol, empSheet.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['employee', 'supervisor', 'admin'], true).build());
  empSheet.getRange(2, statusCol, empSheet.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['ACTIVE', 'INACTIVE'], true).build());

  // สร้างงวดเดือนปัจจุบัน
  repoGetOrCreatePeriod(todayStr());

  // ลบชีตเปล่าเริ่มต้น
  ['Sheet1', 'ชีต1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  repoClearCache();
  Logger.log('ตั้งค่าฐานข้อมูล Factory_Payroll_DB เสร็จเรียบร้อยแล้ว');
}

/**
 * เพิ่มคอลัมน์ vacation_quota ต่อท้ายแท็บ Employees ให้อัตโนมัติ (ถ้ายังไม่มี)
 */
function ensureVacationQuotaColumn() {
  const cache = CacheService.getScriptCache();
  if (cache.get('has_vac_quota_col') === '1') return;
  const sheet = repoGetMainDb().getSheetByName(SHEETS.EMPLOYEES);
  if (!sheet || sheet.getLastRow() < 1) return;
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  if (headers.indexOf('vacation_quota') === -1) {
    const newCol = lastCol + 1;
    sheet.getRange(1, newCol).setValue('vacation_quota')
      .setFontWeight('bold').setBackground('#1e3a8a').setFontColor('#ffffff');
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const defaults = [];
      for (let i = 2; i <= lastRow; i++) defaults.push(['6']);
      sheet.getRange(2, newCol, defaults.length, 1).setNumberFormat('@').setValues(defaults);
    }
    repoClearCache();
  }
  cache.put('has_vac_quota_col', '1', 21600);
}

/**
 * สร้างแท็บ Frame_Finding และ Site_Measure ใน Factory_Payroll_DB อัตโนมัติหากยังไม่มี
 */
function ensureBonusSheets() {
  const ss = repoGetMainDb();
  [SHEETS.FRAME_FINDING, SHEETS.SITE_MEASURE, SHEETS.COMMISSION_MONTHLY, SHEETS.PAYROLL_MONTHLY_LOG].forEach(name => {
    const headers = DB_SCHEMA[name];
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers])
        .setFontWeight('bold').setBackground('#1e3a8a').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
      sheet.autoResizeColumns(1, headers.length);
    }
  });
}

/**
 * เพิ่มคอลัมน์ข้อมูลทะเบียนพนักงาน & กองทุนฯ (N-U) ต่อท้ายแท็บ Employees อัตโนมัติหากยังไม่มี
 */
function ensureEmployeeProfileColumns() {
  const sheet = repoGetMainDb().getSheetByName(SHEETS.EMPLOYEES);
  if (!sheet || sheet.getLastRow() < 1) return;
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const missing = DB_SCHEMA.Employees.filter(col => headers.indexOf(col) === -1);
  if (!missing.length) return;

  const startCol = lastCol + 1;
  if (startCol + missing.length - 1 > sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), startCol + missing.length - 1 - sheet.getMaxColumns());
  }
  sheet.getRange(1, startCol, 1, missing.length).setValues([missing])
    .setFontWeight('bold').setBackground('#1e3a8a').setFontColor('#ffffff');
  sheet.getRange(2, startCol, Math.max(1, sheet.getMaxRows() - 1), missing.length).setNumberFormat('@');
  repoClearCache();
}
