/* HomesteelKK LIFF — หน้าจอพนักงานและหัวหน้างาน */

let ID_TOKEN = '';
let CURRENT_EMP = null;
let DATA = { quotas: {}, leaves: [], ots: [], attendance: { daily: [], missedScans: [] }, pending_vacations: [], unack_leaves: [], pending_ots: [] };
let LEAVE_HOURS = 2;
let ATTACHMENT = '';
let LATER_CERT_REQ_ID = '';

const DOW = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const MONTH_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const $ = id => document.getElementById(id);

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function thaiDate(ds) {
  if (!ds) return '-';
  const d = new Date(ds + 'T00:00:00');
  return `${DOW[d.getDay()]} ${d.getDate()} ${MONTH_TH[d.getMonth()]} ${String(d.getFullYear() + 543).slice(2)}`;
}
function minsToText(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h && m ? `${h} ชม. ${m} นาที` : h ? `${h} ชม.` : `${m} นาที`;
}
function radioVal(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : '';
}
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3500);
}
function sheet({ title, body = '', html = '', confirmText = 'ตกลง', confirmClass = 'btn-primary', cancelText = 'ยกเลิก', input = false, placeholder = '', hideCancel = false }) {
  return new Promise(resolve => {
    const root = $('sheetRoot');
    root.innerHTML = `<div class="sheet-bg"><div class="sheet"><div class="grab"></div>
      ${html}${title ? `<h3>${esc(title)}</h3>` : ''}${body ? `<p>${esc(body)}</p>` : ''}
      ${input ? `<textarea id="sheetInput" class="input" rows="3" placeholder="${esc(placeholder)}"></textarea>` : ''}
      <div class="sheet-actions">
        ${hideCancel ? '' : `<button class="btn btn-ghost" data-act="cancel">${esc(cancelText)}</button>`}
        <button class="btn ${confirmClass}" data-act="ok">${esc(confirmText)}</button>
      </div></div></div>`;
    const close = v => { root.innerHTML = ''; resolve(v); };
    const cancel = root.querySelector('[data-act="cancel"]');
    if (cancel) cancel.onclick = () => close(null);
    root.querySelector('[data-act="ok"]').onclick = () => close(input ? $('sheetInput').value : true);
    root.querySelector('.sheet-bg').onclick = e => { if (e.target.classList.contains('sheet-bg')) close(null); };
  });
}

/* ================= API ================= */
function ensureFreshToken() {
  const decoded = liff.getDecodedIDToken();
  if (decoded && decoded.exp * 1000 < Date.now() + 60 * 1000) {
    liff.logout();
    liff.login({ redirectUri: location.href });
    throw new Error('กำลังเชื่อมต่อ LINE ใหม่อีกครั้ง...');
  }
  ID_TOKEN = liff.getIDToken();
}

async function callApi(action, payload = {}) {
  ensureFreshToken();
  let res;
  try {
    res = await fetch(window.HOMESTEEL_CONFIG.GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, id_token: ID_TOKEN, payload })
    });
  } catch (e) {
    throw new Error('เชื่อมต่ออินเทอร์เน็ตไม่สำเร็จ รบกวนตรวจสอบสัญญาณแล้วลองใหม่อีกครั้งนะครับ');
  }
  const data = await res.json();
  if (data.status !== 'ok') {
    if (data.code === 'TOKEN_EXPIRED') {
      liff.logout();
      liff.login({ redirectUri: location.href });
    }
    const err = new Error(data.message || 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งครับ');
    err.code = data.code;
    err.line_user_id = data.line_user_id;
    throw err;
  }
  return data;
}

/* ================= Init ================= */
window.addEventListener('load', async () => {
  const today = todayIso();
  $('leaveStart').value = today;
  $('leaveEnd').value = today;
  $('otDate').value = today;
  $('msDate').value = today;
  bindForm();
  const h = new Date().getHours();
  $('greeting').textContent = h < 12 ? 'สวัสดีตอนเช้าครับ ☀️' : h < 17 ? 'สวัสดีตอนบ่ายครับ 🌤️' : 'สวัสดีตอนเย็นครับ 🌙';

  try {
    await liff.init({ liffId: window.HOMESTEEL_CONFIG.LIFF_ID });
    if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
    const profile = liff.getDecodedIDToken() || {};
    if (profile.picture) $('avatar').innerHTML = `<img src="${esc(profile.picture)}" alt="" />`;
    if (profile.name) $('userName').textContent = profile.name;

    await loadData();

    const tab = new URLSearchParams(location.search).get('tab');
    if (tab === 'approve' && isApprover()) switchTab('approve');
    else if (tab === 'ot') switchTab('ot');
    else if (tab === 'attendance') switchTab('attendance');
    else if (tab === 'history') switchTab('history');
  } catch (err) {
    showStatusError(err.message);
  }
});

function showStatusError(msg) {
  $('statusSpinner').classList.add('hidden');
  $('statusMsg').textContent = msg;
  $('retryBtn').classList.remove('hidden');
}
function isApprover() {
  const r = String((CURRENT_EMP && CURRENT_EMP.role) || '').toLowerCase();
  return r === 'supervisor' || r === 'admin';
}

async function loadData() {
  try {
    const data = await callApi('liff_me');
    CURRENT_EMP = data.employee;
    DATA = data;
    $('userName').textContent = CURRENT_EMP.name;
    $('userDept').textContent = [CURRENT_EMP.department, `รหัส ${CURRENT_EMP.code}`].filter(Boolean).join(' • ');
    $('statusBox').classList.add('hidden');
    $('mainContent').classList.remove('hidden');
    $('bottomNav').classList.remove('hidden');

    updateLeaveForm();
    renderHistory();
    renderAttendance();
    renderJobSuggest();
    if (isApprover()) {
      $('approveNavBtn').classList.remove('hidden');
      renderApprovals();
    }
  } catch (err) {
    if (err.code === 'UNREGISTERED_LINE') {
      $('statusSpinner').classList.add('hidden');
      $('statusMsg').textContent = err.message;
      $('myLineUid').value = err.line_user_id || '';
      $('unregisteredBox').classList.remove('hidden');
    } else showStatusError(err.message);
  }
}

function copyLineUid() {
  const el = $('myLineUid');
  el.select();
  if (navigator.clipboard) navigator.clipboard.writeText(el.value);
  else document.execCommand('copy');
  toast('คัดลอกรหัสแล้ว ส่งให้ผู้ดูแลระบบได้เลยครับ');
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.bottom-nav button[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});

function switchTab(tab) {
  document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['leave', 'ot', 'attendance', 'history', 'approve'].forEach(t => $('tab-' + t).classList.toggle('hidden', t !== tab));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ================= Leave Form ================= */
function bindForm() {
  document.querySelectorAll('input[name="durationMode"], input[name="leaveType"], input[name="sickReasonType"]')
    .forEach(r => r.addEventListener('change', updateLeaveForm));
  $('leaveStart').addEventListener('change', () => {
    if ($('leaveEnd').value < $('leaveStart').value || radioVal('durationMode') !== 'FULL_DAY') $('leaveEnd').value = $('leaveStart').value;
    updateLeaveForm();
  });
  $('leaveEnd').addEventListener('change', updateLeaveForm);
  $('leaveFile').addEventListener('change', onFileChange);
  $('laterCertInput').addEventListener('change', onLaterCertSelected);

  ['otStart', 'otEnd'].forEach(id => $(id).addEventListener('change', updateOtTotal));
  document.querySelectorAll('input[name="histFilter"]').forEach(r => r.addEventListener('change', renderHistory));
  updateOtTotal();
}

function addDaysIso(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function checkClientConsecutive(startDate, endDate, leaveType) {
  if (!startDate) return '';
  const hMap = DATA.holidays || {};
  const isOff = ds => (new Date(ds + 'T00:00:00').getDay() === 0) || !!hMap[ds];
  const dayMap = {};
  const addRange = (s, e, label) => {
    let cur = s, guard = 0;
    while (cur <= (e || s) && guard < 60) {
      if (!isOff(cur)) dayMap[cur] = label;
      cur = addDaysIso(cur, 1);
      guard++;
    }
  };
  (DATA.leaves || []).filter(l => String(l.status).toUpperCase() !== 'REJECTED')
    .forEach(l => addRange(String(l.start_date), String(l.end_date || l.start_date), l.leave_type));
  addRange(startDate, endDate || startDate, leaveType || 'ลา');

  const shiftWork = (ds, delta) => {
    let cur = ds;
    for (let i = 0; i < 14; i++) {
      cur = addDaysIso(cur, delta);
      if (!isOff(cur)) return cur;
    }
    return ds;
  };

  let cStart = startDate, cEnd = endDate || startDate;
  while (true) { const p = shiftWork(cStart, -1); if (dayMap[p]) cStart = p; else break; }
  while (true) { const n = shiftWork(cEnd, 1); if (dayMap[n]) cEnd = n; else break; }

  const timeline = [];
  let cur = cStart, guard = 0;
  while (cur <= cEnd && guard < 60) {
    const shortD = cur.slice(8, 10) + '/' + cur.slice(5, 7);
    if (dayMap[cur]) timeline.push(`${shortD} ${dayMap[cur]}`);
    else if (isOff(cur)) timeline.push(`${shortD} (${hMap[cur] ? 'วันหยุด:' + hMap[cur] : 'วันหยุดอาทิตย์'})`);
    cur = addDaysIso(cur, 1);
    guard++;
  }
  return timeline.length >= 3 ? `หยุดต่อเนื่อง ${timeline.length} วัน: ${timeline.join(' → ')}` : '';
}

function nextWorkingDayIso(isoDate) {
  const hMap = DATA.holidays || {};
  let cur = isoDate;
  for (let i = 0; i < 14; i++) {
    const isOff = (new Date(cur + 'T00:00:00').getDay() === 0) || !!hMap[cur];
    if (!isOff) return cur;
    cur = addDaysIso(cur, 1);
  }
  return cur;
}

function updateLeaveForm() {
  const type = radioVal('leaveType');
  const today = todayIso();
  const minAdvance3 = nextWorkingDayIso(addDaysIso(today, 3)); // หากตรงวันอาทิตย์หรือวันหยุดนักขัตฤกษ์ ให้ขยับเป็นวันทำงานถัดไป
  const minBack7 = addDaysIso(today, -7);

  // ลาพักร้อน: ไม่มีแบบรายชั่วโมง บังคับเต็มวันเท่านั้น
  if (type === 'ลาพักร้อน') {
    document.querySelector('input[name="durationMode"][value="FULL_DAY"]').checked = true;
    $('durationWrap').classList.add('hidden');
  } else {
    $('durationWrap').classList.remove('hidden');
  }
  const mode = radioVal('durationMode');

  // ตั้งค่าช่วงวันที่ที่เลือกได้ตามประเภทการลา
  let minDate = '';
  if (type === 'ลาพักร้อน' || type === 'ลาอบรม') {
    minDate = minAdvance3;
  } else if (type === 'ลาป่วย') {
    minDate = radioVal('sickReasonType') === 'APPOINTMENT' ? today : minBack7;
  }

  if (minDate) {
    $('leaveStart').min = minDate;
    $('leaveEnd').min = minDate;
    if (!$('leaveStart').value || $('leaveStart').value < minDate) $('leaveStart').value = minDate;
    if (!$('leaveEnd').value || $('leaveEnd').value < $('leaveStart').value) $('leaveEnd').value = $('leaveStart').value;
  } else {
    $('leaveStart').removeAttribute('min');
    $('leaveEnd').removeAttribute('min');
  }

  const s = $('leaveStart').value;
  const e = mode === 'FULL_DAY' ? $('leaveEnd').value : s;
  const q = DATA.quotas || {};

  // ลากิจต้องแจ้งล่วงหน้าอย่างน้อย 8 ชม. (เทียบกับเวลา 08:00 น. ของวันลา)
  const isPersonalUnder8h = type === 'ลากิจ' && s && ((new Date(s + 'T08:00:00+07:00').getTime() - Date.now()) < 8 * 3600 * 1000);

  $('leaveEndWrap').classList.toggle('hidden', mode !== 'FULL_DAY');
  $('leaveHoursWrap').classList.toggle('hidden', mode !== 'HOURS');
  $('leaveStartLabel').textContent = mode === 'FULL_DAY' ? 'ตั้งแต่วันที่' : 'วันที่ลา';
  $('sickReasonWrap').classList.toggle('hidden', type !== 'ลาป่วย');
  $('urgentWrap').classList.toggle('hidden', !isPersonalUnder8h);
  $('uploadLabel').innerHTML = type === 'ลาอบรม'
    ? 'แนบรูปเอกสารทางการประกอบการลาอบรม <span style="color:#b91c1c;">(บังคับแนบ *)</span>'
    : 'แนบรูปใบรับรองแพทย์ / เอกสาร <span class="opt">(ถ้ามี)</span>';

  const banner = $('quotaBanner');
  if (type === 'ลาป่วย') {
    const noCertCount = q.sickNoCertCountMonth || 0;
    const withCertCount = q.sickWithCertCountMonth || 0;
    const totalMonthCount = q.sickCountMonth || 0;
    const noCertLeft = q.sickNoCertRemainingMonth !== undefined ? q.sickNoCertRemainingMonth : 1;
    const isAppt = radioVal('sickReasonType') === 'APPOINTMENT';
    const monthStatus = totalMonthCount > 0
      ? `📊 เดือนนี้คุณลาป่วยไปแล้ว <b>${totalMonthCount} ครั้ง</b> (มีใบรับรองแพทย์ ${withCertCount} ครั้ง / ไม่มีใบรับรองแพทย์ ${noCertCount} ครั้ง)`
      : `📊 เดือนนี้คุณยังไม่เคยลาป่วยครับ`;
    const dateNote = isAppt ? '📅 นัดแพทย์ไม่สามารถเลือกวันย้อนหลังได้' : '📅 ป่วยกะทันหันเลือกย้อนหลังได้ไม่เกิน 7 วัน';
    const warn = (noCertCount >= 1 || noCertLeft <= 0)
      ? `<div style="margin-top:6px; padding:8px 10px; border-radius:8px; background:#fee2e2; color:#991b1b; font-weight:600;">⚠️ เดือนนี้ใช้สิทธิ์ไม่มีใบรับรองแพทย์ครบแล้ว กรุณาแนบใบรับรองแพทย์ภายในวันที่ 30 ของเดือน (หากไม่ส่งจะไม่นับชั่วโมงทำงาน)</div>`
      : `<div style="margin-top:4px; color:#15803d;">✅ เดือนนี้ยังมีสิทธิ์ลาป่วยไม่มีใบรับรองแพทย์เหลือ <b>1 ครั้ง</b></div>`;
    banner.innerHTML = `${monthStatus}<br>สิทธิ์ลาป่วยปีนี้คงเหลือ: <b>${q.sickRemainingYear ?? 30}</b> / ${q.sickLimit ?? 30} วัน<br><span class="hint">${dateNote}</span>${warn}`;
    banner.classList.remove('hidden');
  } else if (type === 'ลากิจ') {
    const warn8h = isPersonalUnder8h
      ? `<div style="margin-top:6px; padding:7px 10px; border-radius:8px; background:#fee2e2; color:#991b1b; font-weight:600;">⚠️ แจ้งล่วงหน้าน้อยกว่า 8 ชม. — ยังกดส่งได้ แต่วันดังกล่าวจะถือเป็นวันขาดงาน ไม่นับชั่วโมงทำงาน และมีผลต่อการคิดเงินเดือนครับ</div>`
      : `<div class="hint" style="margin-top:4px;">⏰ ลากิจต้องแจ้งล่วงหน้าอย่างน้อย 8 ชั่วโมง • บันทึกทันทีและแจ้งหัวหน้ารับทราบ</div>`;
    banner.innerHTML = `สิทธิ์ลากิจปีนี้คงเหลือ: <b>${q.personalRemaining ?? 3}</b> / ${q.personalLimit ?? 3} วัน${warn8h}`;
    banner.classList.remove('hidden');
  } else if (type === 'ลาพักร้อน') {
    banner.innerHTML = `🌴 สิทธิ์ลาพักร้อนของคุณปีนี้คงเหลือ: <b>${q.vacationRemaining ?? 6}</b> / ${q.vacationLimit ?? 6} วัน<br><span class="hint">ลาพักร้อนต้องยื่นล่วงหน้าอย่างน้อย 3 วัน (ตั้งแต่ ${esc(thaiDate(minAdvance3))}) แบบเต็มวันเท่านั้น และรอหัวหน้าอนุมัติ</span>`;
    banner.classList.remove('hidden');
  } else if (type === 'ลาอบรม') {
    banner.innerHTML = `🎓 <b>ลาอบรม</b> ต้องยื่นล่วงหน้าอย่างน้อย <b>3 วัน</b> (ตั้งแต่ <b>${esc(thaiDate(minAdvance3))}</b>) และ<b>ต้องแนบรูปเอกสารทางการประกอบการลาเท่านั้น</b>`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  let durText = mode === 'HOURS' ? `${LEAVE_HOURS} ชั่วโมง` : '';
  if (mode === 'FULL_DAY' && s && e && e >= s) {
    const days = Math.round((new Date(e) - new Date(s)) / 86400000) + 1;
    durText = `${days} วัน${days > 1 ? ' (ระบบนับเฉพาะวันทำงาน)' : ''}`;
  }
  const hMap = DATA.holidays || {};
  const isSingleOff = s && (!e || e === s) && ((new Date(s + 'T00:00:00').getDay() === 0) || !!hMap[s]);
  const offWarn = isSingleOff
    ? `<div style="margin-top:6px; padding:7px 10px; border-radius:8px; background:#fef3c7; color:#92400e; font-size:12.5px; font-weight:600;">⚠️ วันที่ ${esc(thaiDate(s))} เป็น${hMap[s] ? 'วันหยุด: ' + esc(hMap[s]) : 'วันหยุดประจำสัปดาห์ (วันอาทิตย์)'} กรุณาเลือกวันทำงานครับ</div>`
    : '';
  const consecWarn = s ? checkClientConsecutive(s, e, type) : '';
  $('leaveSummary').innerHTML = s
    ? `<b>${esc(type)}</b> • ${esc(durText)}<br>📅 ${esc(thaiDate(s))}${e && e !== s ? ' – ' + esc(thaiDate(e)) : ''}` +
      offWarn +
      (consecWarn ? `<div style="margin-top:8px; padding:8px 10px; border-radius:8px; background:#fee2e2; color:#991b1b; font-size:13px; font-weight:600;">🚨 แจ้งเตือน: ${esc(consecWarn)}</div>` : '')
    : '';
}

function stepHours(delta) {
  LEAVE_HOURS = Math.min(7.5, Math.max(0.5, LEAVE_HOURS + delta));
  $('leaveHoursVal').textContent = LEAVE_HOURS;
  updateLeaveForm();
}

async function onFileChange() {
  const f = $('leaveFile').files[0];
  if (!f) return;
  if (!/^image\//.test(f.type)) { toast('รองรับเฉพาะไฟล์รูปภาพครับ', true); clearFile(); return; }
  try {
    ATTACHMENT = await compressImage(f);
    $('uploadImg').src = ATTACHMENT;
    $('uploadEmpty').classList.add('hidden');
    $('uploadPreview').classList.remove('hidden');
  } catch (e) { toast('อ่านรูปไม่สำเร็จ ลองใหม่นะครับ', true); clearFile(); }
}

function clearFile(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  ATTACHMENT = '';
  $('leaveFile').value = '';
  $('uploadEmpty').classList.remove('hidden');
  $('uploadPreview').classList.add('hidden');
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const max = 1280;
        let w = img.width, h = img.height;
        if (w > max || h > max) {
          if (w > h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; }
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function submitLeave(e) {
  e.preventDefault();
  const type = radioVal('leaveType');
  const mode = type === 'ลาพักร้อน' ? 'FULL_DAY' : radioVal('durationMode');
  const start = $('leaveStart').value;
  const end = mode === 'FULL_DAY' ? $('leaveEnd').value : start;
  if (end < start) { toast('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มลานะครับ', true); return; }
  if (type === 'ลาอบรม' && !ATTACHMENT) {
    toast('การลาอบรมต้องแนบรูปเอกสารทางการประกอบการลาด้วยครับ', true);
    return;
  }

  const consecWarn = checkClientConsecutive(start, end, radioVal('leaveType'));
  if (consecWarn) {
    const ok = await sheet({
      title: '⚠️ แจ้งเตือนการหยุดต่อเนื่องตั้งแต่ 3 วันขึ้นไป',
      body: `${consecWarn}\n\nระบบจะบันทึกใบลาและส่งแจ้งเตือนนี้ให้หัวหน้างานพิจารณา คุณต้องการยืนยันส่งใบลาหรือไม่?`,
      confirmText: 'ยืนยันส่งใบลา',
      confirmClass: 'btn-primary'
    });
    if (!ok) return;
  }

  const btn = $('btnSubmitLeave');
  btn.disabled = true; btn.textContent = 'กำลังส่งใบลา...';
  try {
    const res = await callApi('liff_submit_leave', {
      leave_type: radioVal('leaveType'),
      sick_reason_type: radioVal('sickReasonType'),
      duration_mode: mode,
      start_date: start,
      end_date: end,
      hours: LEAVE_HOURS,
      urgent_reason: $('urgentReason').value.trim(),
      reason: $('leaveReason').value.trim(),
      attachment_base64: ATTACHMENT,
      attachment_mime: 'image/jpeg'
    });
    $('leaveReason').value = '';
    $('urgentReason').value = '';
    clearFile();
    await sheet({ html: '<div class="success-ico">✅</div>', title: 'ส่งเรียบร้อยแล้ว', body: res.message, confirmText: 'ดูประวัติ', hideCancel: true });
    await loadData();
    document.querySelector('input[name="histFilter"][value="leave"]').checked = true;
    renderHistory();
    switchTab('history');
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = 'ส่งใบลา'; }
}

/* ================= Upload Medical Cert Later ================= */
function triggerUploadLaterCert(requestId) {
  LATER_CERT_REQ_ID = requestId;
  $('laterCertInput').value = '';
  $('laterCertInput').click();
}

async function onLaterCertSelected() {
  const f = $('laterCertInput').files[0];
  if (!f || !LATER_CERT_REQ_ID) return;
  toast('กำลังอัปโหลดใบรับรองแพทย์...');
  try {
    const b64 = await compressImage(f);
    const res = await callApi('liff_upload_med_cert', {
      request_id: LATER_CERT_REQ_ID,
      attachment_base64: b64,
      attachment_mime: 'image/jpeg'
    });
    toast(res.message);
    await loadData();
  } catch (err) { toast(err.message, true); }
}

/* ================= OT Form ================= */
function updateOtTotal() {
  const s = $('otStart').value, e = $('otEnd').value;
  if (!s || !e) return;
  const [sh, sm] = s.split(':').map(Number), [eh, em] = e.split(':').map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff <= 0) diff += 1440;
  $('otTotal').innerHTML = `รวม <b>${esc(minsToText(diff))}</b>${e <= s ? ' <span class="hint">(ข้ามเที่ยงคืน)</span>' : ''}`;
}

function quickOt(hours) {
  const s = $('otStart').value || '17:00';
  const [h, m] = s.split(':').map(Number);
  const total = (h * 60 + m + hours * 60) % 1440;
  $('otEnd').value = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  updateOtTotal();
}

function renderJobSuggest() {
  const jobs = [...new Set((DATA.ots || []).map(o => o.job_reference).filter(Boolean))].slice(0, 10);
  $('jobSuggest').innerHTML = jobs.map(j => `<option value="${esc(j)}"></option>`).join('');
}

async function submitOT(e) {
  e.preventDefault();
  const btn = $('btnSubmitOt');
  btn.disabled = true; btn.textContent = 'กำลังส่งคำขอ...';
  try {
    const res = await callApi('liff_submit_ot', {
      ot_date: $('otDate').value,
      start_time: $('otStart').value,
      end_time: $('otEnd').value,
      job_reference: $('otJob').value.trim(),
      reason: $('otReason').value.trim()
    });
    $('otJob').value = '';
    $('otReason').value = '';
    await sheet({ html: '<div class="success-ico">✅</div>', title: 'ส่งเรียบร้อยแล้ว', body: res.message, confirmText: 'ดูประวัติ', hideCancel: true });
    await loadData();
    document.querySelector('input[name="histFilter"][value="ot"]').checked = true;
    renderHistory();
    switchTab('history');
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = 'ส่งคำขอโอที'; }
}

/* ================= Missed Scan & My Attendance ================= */
async function submitMissedScan(e) {
  e.preventDefault();
  const btn = $('btnSubmitMs');
  btn.disabled = true; btn.textContent = 'กำลังส่ง...';
  try {
    const res = await callApi('liff_report_missed_scan', {
      work_date: $('msDate').value,
      scan_type: radioVal('msType'),
      approx_time: $('msTime').value,
      reason: $('msReason').value.trim()
    });
    $('msReason').value = '';
    toast(res.message);
    await loadData();
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = 'แจ้งลืมสแกนนิ้ว'; }
}

function renderAttendance() {
  const daily = (DATA.attendance && DATA.attendance.daily) || [];
  $('myAttendanceList').innerHTML = daily.length ? daily.slice(0, 20).map(r => `
    <div class="item">
      <div class="item-ico" style="background:var(--brand-soft)">🕒</div>
      <div class="item-body">
        <div class="item-top"><div class="item-title">${esc(thaiDate(r.work_date))}</div><span class="pill pill-${r.flags ? 'PENDING' : 'APPROVED'}">${esc(r.status)}</span></div>
        <div class="item-meta">เข้า: <b>${esc(r.first_in || '-')}</b> • ออก: <b>${esc(r.last_out || '-')}</b>${Number(r.late_min) > 0 ? ` • สาย ${r.late_min} น.` : ''}${Number(r.ot_paid_hours) > 0 ? ` • OT ${r.ot_paid_hours} ชม.` : ''}</div>
      </div>
    </div>`).join('') : '<div class="empty"><i>🕒</i>ยังไม่มีข้อมูลเวลาเข้า-ออกของเดือนนี้</div>';
}

/* ================= History ================= */
const STATUS_TH = {
  PENDING: 'รออนุมัติ',
  APPROVED: 'อนุมัติแล้ว',
  REJECTED: 'ไม่อนุมัติ',
  RECORDED: 'บันทึกแล้ว',
  ACKNOWLEDGED: 'รับทราบแล้ว',
  ACKNOWLEDGED_PAID: 'รับทราบ • ใช้สิทธิ์ได้',
  ACKNOWLEDGED_UNPAID: 'รับทราบ • ไม่อนุมัติใช้สิทธิ์',
  WAITING_MEDICAL_CERT: 'รอใบรับรองแพทย์'
};
function statusClass(st) {
  if (st === 'APPROVED' || st === 'ACKNOWLEDGED' || st === 'ACKNOWLEDGED_PAID' || st === 'RECORDED') return 'APPROVED';
  if (st === 'REJECTED' || st === 'ACKNOWLEDGED_UNPAID') return 'REJECTED';
  return 'PENDING';
}
function leaveDur(l) { return l.duration_mode === 'HOURS' ? `${l.hours} ชม.` : `${l.days} วัน`; }

function renderHistory() {
  const f = radioVal('histFilter');
  const list = f === 'ot' ? (DATA.ots || []) : (DATA.leaves || []);
  if (!list.length) {
    $('historyList').innerHTML = `<div class="empty"><i>${f === 'ot' ? '⏰' : '📝'}</i>ยังไม่มีประวัติ${f === 'ot' ? 'การขอโอที' : 'การลา'}</div>`;
    return;
  }
  $('historyList').innerHTML = list.map(x => {
    if (f === 'ot') {
      return `<div class="item"><div class="item-ico" style="background:var(--green-soft)">⏰</div><div class="item-body">
        <div class="item-top"><div class="item-title">โอที ${esc(x.requested_hours)} ชม.</div><span class="pill pill-${statusClass(x.status)}">${esc(STATUS_TH[x.status] || x.status)}</span></div>
        <div class="item-meta">📅 ${esc(thaiDate(x.ot_date))} • ${esc(x.requested_start)}–${esc(x.requested_end)}<br>🔧 ${esc(x.job_reference || '-')}${x.reject_reason ? `<br>❗ ${esc(x.reject_reason)}` : ''}</div>
      </div></div>`;
    }
    const dText = x.start_date === x.end_date ? thaiDate(x.start_date) : `${thaiDate(x.start_date)} – ${thaiDate(x.end_date)}`;
    let needCertBtn = '';
    if (x.status === 'WAITING_MEDICAL_CERT') {
      const ym = String(x.start_date || '').slice(0, 7);
      const [yy, mm] = ym.split('-').map(Number);
      const lastD = new Date(yy, mm, 0).getDate();
      const deadline = `${ym}-${String(Math.min(30, lastD)).padStart(2, '0')}`;
      needCertBtn = todayIso() > deadline
        ? `<div style="margin-top:6px; font-size:12px; color:#991b1b; font-weight:600;">❌ เลยกำหนดส่งใบรับรองแพทย์ (วันที่ 30) แล้ว — ไม่นับชั่วโมงทำงาน</div>`
        : `<div class="item-actions"><button class="btn btn-primary btn-sm" onclick="triggerUploadLaterCert('${esc(x.request_id)}')">📎 แนบใบรับรองแพทย์ (ภายใน ${esc(thaiDate(deadline))})</button></div>`;
    }
    return `<div class="item"><div class="item-ico" style="background:var(--brand-soft)">📝</div><div class="item-body">
      <div class="item-top"><div class="item-title">${esc(x.leave_type)} ${esc(leaveDur(x))}</div><span class="pill pill-${statusClass(x.status)}">${esc(STATUS_TH[x.status] || x.status)}</span></div>
      <div class="item-meta">📅 ${esc(dText)}<br>💬 ${esc(x.reason || '-')}${x.attachment_file_id ? '<br>📎 แนบเอกสารแล้ว' : ''}${x.reject_reason ? `<br>❗ ${esc(x.reject_reason)}` : ''}</div>
      ${needCertBtn}
    </div></div>`;
  }).join('');
}

/* ================= Approvals & Acknowledge ================= */
function renderApprovals() {
  const vacs = DATA.pending_vacations || [];
  const ots = DATA.pending_ots || [];
  const unacks = DATA.unack_leaves || [];
  const total = vacs.length + ots.length + unacks.length;
  $('approveBadge').textContent = total;
  $('approveBadge').classList.toggle('hidden', total === 0);

  if (!total) {
    $('approveList').innerHTML = '<div class="empty"><i>✨</i>ไม่มีรายการค้างอนุมัติหรือรับทราบครับ</div>';
    return;
  }

  let html = '';
  if (vacs.length) {
    html += `<div class="group-label">🌴 ลาพักร้อนรออนุมัติ (${vacs.length})</div>` + vacs.map(l => {
      const dText = l.end_date && l.end_date !== l.start_date ? `${thaiDate(l.start_date)} – ${thaiDate(l.end_date)}` : thaiDate(l.start_date);
      const vacBox = l.vacation_info
        ? `<div style="margin-top:6px; padding:6px 10px; border-radius:8px; background:#dcfce7; color:#15803d; font-size:12.5px;">🌴 สิทธิ์ลาพักร้อนคงเหลือของ ${esc(l.name)}: <b>${l.vacation_info.remainingDays}/${l.vacation_info.limitDays} วัน</b></div>`
        : '';
      return `<div class="item"><div class="item-ico" style="background:var(--brand-soft)">🌴</div><div class="item-body">
        <div class="item-title">${esc(l.name)} • ลาพักร้อน ${esc(leaveDur(l))}</div>
        <div class="item-meta">📅 ${esc(dText)}<br>💬 ${esc(l.reason || '-')}</div>
        ${vacBox}
        ${l.consecutive_alert ? `<div style="margin-top:6px; padding:7px 10px; border-radius:8px; background:#fee2e2; color:#991b1b; font-size:12.5px; font-weight:600;">🚨 ${esc(l.consecutive_alert)}</div>` : ''}
        <div class="item-actions">
          <button class="btn btn-reject btn-sm" onclick="decideItem('LEAVE','${esc(l.request_id)}',false)">ไม่อนุมัติ</button>
          <button class="btn btn-approve btn-sm" onclick="decideItem('LEAVE','${esc(l.request_id)}',true)">✓ อนุมัติ</button>
        </div>
      </div></div>`;
    }).join('');
  }
  if (ots.length) {
    html += `<div class="group-label">⏰ โอทีรออนุมัติ (${ots.length})</div>` + ots.map(o => {
      const hasScan = o.actual_first_in || o.actual_last_out;
      const scanBox = `<div style="margin-top:6px; padding:6px 9px; border-radius:8px; font-size:12.5px; background:${hasScan ? '#eff6ff' : '#fef3c7'}; color:${hasScan ? '#1e3a8a' : '#92400e'};">
        ${hasScan ? `🕒 สแกนจริง: เข้า <b>${esc(o.actual_first_in || '-')}</b> • ออก <b>${esc(o.actual_last_out || '-')}</b>` : '🕒 ยังไม่มีข้อมูลสแกนนิ้วของวันนี้'}
      </div>`;
      return `<div class="item"><div class="item-ico" style="background:var(--green-soft)">⏰</div><div class="item-body">
        <div class="item-title">${esc(o.name)} • โอที ${esc(o.requested_hours)} ชม.</div>
        <div class="item-meta">📅 ${esc(thaiDate(o.ot_date))} • ${esc(o.requested_start)}–${esc(o.requested_end)}<br>🔧 ${esc(o.job_reference || '-')}</div>
        ${scanBox}
        <div class="item-actions">
          <button class="btn btn-reject btn-sm" onclick="decideItem('OT','${esc(o.request_id)}',false)">ไม่อนุมัติ</button>
          <button class="btn btn-approve btn-sm" onclick="openApproveOtSheet('${esc(o.request_id)}','${esc(o.name)}','${esc(o.ot_date)}','${esc(o.requested_start)}','${esc(o.requested_end)}','${esc(o.actual_first_in || '')}','${esc(o.actual_last_out || '')}')">✓ อนุมัติ / แก้เวลา</button>
        </div>
      </div></div>`;
    }).join('');
  }
  if (unacks.length) {
    html += `<div class="group-label">📋 ลากิจ / ลาป่วย (แจ้งเพื่อทราบ ${unacks.length})</div>` + unacks.map(l => {
      let sickBox = '';
      if (l.leave_type === 'ลาป่วย' && l.sick_info) {
        const si = l.sick_info;
        const seqBanner = l.sub_type === 'SICK_NO_CERT'
          ? (si.noCertSeq <= 1
            ? `<div style="color:#1e40af; font-weight:700;">ℹ️ ลาป่วยไม่มีใบรับรองแพทย์ (ครั้งที่ 1 ของเดือนนี้)</div>`
            : `<div style="color:#b91c1c; font-weight:700;">⚠️ ลาป่วยไม่มีใบรับรองแพทย์ (ครั้งที่ ${si.noCertSeq} ของเดือนนี้ — เกินสิทธิ์ 1 ครั้ง/เดือน)</div>`)
          : `<div style="color:#15803d; font-weight:700;">📎 ลาป่วยมีใบรับรองแพทย์</div>`;
        sickBox = `<div style="margin-top:8px; padding:9px 10px; border-radius:10px; background:#eff6ff; font-size:12.5px; line-height:1.5;">
          ${seqBanner}
          <div>📊 เดือนนี้ป่วยรวม <b>${si.monthTotalCount} ครั้ง</b> (มีใบรับรองฯ ${si.monthWithCertCount} / ไม่มี ${si.monthNoCertCount})</div>
          <div>สิทธิ์ปีนี้คงเหลือ <b>${si.yearRemainingDays}/${si.yearLimit} วัน</b></div>
        </div>`;
      }
      const personalWarnBox = l.personal_warning
        ? `<div style="margin-top:6px; padding:7px 10px; border-radius:8px; background:#fee2e2; color:#991b1b; font-size:12.5px; font-weight:600;">⚠️ ${esc(l.personal_warning)}</div>`
        : '';
      const consecBox = l.consecutive_alert
        ? `<div style="margin-top:6px; padding:7px 10px; border-radius:8px; background:#fee2e2; color:#991b1b; font-size:12.5px; font-weight:600;">🚨 ${esc(l.consecutive_alert)}</div>`
        : '';
      const actionHtml = l.leave_type === 'ลาป่วย'
        ? `<div class="item-actions" style="flex-direction:column;">
            <button class="btn btn-approve btn-sm" style="width:100%;" onclick="decideSickItem('${esc(l.request_id)}',true)">✅ รับทราบการลา และ อนุมัติใช้สิทธิ์ได้</button>
            <button class="btn btn-reject btn-sm" style="width:100%;" onclick="decideSickItem('${esc(l.request_id)}',false)">⚠️ รับทราบการลา และ ไม่อนุมัติการใช้สิทธิ์</button>
          </div>`
        : `<div class="item-actions">
            <button class="btn btn-primary btn-sm" style="width:100%;" onclick="ackItem('${esc(l.request_id)}')">👍 รับทราบ</button>
          </div>`;
      const dText = l.end_date && l.end_date !== l.start_date ? `${thaiDate(l.start_date)} – ${thaiDate(l.end_date)}` : thaiDate(l.start_date);
      return `<div class="item"><div class="item-ico" style="background:var(--brand-soft)">${l.leave_type === 'ลาป่วย' ? '🤒' : l.leave_type === 'ลาอบรม' ? '🎓' : '📋'}</div><div class="item-body">
        <div class="item-title">${esc(l.name)} • ${esc(l.leave_type)} ${esc(leaveDur(l))}</div>
        <div class="item-meta">📅 ${esc(dText)}<br>💬 ${esc(l.reason || '-')}</div>
        ${sickBox}${personalWarnBox}${consecBox}${actionHtml}
      </div></div>`;
    }).join('');
  }
  $('approveList').innerHTML = html;
}

async function decideItem(type, id, approved) {
  let reason = '';
  if (approved) {
    const ok = await sheet({ title: 'ยืนยันการอนุมัติ', body: 'ระบบจะแจ้งผลให้พนักงานทราบทาง LINE ทันทีครับ', confirmText: '✓ อนุมัติ', confirmClass: 'btn-approve' });
    if (!ok) return;
  } else {
    reason = await sheet({ title: 'ไม่อนุมัติรายการนี้', body: 'ระบุเหตุผลสั้นๆ เพื่อแจ้งพนักงาน (ไม่บังคับ)', input: true, confirmText: 'ยืนยันไม่อนุมัติ', confirmClass: 'btn-danger' });
    if (reason === null) return;
  }
  toast('กำลังบันทึก...');
  try {
    const res = await callApi('liff_decide', { target_type: type, target_id: id, approved, reject_reason: reason });
    // อัปเดตรายการบนหน้าจอทันที ไม่ต้องรอโหลดใหม่ทั้งหน้า
    if (type === 'OT') DATA.pending_ots = (DATA.pending_ots || []).filter(o => o.request_id !== id);
    else DATA.pending_vacations = (DATA.pending_vacations || []).filter(l => l.request_id !== id);
    renderApprovals();
    toast(res.message);
    loadData(); // รีเฟรชเบื้องหลัง
  } catch (err) { toast(err.message, true); }
}

async function ackItem(requestId) {
  toast('กำลังบันทึก...');
  try {
    const res = await callApi('liff_acknowledge', { request_id: requestId });
    DATA.unack_leaves = (DATA.unack_leaves || []).filter(l => l.request_id !== requestId);
    renderApprovals();
    toast(res.message);
    loadData();
  } catch (err) { toast(err.message, true); }
}

function openApproveOtSheet(id, name, otDate, reqStart, reqEnd, scanIn, scanOut) {
  const scanInfo = (scanIn || scanOut)
    ? `🕒 สแกนจริง: เข้า <b>${esc(scanIn || '-')}</b> • ออก <b>${esc(scanOut || '-')}</b>`
    : '🕒 ยังไม่มีข้อมูลสแกนนิ้วของวันนี้';
  const root = $('sheetRoot');
  root.innerHTML = `<div class="sheet-bg"><div class="sheet">
    <div class="grab"></div>
    <h3>อนุมัติโอที • ${esc(name)}</h3>
    <p>วันที่ ${esc(thaiDate(otDate))} (ปรับเวลาที่อนุมัติได้ก่อนยืนยัน)</p>
    <div class="summary" style="background:#eff6ff; color:#1e3a8a; margin-bottom:12px;">${scanInfo}</div>
    <div class="row-2">
      <div class="field"><label class="label">เริ่ม OT</label><input id="liffOtStart" type="time" class="input" value="${esc(reqStart)}" /></div>
      <div class="field"><label class="label">สิ้นสุด OT</label><input id="liffOtEnd" type="time" class="input" value="${esc(reqEnd)}" /></div>
    </div>
    <label style="display:flex; gap:8px; align-items:flex-start; font-size:13.5px; margin-bottom:8px; cursor:pointer;">
      <input type="checkbox" id="liffOtOffsite" style="margin-top:3px; width:18px; height:18px;" />
      <span><b>จ่าย OT เต็มตามที่อนุมัติ (ไม่เทียบสแกนนิ้ว)</b><br><span class="hint">สำหรับงานนอกสถานที่ / ขับรถส่งของหลังสแกนออก</span></span>
    </label>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="liffOtCancel">ยกเลิก</button>
      <button class="btn btn-approve" id="liffOtOk">✓ ยืนยันอนุมัติ</button>
    </div>
  </div></div>`;
  $('liffOtCancel').onclick = () => { root.innerHTML = ''; };
  $('liffOtOk').onclick = async () => {
    const btn = $('liffOtOk');
    btn.disabled = true; btn.textContent = 'กำลังบันทึก...';
    try {
      const res = await callApi('liff_decide', {
        target_type: 'OT',
        target_id: id,
        approved: true,
        approved_start: $('liffOtStart').value,
        approved_end: $('liffOtEnd').value,
        skip_scan_cap: $('liffOtOffsite').checked
      });
      root.innerHTML = '';
      DATA.pending_ots = (DATA.pending_ots || []).filter(o => o.request_id !== id);
      renderApprovals();
      toast(res.message);
      loadData();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false; btn.textContent = '✓ ยืนยันอนุมัติ';
    }
  };
}

async function decideSickItem(requestId, allowBenefit) {
  let note = '';
  if (allowBenefit) {
    const ok = await sheet({
      title: 'รับทราบและอนุมัติใช้สิทธิ์ลาป่วย',
      body: 'ระบบจะแจ้งพนักงานทาง LINE ว่าได้รับทราบและอนุมัติใช้สิทธิ์ลาป่วยได้ครับ',
      confirmText: '✅ ยืนยัน',
      confirmClass: 'btn-approve'
    });
    if (!ok) return;
  } else {
    note = await sheet({
      title: 'รับทราบแต่ไม่อนุมัติการใช้สิทธิ์',
      body: 'ระบุหมายเหตุสั้นๆ เพื่อแจ้งพนักงาน (เช่น ใช้สิทธิ์ไม่มีใบรับรองแพทย์ครบเดือนแล้ว)',
      input: true,
      placeholder: 'เช่น เกินสิทธิ์ลาป่วยแบบไม่มีใบรับรองแพทย์',
      confirmText: '⚠️ ยืนยัน',
      confirmClass: 'btn-danger'
    });
    if (note === null) return;
  }
  toast('กำลังบันทึก...');
  try {
    const res = await callApi('liff_decide_sick', { request_id: requestId, allow_benefit: allowBenefit, note: note });
    DATA.unack_leaves = (DATA.unack_leaves || []).filter(l => l.request_id !== requestId);
    renderApprovals();
    toast(res.message);
    loadData();
  } catch (err) { toast(err.message, true); }
}
