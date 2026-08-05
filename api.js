// api.js — เรียก GAS web app
// POST body เป็น string และไม่ตั้ง Content-Type → เป็น simple request ไม่มี CORS preflight
import { GAS_URL } from './config.js';

// URL เก็บในเครื่อง (ตั้งครั้งเดียวตอนเปิดแอปครั้งแรก) — หน้าเว็บตัวเดียวใช้ได้ทุกสำนักงาน
// config.js เป็นแค่ค่าเริ่มต้นเผื่อ build ฝัง URL มาให้แล้ว
const LS_KEY = 'peabudget_gas_url';
export const getGasUrl = () => localStorage.getItem(LS_KEY) || GAS_URL;
export const setGasUrl = (u) => localStorage.setItem(LS_KEY, String(u).trim());

export function hasBackend() {
  return !!getGasUrl();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GAS ตอบผ่าน 302 redirect ซึ่งบางครั้งคืนหน้า HTML แทน JSON (flakiness ฝั่ง Google)
// → retry เมื่อเจอ HTML/เน็ตสะดุด; error ปกติจาก server (เช่น เบิกเกิน) ไม่ retry
// write ทุกตัว idempotent ฝั่ง server (createSlip ใช้ clientId, import เทียบ key) → retry ปลอดภัย
export async function callApi(action, data) {
  const url = getGasUrl();
  if (!url) throw new Error('ยังไม่ได้ตั้งค่าที่อยู่เซิร์ฟเวอร์ (GAS URL)');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ action, data: data || {} }),
        redirect: 'follow',
      });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { throw new Error('__HTML__'); } // ได้ HTML แทน JSON
      if (!j.ok) throw new Error(j.error || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
      // GAS บางครั้งตีกลับ redirect ของ POST เป็น GET → ได้ผลลัพธ์ doGet ({ok:true} ไม่มี result) → retry
      if (!('result' in j)) throw new Error('__HTML__');
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
