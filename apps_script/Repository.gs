/**
 * Repository.gs
 * Data Access Layer เพียงไฟล์เดียวของระบบ (รวมศูนย์การอ่าน-เขียน Google Sheets ทั้งหมด)
 * หากในอนาคตย้ายฐานข้อมูลไป Cloudflare D1 หรือ Supabase สามารถแก้เฉพาะไฟล์นี้ได้โดยไม่กระทบส่วนอื่น
 *
 * หลักการทำงาน:
 * - อ่าน/เขียนแบบ Batch (getValues / setValues) เสมอ
 * - ตั้งค่า Plain Text ('@') กัน Sheets แปลงวันที่/เวลาอัตโนมัติ
 * - ใช้ CacheService สำหรับข้อมูลที่เปลี่ยนน้อย (Employees, Settings, Holidays)
 * - แยกข้อมูลสแกนนิ้วดิบรายปี (Attendance_Raw_YYYY หรือแยกไฟล์ Spreadsheet ตาม RAW_SPREADSHEET_ID_YYYY ใน Settings)
 */

const DATE_COLS = ['work_date', 'start_date', 'end_date', 'ot_date', 'holiday_date', 'hire_date'];
const TIME_COLS = ['first_in', 'last_out', 'requested_start', 'requested_end', 'approved_start', 'approved_end', 'actual_start', 'actual_end', 'approx_time'];
const YM_COLS = ['year_month', 'period_id'];

function nowStr() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function todayStr() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
}

function generateId(prefix) {
  const ts = Utilities.formatDate(new Date(), TIMEZONE, 'yyyyMMddHHmmss');
  const rand = Utilities.getUuid().slice(0, 4).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

function repoGetMainDb() {
  const cfg = getAppConfig();
  if (cfg.SHEET_ID) return SpreadsheetApp.openById(cfg.SHEET_ID);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('ไม่พบ Spreadsheet กรุณาตั้งค่า Script Property: SHEET_ID');
  return active;
}

/**
 * เปิดชีต Attendance_Raw_YYYY ของปีที่ระบุ
 * ถ้าตั้งค่า RAW_SPREADSHEET_ID_2026 ในแท็บ Settings จะเปิดจากไฟล์แยกปีนั้นอัตโนมัติ
 * ถ้าไม่ได้ตั้งค่า จะสร้างแท็บ Attendance_Raw_2026 ในไฟล์หลักให้ใช้งานได้ทันที
 */
function repoGetRawSheet(year) {
  const y = String(year || Utilities.formatDate(new Date(), TIMEZONE, 'yyyy'));
  const settings = repoGetSettings();
  const extId = settings['RAW_SPREADSHEET_ID_' + y];
  const ss = extId ? SpreadsheetApp.openById(extId) : repoGetMainDb();
  const tabName = 'Attendance_Raw_' + y;
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.getRange(1, 1, 1, RAW_HEADERS.length).setValues([RAW_HEADERS])
      .setFontWeight('bold').setBackground('#1e3a8a').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, sheet.getMaxRows(), RAW_HEADERS.length).setNumberFormat('@');
  }
  return sheet;
}

const THAI_MONTH_MAP = {
  'ม.ค.': 1, 'ก.พ.': 2, 'มี.ค.': 3, 'เม.ย.': 4, 'พ.ค.': 5, 'มิ.ย.': 6,
  'ก.ค.': 7, 'ส.ค.': 8, 'ก.ย.': 9, 'ต.ค.': 10, 'พ.ย.': 11, 'ธ.ค.': 12,
  'มกราคม': 1, 'กุมภาพันธ์': 2, 'มีนาคม': 3, 'เมษายน': 4, 'พฤษภาคม': 5, 'มิถุนายน': 6,
  'กรกฎาคม': 7, 'สิงหาคม': 8, 'กันยายน': 9, 'ตุลาคม': 10, 'พฤศจิกายน': 11, 'ธันวาคม': 12
};

/**
 * แปลงวันที่ทุกรูปแบบ (Date, yyyy-MM-dd, yyyy/MM/dd, "4 พ.ค. 26", "15/08/2569") เป็น "yyyy-MM-dd"
 */
function repoNormalizeDate(val) {
  if (val instanceof Date) return Utilities.formatDate(val, TIMEZONE, 'yyyy-MM-dd');
  const s = String(val || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) {
    let y = parseInt(m[1], 10);
    if (y > 2400) y -= 543;
    return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += (y >= 50 ? 2500 - 543 : 2000);
    else if (y > 2400) y -= 543;
    return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  }
  m = s.match(/^(\d{1,2})\s+([^\s]+)\s+(\d{2,4})/);
  if (m && THAI_MONTH_MAP[m[2]]) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += (y >= 50 ? 2500 - 543 : 2000);
    else if (y > 2400) y -= 543;
    return y + '-' + String(THAI_MONTH_MAP[m[2]]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  }
  return s;
}

function repoFormatCellDate(dateObj, headerName) {
  if (DATE_COLS.indexOf(headerName) !== -1) return Utilities.formatDate(dateObj, TIMEZONE, 'yyyy-MM-dd');
  if (TIME_COLS.indexOf(headerName) !== -1) return Utilities.formatDate(dateObj, TIMEZONE, 'HH:mm');
  if (YM_COLS.indexOf(headerName) !== -1) return Utilities.formatDate(dateObj, TIMEZONE, 'yyyy-MM');
  return Utilities.formatDate(dateObj, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function repoReadSheet(sheet) {
  if (!sheet) return { sheet: null, headers: [], rows: [] };
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { sheet: sheet, headers: [], rows: [] };

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(h => String(h).trim());
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const obj = { _rowIndex: r + 1 };
    let hasValue = false;
    for (let c = 0; c < headers.length; c++) {
      const val = values[r][c];
      if (val !== '' && val !== null && val !== undefined) hasValue = true;
      if (val instanceof Date) {
        obj[headers[c]] = repoFormatCellDate(val, headers[c]);
      } else if (DATE_COLS.indexOf(headers[c]) !== -1 && val) {
        obj[headers[c]] = repoNormalizeDate(val);
      } else {
        obj[headers[c]] = val;
      }
    }
    if (hasValue) rows.push(obj);
  }
  return { sheet: sheet, headers: headers, rows: rows };
}

function repoReadAll(sheetName) {
  return repoReadSheet(repoGetMainDb().getSheetByName(sheetName));
}

function repoReadRawByYear(year) {
  return repoReadSheet(repoGetRawSheet(year));
}

function repoWriteRowsAt(sheet, startRow, rows) {
  if (!rows || !rows.length) return;
  const needLastRow = startRow + rows.length - 1;
  if (needLastRow > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), needLastRow - sheet.getMaxRows());
  }
  const range = sheet.getRange(startRow, 1, rows.length, rows[0].length);
  range.setNumberFormat('@');
  range.setValues(rows);
}

function repoAppendBulk(sheetName, objs) {
  if (!objs || !objs.length) return;
  const sheet = repoGetMainDb().getSheetByName(sheetName);
  if (!sheet) throw new Error('ไม่พบชีต ' + sheetName + ' กรุณารัน setupDatabase() ก่อน');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const rows = objs.map(o => headers.map(h => (o[h] !== undefined && o[h] !== null ? o[h] : '')));
  repoWriteRowsAt(sheet, sheet.getLastRow() + 1, rows);
}

function repoAppendRawBulk(year, objs) {
  if (!objs || !objs.length) return;
  const sheet = repoGetRawSheet(year);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const rows = objs.map(o => headers.map(h => (o[h] !== undefined && o[h] !== null ? o[h] : '')));
  repoWriteRowsAt(sheet, sheet.getLastRow() + 1, rows);
}

function repoAppendRow(sheetName, obj) {
  repoAppendBulk(sheetName, [obj]);
}

function repoUpdateRow(sheetName, rowIndex, updates) {
  if (!rowIndex) throw new Error('ไม่พบตำแหน่งแถวที่ต้องการแก้ไข');
  const sheet = repoGetMainDb().getSheetByName(sheetName);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const rowVals = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  let changed = false;
  Object.keys(updates).forEach(k => {
    const idx = headers.indexOf(k);
    if (idx !== -1) {
      rowVals[idx] = updates[k] !== undefined && updates[k] !== null ? updates[k] : '';
      changed = true;
    }
  });
  if (changed) {
    const range = sheet.getRange(rowIndex, 1, 1, lastCol);
    range.setNumberFormat('@');
    range.setValues([rowVals]);
  }
}

/* ================= Cache (Employees / Settings / Holidays) ================= */

function repoCacheGet(key, ttlSec, loader) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get(key);
  if (raw) {
    try { return JSON.parse(raw); } catch (_) {}
  }
  const data = loader();
  try { cache.put(key, JSON.stringify(data), ttlSec || 300); } catch (_) {}
  return data;
}

function repoClearCache() {
  try {
    CacheService.getScriptCache().removeAll(['cache_settings', 'cache_employees', 'cache_holidays', 'cache_holidays_map']);
  } catch (_) {}
}

function repoGetSettings() {
  return repoCacheGet('cache_settings', 300, function () {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    const { rows } = repoReadAll(SHEETS.SETTINGS);
    rows.forEach(r => {
      if (r.key) out[String(r.key).trim()] = String(r.value !== undefined ? r.value : '').trim();
    });
    return out;
  });
}

function repoGetSettingNum(key, fallback) {
  const s = repoGetSettings();
  const n = Number(s[key]);
  return isNaN(n) ? fallback : n;
}

function repoGetEmployees() {
  return repoCacheGet('cache_employees', 180, function () {
    return repoReadAll(SHEETS.EMPLOYEES).rows;
  });
}

function repoGetHolidayMap() {
  // แท็บ Holidays มีไม่กี่แถว อ่านสดทุกครั้งเพื่อให้การเพิ่ม/ลบวันหยุดมีผลทันทีโดยไม่ติด Cache
  const map = {};
  repoReadAll(SHEETS.HOLIDAYS).rows.forEach(h => {
    const d = String(h.holiday_date || '').trim();
    if (d) map[d] = String(h.holiday_name || 'วันหยุดนักขัตฤกษ์').trim();
  });
  return map;
}

function repoGetHolidaySet() {
  return new Set(Object.keys(repoGetHolidayMap()));
}

/* ================= Domain Helpers ================= */

function isActiveEmp(e) {
  return String((e && e.status) || 'ACTIVE').toUpperCase() !== 'INACTIVE';
}

function isApproverRole(emp) {
  const role = String((emp && emp.role) || '').toLowerCase();
  return role === 'supervisor' || role === 'admin';
}

function repoFindEmployeeByLineId(lineUserId) {
  const uid = String(lineUserId || '').trim();
  return repoGetEmployees().find(e => String(e.line_user_id).trim() === uid && isActiveEmp(e)) || null;
}

function repoFindEmployeeById(empId) {
  const id = String(empId || '').trim();
  return repoGetEmployees().find(e => String(e.employee_id).trim() === id || String(e.code).trim() === id) || null;
}

function repoGetApprovers(excludeEmpId) {
  return repoGetEmployees().filter(e =>
    isApproverRole(e) && isActiveEmp(e) && e.line_user_id &&
    String(e.employee_id) !== String(excludeEmpId || '')
  );
}

function isOffDay(dateStr, holidaySet) {
  const dow = new Date(dateStr + 'T00:00:00+07:00').getDay();
  return dow === 0 || (holidaySet && holidaySet.has(dateStr));
}

function repoAppendAuditLog(who, action, targetTable, targetId, beforeObj, afterObj, reason) {
  repoAppendRow(SHEETS.AUDIT_LOG, {
    log_id: generateId('LOG'),
    timestamp: nowStr(),
    who: who || 'system',
    action: action,
    target_table: targetTable,
    target_id: targetId,
    before: beforeObj ? JSON.stringify(beforeObj) : '',
    after: afterObj ? JSON.stringify(afterObj) : '',
    reason: reason || ''
  });
}

/* ================= Payroll Period ================= */

function repoFindPeriod(ym) {
  const { rows } = repoReadAll(SHEETS.PAYROLL_PERIOD);
  return rows.find(r => String(r.year_month) === ym) || null;
}

function repoGetOrCreatePeriod(dateStr) {
  const ym = String(dateStr).slice(0, 7);
  const found = repoFindPeriod(ym);
  if (found) return found;

  const p = ym.split('-');
  const y = parseInt(p[0], 10);
  const m = parseInt(p[1], 10) - 1;
  repoAppendRow(SHEETS.PAYROLL_PERIOD, {
    year_month: ym,
    start_date: Utilities.formatDate(new Date(y, m, 1), TIMEZONE, 'yyyy-MM-dd'),
    end_date: Utilities.formatDate(new Date(y, m + 1, 0), TIMEZONE, 'yyyy-MM-dd'),
    status: 'open',
    locked_by: '',
    locked_at: ''
  });
  return repoFindPeriod(ym);
}

function repoAssertPeriodEditable(dateStr) {
  const period = repoGetOrCreatePeriod(dateStr);
  if (String(period.status).toLowerCase() === 'locked') {
    throw new Error('งวดเดือน ' + period.year_month + ' ปิดและล็อกแล้ว ไม่สามารถเพิ่มหรือแก้ไขข้อมูลย้อนหลังได้ครับ');
  }
  return period.year_month;
}

/* ================= Concurrency Lock ================= */

function withScriptLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('ขณะนี้มีผู้ใช้งานพร้อมกันหลายคน กรุณาลองใหม่อีกครั้งในอีกสักครู่ครับ');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
