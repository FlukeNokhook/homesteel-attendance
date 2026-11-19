# HomesteelKK — ระบบลงเวลา ลา และโอที (เฟสที่ 1)

โครงสร้างโปรเจกต์เฟสที่ 1:
- `apps_script/` — Google Apps Script (V8, `Asia/Bangkok`) + `Repository.gs` (รวมศูนย์การอ่าน/เขียนฐานข้อมูลไฟล์เดียว) + หน้า Admin Dashboard (`AdminWeb.html`)
- `liff/` — หน้าจอพนักงานและหัวหน้างานบน LINE OA (ขอลา, ขอโอที, แจ้งลืมสแกนนิ้ว, อัปโหลดใบรับรองแพทย์ย้อนหลัง, อนุมัติ/รับทราบ)

---

## ขั้นตอนการติดตั้งและทดสอบ (บนบัญชี Dev ของคุณเอง)

### 1. เตรียม Google Sheet & Google Drive
1. สร้าง Google Sheet เปล่า ตั้งชื่อว่า **`Factory_Payroll_DB`** (เก็บ **Sheet ID** จาก URL)
2. สร้างโฟลเดอร์ใน Google Drive ตั้งชื่อว่า **`HR Attachments`** (ตั้งเป็น Private เท่านั้น และเก็บ **Folder ID** จาก URL)

### 2. ติดตั้ง Google Apps Script (`apps_script/`)
1. เปิด Google Sheet `Factory_Payroll_DB` → **Extensions > Apps Script** *(หรือใช้ `clasp push` จากโฟลเดอร์ `apps_script/`)*
2. นำไฟล์ `.gs` ทั้งหมด, `AdminWeb.html` และ `appsscript.json` ขึ้นไปที่โปรเจกต์ Apps Script
3. ไปที่ **Project Settings > Script Properties** แล้วเพิ่มค่า:
   - `SHEET_ID` = ID ของ Google Sheet `Factory_Payroll_DB`
   - `DRIVE_FOLDER_ID` = ID ของโฟลเดอร์ `HR Attachments`
   - `ADMIN_SECRET` = รหัสผ่านสำหรับเข้าหน้า Admin Dashboard
   - `LINE_CHANNEL_ID` = Channel ID ของ **LINE Login**
   - `LINE_CHANNEL_ACCESS_TOKEN` = Channel Access Token ของ **LINE Messaging API**
   - `LIFF_URL` = URL ของ LIFF App (`https://liff.line.me/xxxx`)
   - *(เผื่ออนาคต)* `API_SECRET` = รหัสลับสำหรับ Gateway PC เฟส 2, `INTERNAL_PROXY_SECRET` = ปล่อยว่างไว้ตอนนี้ (ใส่เฉพาะเมื่อเพิ่ม Cloudflare Worker คั่นหน้าในอนาคต)
4. รันฟังก์ชัน **`setupDatabase()`** ใน `Setup.gs` 1 ครั้ง → ระบบจะสร้างแท็บทั้งหมดให้อัตโนมัติ (`Employees`, `Attendance_Raw_YYYY`, `Attendance_Daily`, `Leave`, `OT`, `Missed_Scan`, `Audit_Log`, `Payroll_Period`, `Settings`, `Holidays`)
5. กด **Deploy > New deployment > Web app** (`Execute as: Me`, `Who has access: Anyone`) แล้วคัดลอก **Web App URL**

### 3. ติดตั้ง LINE OA + LIFF (`liff/`)
1. แก้ไขไฟล์ `liff/config.js` ใส่ `LIFF_ID` และ `GAS_API_URL`
2. นำโฟลเดอร์ `liff/` ไปโฮสต์แบบ Static ฟรี (เช่น **GitHub Pages** หรือ **Cloudflare Pages**)
3. ใน [LINE Developers Console](https://developers.line.biz/console/):
   - ตั้งค่า **LINE Login Channel** → เพิ่ม **LIFF App** (Scopes: `profile`, `openid`) ชี้ไปที่ URL ของเว็บจากข้อ 2
   - ผูก **LIFF URL** เข้ากับ **Rich Menu** ของ LINE OA

### 4. การตั้งค่าพนักงานและการย้ายขึ้น Production
- เพิ่มรายชื่อพนักงานในแท็บ `Employees` (`employee_id`, `code`, `name`, `department`, `fingerprint_id`, `line_user_id`, `role` = `employee` หรือ `admin` สำหรับแฟนคุณ, `status` = `ACTIVE`)
- เมื่อย้ายจาก Dev ไปบัญชีบริษัทแฟน: สร้าง Sheet/Drive + Push `apps_script/` + ตั้ง `Script Properties` ใหม่ + สร้าง LINE OA/LIFF ใหม่ และอัปเดต `liff/config.js` เพียงเท่านี้ครับ
- หากต้องการแยกไฟล์ `Attendance_Raw_YYYY` เป็นคนละ Spreadsheet ในปีถัดไป ให้เพิ่มแถว `RAW_SPREADSHEET_ID_2027` ในแท็บ `Settings` โดยไม่ต้องแก้โค้ดครับ
