/**
 * Auth.gs
 * ตรวจสอบสิทธิ์:
 * - Optional Cloudflare Proxy Secret (INTERNAL_PROXY_SECRET — ถ้ายังไม่ใช้ Cloudflare ปล่อยว่างไว้)
 * - LINE ID Token สำหรับ LIFF
 * - Gateway API Secret สำหรับเฟส 2
 * - Admin Secret พร้อม Rate Limit
 */

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= (ca ^ cb);
  }
  return diff === 0 && a.length > 0;
}

/**
 * ถ้าในอนาคตเพิ่ม Cloudflare Worker คั่นหน้า ให้ตั้ง INTERNAL_PROXY_SECRET ใน Script Properties
 * ตอนนี้ปล่อยว่างไว้ ระบบจะอนุญาตให้เชื่อมต่อตรงได้เลย
 */
function verifyOptionalProxySecret(body) {
  const cfg = getAppConfig();
  if (!cfg.INTERNAL_PROXY_SECRET) return true;
  if (!constantTimeEqual(String((body && body.internal_secret) || ''), cfg.INTERNAL_PROXY_SECRET)) {
    throw new Error('ไม่อนุญาตให้เข้าถึงโดยตรง');
  }
  return true;
}

function verifyGatewaySecret(secret) {
  const cfg = getAppConfig();
  if (!cfg.API_SECRET) throw new Error('ยังไม่ได้ตั้งค่า API_SECRET ใน Script Properties');
  if (!constantTimeEqual(String(secret || ''), cfg.API_SECRET)) {
    throw new Error('API Secret ไม่ถูกต้อง');
  }
  return true;
}

function verifyLineIdToken(idToken) {
  if (!idToken) {
    throw new Error('ไม่พบข้อมูลยืนยันตัวตนจาก LINE กรุณาเปิดหน้านี้ผ่าน LINE อีกครั้งครับ');
  }
  const cfg = getAppConfig();
  if (!cfg.LINE_CHANNEL_ID) {
    throw new Error('ระบบยังไม่ได้ตั้งค่า LINE_CHANNEL_ID กรุณาแจ้งผู้ดูแลระบบครับ');
  }

  // แคชผลตรวจ ID Token ไว้ 5 นาที ช่วยให้การกดปุ่มใน LIFF เร็วขึ้นมาก
  const cache = CacheService.getScriptCache();
  const digest = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)).slice(0, 40);
  const cacheKey = 'line_tok_' + digest;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }

  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: cfg.LINE_CHANNEL_ID },
    muteHttpExceptions: true
  });

  const body = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200 || !body.sub) {
    const err = new Error('การยืนยันตัวตน LINE หมดอายุ กรุณาปิดแล้วเปิดหน้านี้ใหม่อีกครั้งครับ');
    err.code = 'TOKEN_EXPIRED';
    throw err;
  }

  const result = { lineUserId: body.sub, name: body.name || '', picture: body.picture || '' };
  try { cache.put(cacheKey, JSON.stringify(result), 300); } catch (_) {}
  return result;
}

function verifyAdminSecret(secret) {
  const cfg = getAppConfig();
  if (!cfg.ADMIN_SECRET) {
    throw new Error('กรุณาตั้งค่า ADMIN_SECRET ใน Script Properties ก่อนใช้งานหน้าผู้ดูแลครับ');
  }

  const cache = CacheService.getScriptCache();
  const failKey = 'admin_fail_count';
  const failCount = parseInt(cache.get(failKey) || '0', 10);
  if (failCount >= 10) {
    throw new Error('ใส่รหัสผ่านผิดหลายครั้งเกินไป กรุณารอประมาณ 10 นาทีแล้วลองใหม่ครับ');
  }

  if (!constantTimeEqual(String(secret || ''), cfg.ADMIN_SECRET)) {
    cache.put(failKey, String(failCount + 1), 600);
    throw new Error('รหัสผ่านผู้ดูแลระบบไม่ถูกต้อง');
  }
  return true;
}
