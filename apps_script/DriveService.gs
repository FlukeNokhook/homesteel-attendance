/**
 * DriveService.gs
 * จัดเก็บไฟล์แนบใบลา/ใบรับรองแพทย์ใน Google Drive แบบ Private
 * โครงสร้างโฟลเดอร์: <DRIVE_FOLDER_ID>/YYYY/MM/ (เช่น 2026/11/)
 * เก็บเฉพาะ file_id ลง Google Sheets และไม่แชร์แบบ Anyone with the link
 */

const ALLOWED_ATTACHMENT_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024; // 3 MB

function getOrCreateSubFolder(parent, name) {
  const iter = parent.getFoldersByName(name);
  return iter.hasNext() ? iter.next() : parent.createFolder(name);
}

function getOrCreateYearMonthFolder(yearMonth) {
  const cfg = getAppConfig();
  if (!cfg.DRIVE_FOLDER_ID) {
    throw new Error('ระบบยังไม่ได้ตั้งค่า DRIVE_FOLDER_ID กรุณาแจ้งผู้ดูแลระบบครับ');
  }
  const parts = String(yearMonth || '').split('-');
  const year = parts[0] || Utilities.formatDate(new Date(), TIMEZONE, 'yyyy');
  const month = parts[1] || Utilities.formatDate(new Date(), TIMEZONE, 'MM');

  const root = DriveApp.getFolderById(cfg.DRIVE_FOLDER_ID);
  const yearFolder = getOrCreateSubFolder(root, year);
  return getOrCreateSubFolder(yearFolder, month);
}

function saveAttachmentToDrive(base64Data, fileName, mimeType, yearMonth) {
  if (!base64Data) return '';
  const mime = String(mimeType || 'image/jpeg').toLowerCase();
  if (ALLOWED_ATTACHMENT_MIME.indexOf(mime) === -1) {
    throw new Error('รองรับเฉพาะไฟล์รูปภาพ (JPG, PNG) เท่านั้นครับ');
  }
  const cleanBase64 = base64Data.indexOf(',') !== -1 ? base64Data.split(',')[1] : base64Data;
  const bytes = Utilities.base64Decode(cleanBase64);
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error('ไฟล์แนบมีขนาดใหญ่เกินไป (เกิน 3 MB) รบกวนลองถ่ายรูปใหม่อีกครั้งนะครับ');
  }

  const blob = Utilities.newBlob(bytes, mime, fileName);
  const file = getOrCreateYearMonthFolder(yearMonth).createFile(blob);
  return file.getId();
}

function getAttachmentDataUrl(fileId) {
  if (!fileId) return '';
  const blob = DriveApp.getFileById(fileId).getBlob();
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}
