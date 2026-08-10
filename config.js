// config.js — ค่าเริ่มต้นตอน build
// ปกติ "ไม่ต้องแก้ไฟล์นี้": เปิดแอปครั้งแรกจะมีหน้าให้กรอก URL แล้วจำไว้ในเครื่อง (localStorage)
// ใส่ค่าตรงนี้เฉพาะกรณีอยาก build เว็บเป็นของสำนักงานตัวเองแล้วฝัง URL ไปเลย
export const GAS_URL = '';

// รายชื่อสำนักงานที่ติดตั้งแล้ว — โผล่เป็นปุ่มให้กดเลือกในหน้า "เชื่อมต่อฐานข้อมูล"
// สำนักงานใหม่: เพิ่ม 1 บรรทัดตรงนี้แล้ว push (ไม่ต้องแก้ที่อื่น) — ที่ไม่มีในลิสต์ยังกรอก URL เองได้
export const OFFICES = [
  { name: 'กฟส.คำชะอี', url: 'https://script.google.com/macros/s/AKfycbyuzM8mgz5dXa44DLTMfgtX62_GH_egwWf-c65SjEX4QbTP8cFyRoZHKoAouKzwKgUAOw/exec' },
  { name: 'กฟส.กันทรวิชัย', url: 'https://script.google.com/macros/s/AKfycbzhiDPyITLeJ4G_yPEHW_inT37_0D35BoHf1fukQba8ALW032sTf0LrFo5WWXzvdllxdA/exec' },
];
