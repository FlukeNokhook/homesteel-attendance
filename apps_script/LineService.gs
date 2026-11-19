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
  if (rec.duration_mode === 'HALF_DAY') return 'ครึ่งวัน (4 ชม.)';
  return rec.days + ' วัน';
}

function notifyApproverNewLeave(rec) {
  const cfg = getAppConfig();
  const isApprovalNeeded = rec.status === 'PENDING';
  const header = isApprovalNeeded
    ? '🌴 มีคำขอลาพักร้อนรออนุมัติครับ'
    : '📋 แจ้งเพื่อทราบ: พนักงานยื่น' + rec.leave_type;
  const dateText = rec.start_date + (rec.end_date !== rec.start_date ? ' ถึง ' + rec.end_date : '');
  const flagsText = rec.flags ? '⚠️ หมายเหตุระบบ: ' + rec.flags : '';

  const msg = [
    header,
    '',
    '👤 ' + rec.name,
    '📌 ' + rec.leave_type + ' • ' + formatLeaveDur(rec),
    '📅 ' + dateText,
    '💬 ' + (rec.reason || '-'),
    rec.attachment_file_id ? '📎 มีไฟล์แนบ' : '',
    flagsText,
    cfg.LIFF_URL ? '\nเปิดดูรายละเอียดได้ที่ 👉 ' + cfg.LIFF_URL + '?tab=approve' : ''
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

function notifyEmployeeAcknowledged(empId, leaveType, dateLabel) {
  const emp = repoFindEmployeeById(empId);
  if (!emp || !emp.line_user_id) return;
  sendLinePush(emp.line_user_id, '👍 หัวหน้างานได้รับทราบใบ' + leaveType + ' วันที่ ' + dateLabel + ' เรียบร้อยแล้วครับ');
}
