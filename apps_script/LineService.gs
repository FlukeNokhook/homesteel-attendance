/**
 * LineService.gs
 * ส่งแจ้งเตือนผ่าน LINE Messaging API ด้วยภาษาไทยที่สุภาพและเป็นธรรมชาติ
 */

function sendLinePush(lineUserId, textMessage) {
  if (!lineUserId) return;
  const cfg = getAppConfig();
  if (!cfg.LINE_CHANNEL_ACCESS_TOKEN) {
    Logger.log('[LINE Skip - No Token] ถึง ' + lineUserId + ': ' + textMessage);
    return;
  }
  try {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + cfg.LINE_CHANNEL_ACCESS_TOKEN },
      payload: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text: textMessage }] }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('LINE push ไม่สำเร็จ: ' + res.getContentText());
    }
  } catch (err) {
    Logger.log('ส่งข้อความ LINE ไม่สำเร็จ: ' + err.message);
  }
}

function formatLeaveDur(rec) {
  if (rec.duration_mode === 'HOURS') return rec.hours + ' ชั่วโมง';
  return rec.days + ' วัน';
}

function notifyApproverNewLeave(rec, extra) {
  const cfg = getAppConfig();
  const info = extra || {};
  const isApprovalNeeded = rec.status === 'PENDING';
  const header = isApprovalNeeded
    ? '🌴 มีคำขอลาพักร้อนรออนุมัติครับ'
    : '📋 แจ้งเพื่อทราบ: พนักงานยื่น' + rec.leave_type;
  const dateText = rec.start_date + (rec.end_date !== rec.start_date ? ' ถึง ' + rec.end_date : '');

  let sickLine = '';
  let sickSummaryLine = '';
  if (rec.leave_type === 'ลาป่วย') {
    if (rec.sub_type === 'SICK_NO_CERT') {
      const seq = info.sickNoCertSeq || 1;
      sickLine = seq === 1
        ? 'ℹ️ ลาป่วยไม่มีใบรับรองแพทย์ (ครั้งที่ 1 ของเดือนนี้)'
        : '⚠️ ลาป่วยไม่มีใบรับรองแพทย์ (ครั้งที่ ' + seq + ' ของเดือนนี้ — เกินสิทธิ์ 1 ครั้ง/เดือน)';
    } else {
      sickLine = '📎 ลาป่วยมีใบรับรองแพทย์';
    }
    if (info.quotas) {
      const q = info.quotas;
      sickSummaryLine = '📊 เดือนนี้ป่วยรวม ' + q.sickCountMonth + ' ครั้ง (มีใบรับรองฯ ' + q.sickWithCertCountMonth + ' / ไม่มี ' + q.sickNoCertCountMonth + ') • ปีนี้เหลือ ' + q.sickRemainingYear + '/' + q.sickLimit + ' วัน';
    }
  }

  const consecLine = info.consecutiveAlert ? '🚨 ' + info.consecutiveAlert : '';

  const msg = [
    header,
    '',
    '👤 ' + rec.name,
    '📌 ' + rec.leave_type + ' • ' + formatLeaveDur(rec),
    '📅 ' + dateText,
    '💬 ' + (rec.reason || '-'),
    sickLine,
    sickSummaryLine,
    consecLine,
    cfg.LIFF_URL ? '\nกดตรวจสอบและดำเนินการได้ที่ 👉 ' + cfg.LIFF_URL + '?tab=approve' : ''
  ].filter(Boolean).join('\n');

  repoGetApprovers(rec.employee_id).forEach(a => sendLinePush(a.line_user_id, msg));
}

function notifyApproverNewOT(rec) {
  const cfg = getAppConfig();
  const msg = [
    '⏰ มีคำขอทำโอทีรออนุมัติครับ',
    '',
    '👤 ' + rec.name,
    '📅 ' + rec.ot_date + ' • ' + rec.requested_start + '-' + rec.requested_end + ' (' + rec.requested_hours + ' ชม.)',
    '🔧 งาน: ' + (rec.job_reference || '-'),
    rec.reason ? '💬 ' + rec.reason : '',
    cfg.LIFF_URL ? '\nกดอนุมัติได้ที่ 👉 ' + cfg.LIFF_URL + '?tab=approve' : ''
  ].filter(Boolean).join('\n');

  repoGetApprovers(rec.employee_id).forEach(a => sendLinePush(a.line_user_id, msg));
}

function notifyApproverMissedScan(rec) {
  const scanLabel = rec.scan_type === 'IN' ? 'เข้างาน' : rec.scan_type === 'OUT' ? 'ออกงาน' : 'ทั้งเข้าและออก';
  const msg = [
    '🔔 พนักงานแจ้งลืมสแกนนิ้ว (ส่งเข้า Exception List แล้ว)',
    '',
    '👤 ' + rec.name,
    '📅 วันที่: ' + rec.work_date + ' (ลืมสแกน' + scanLabel + ')',
    rec.approx_time ? '🕐 เวลาโดยประมาณ: ' + rec.approx_time : '',
    '💬 เหตุผล: ' + (rec.reason || '-')
  ].filter(Boolean).join('\n');

  repoGetApprovers(rec.employee_id).forEach(a => sendLinePush(a.line_user_id, msg));
}

function notifyApproverMedicalCertUploaded(rec) {
  const msg = [
    '📎 พนักงานแนบใบรับรองแพทย์เพิ่มเติมแล้วครับ',
    '👤 ' + rec.name + ' • ลาป่วยวันที่ ' + rec.start_date,
    'ระบบปรับสถานะเป็นมีใบรับรองแพทย์เรียบร้อยแล้ว'
  ].join('\n');

  repoGetApprovers(rec.employee_id).forEach(a => sendLinePush(a.line_user_id, msg));
}

function notifyEmployeeDecision(empId, typeLabel, dateLabel, isApproved, rejectReason) {
  const emp = repoFindEmployeeById(empId);
  if (!emp || !emp.line_user_id) return;
  const msg = isApproved
    ? '✅ คำขอ' + typeLabel + ' วันที่ ' + dateLabel + ' ได้รับการอนุมัติเรียบร้อยแล้วครับ'
    : 'แจ้งให้ทราบครับ คำขอ' + typeLabel + ' วันที่ ' + dateLabel + ' ยังไม่ได้รับการอนุมัติ\nเหตุผล: ' + (rejectReason || 'รบกวนสอบถามรายละเอียดเพิ่มเติมนะครับ');
  sendLinePush(emp.line_user_id, msg);
}

function notifyEmployeeSickDecision(empId, dateLabel, allowBenefit, note) {
  const emp = repoFindEmployeeById(empId);
  if (!emp || !emp.line_user_id) return;
  const msg = allowBenefit
    ? '✅ หัวหน้างานรับทราบใบลาป่วย วันที่ ' + dateLabel + ' และอนุมัติให้ใช้สิทธิ์ลาป่วยได้ครับ'
    : '⚠️ หัวหน้างานรับทราบใบลาป่วย วันที่ ' + dateLabel + ' แต่ไม่อนุมัติการใช้สิทธิ์ลาป่วยแบบได้รับค่าจ้าง\nหมายเหตุ: ' + (note || 'กรุณาติดต่อหัวหน้างานเพิ่มเติม');
  sendLinePush(emp.line_user_id, msg);
}

function notifyEmployeeAcknowledged(empId, leaveType, dateLabel) {
  const emp = repoFindEmployeeById(empId);
  if (!emp || !emp.line_user_id) return;
  sendLinePush(emp.line_user_id, '👍 หัวหน้างานได้รับทราบใบ' + leaveType + ' วันที่ ' + dateLabel + ' เรียบร้อยแล้วครับ');
}
