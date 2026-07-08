// api.js — เรียก GAS web app
// POST body เป็น string และไม่ตั้ง Content-Type → เป็น simple request ไม่มี CORS preflight
import { GAS_URL } from './config.js';

export function hasBackend() {
  return !!GAS_URL;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GAS ตอบผ่าน 302 redirect ซึ่งบางครั้งคืนหน้า HTML แทน JSON (flakiness ฝั่ง Google)
// → retry เมื่อเจอ HTML/เน็ตสะดุด; error ปกติจาก server (เช่น เบิกเกิน) ไม่ retry
// write ทุกตัว idempotent ฝั่ง server (createSlip ใช้ clientId, import เทียบ key) → retry ปลอดภัย
export async function callApi(action, data) {
  if (!GAS_URL) throw new Error('ยังไม่ได้ตั้งค่า GAS_URL ใน config.js');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(GAS_URL, {
        method: 'POST',
        body: JSON.stringify({ action, data: data || {} }),
        redirect: 'follow',
      });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { throw new Error('__HTML__'); } // ได้ HTML แทน JSON
      if (!j.ok) throw new Error(j.error || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
      return j.result;
    } catch (err) {
      lastErr = err;
      // retry เฉพาะ HTML response หรือ network error (TypeError จาก fetch); อื่นๆ โยนทันที
      if (err.message === '__HTML__' || err.name === 'TypeError') { await sleep(400 * (attempt + 1)); continue; }
      throw err;
    }
  }
  throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ (ลองใหม่แล้วยังไม่ได้) — กรุณาโหลดหน้าใหม่แล้วตรวจสอบก่อนทำซ้ำ');
}
