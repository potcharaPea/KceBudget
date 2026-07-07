// api.js — เรียก GAS web app
// POST body เป็น string และไม่ตั้ง Content-Type → เป็น simple request ไม่มี CORS preflight
import { GAS_URL } from './config.js';

export function hasBackend() {
  return !!GAS_URL;
}

export async function callApi(action, data) {
  if (!GAS_URL) throw new Error('ยังไม่ได้ตั้งค่า GAS_URL ใน config.js');
  const res = await fetch(GAS_URL, {
    method: 'POST',
    body: JSON.stringify({ action, data: data || {} }),
    redirect: 'follow',
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์');
  return j.result;
}
