/**
 * Config.gs
 * ศูนย์รวมชื่อชีต ค่าตั้งต้น และการอ่าน Script Properties
 * ออกแบบให้รองรับ Cloudflare Worker ในอนาคตผ่าน INTERNAL_PROXY_SECRET (ถ้ายังไม่ใช้ปล่อยว่างไว้)
 */

const SHEETS = {
  EMPLOYEES: 'Employees',
  ATTENDANCE_DAILY: 'Attendance_Daily',
  LEAVE: 'Leave',
  OT: 'OT',
  MISSED_SCAN: 'Missed_Scan',
  AUDIT_LOG: 'Audit_Log',
  PAYROLL_PERIOD: 'Payroll_Period',
  SETTINGS: 'Settings',
  HOLIDAYS: 'Holidays',
  FRAME_FINDING: 'Frame_Finding',
  SITE_MEASURE: 'Site_Measure',
  COMMISSION_MONTHLY: 'Commission_Monthly',
  PAYROLL_MONTHLY_LOG: 'Payroll_Monthly_Log'
};

const TIMEZONE = 'Asia/Bangkok';

const LEAVE_TYPES = ['ลาป่วย', 'ลากิจ', 'ลาพักร้อน', 'ลาอบรม'];

const DEFAULT_SETTINGS = {
  WORK_START_TIME: '08:00',
  WORK_END_TIME: '17:00',
  LUNCH_MINUTES: '60',
  WORK_HOURS_PER_DAY: '8',
  GRACE_LATE_MINUTES: '5',
  SHORT_WORK_THRESHOLD_HOURS: '4',
  PERSONAL_LEAVE_LIMIT_DAYS: '3',
  PERSONAL_ADVANCE_HOURS: '8',
  VACATION_LEAVE_LIMIT_DAYS: '6',
  SICK_LEAVE_LIMIT_DAYS: '30',
  SICK_NO_CERT_MONTHLY_DAYS: '1',
  COUNT_WORKING_DAYS_ONLY: 'TRUE'
};

/**
 * ดึงค่า Config จาก Script Properties
 * (เก็บความลับทั้งหมดใน Script Properties ห้าม hardcode ลงโค้ด)
 */
function getAppConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    SHEET_ID: props.getProperty('SHEET_ID') || '',
    PAYROLL_SHEET_ID: props.getProperty('PAYROLL_SHEET_ID') || '',
    DRIVE_FOLDER_ID: props.getProperty('DRIVE_FOLDER_ID') || '',
    LINE_CHANNEL_ID: props.getProperty('LINE_CHANNEL_ID') || '',
    LINE_CHANNEL_ACCESS_TOKEN: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '',
    API_SECRET: props.getProperty('API_SECRET') || '',
    ADMIN_SECRET: props.getProperty('ADMIN_SECRET') || '',
    INTERNAL_PROXY_SECRET: props.getProperty('INTERNAL_PROXY_SECRET') || '',
    LIFF_URL: props.getProperty('LIFF_URL') || ''
  };
}
