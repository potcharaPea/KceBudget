// parser.js — ดึงข้อมูลงบจากไฟล์ ZPSR018
// ใช้ได้ทั้งใน browser (pdf.js) และ Node (เทส) — รับ text item แบบ {x, y, s}
// ยึดตำแหน่งคอลัมน์ (ลำดับ x ซ้าย→ขวา) ไม่อ่านหัวคอลัมน์ไทย (ฟอนต์เพี้ยน)

// 7 หมวดเรียงตามลำดับคงที่ (คอลัมน์ 1–7 ของตารางส่วนที่ 2)
export const CATEGORIES = [
  'ค่าพัสดุ',
  'ค่าพัสดุเข้างาน',
  'ค่าแรงงาน/ค่าจ้างเหมา',
  'ค่าควบคุมงาน',
  'ค่าขนส่ง/ยานพาหนะ',
  'ค่าเบ็ดเตล็ด',
  'ค่าดำเนินการ',
];

const NUM_RE = /^-?[\d,]+\.\d{2}$/;      // ตัวเลขเงิน เช่น 22,705.44 / 0.00
const NET_RE = /^\d{10}$/;               // หมายเลขโครงข่าย 10 หลัก เช่น 7001189571
const DEPT_RE = /^[A-Z]{2}-[A-Z]-[A-Z]$/; // รหัสแผนก เช่น HT-C-E
const WBS_RE = /^I-\d{2}-[A-Z]-[A-Z0-9.]+$/; // WBS เช่น I-69-E-KCE69.M4.1104

const toNum = (s) => parseFloat(s.replace(/,/g, ''));

// จัดกลุ่ม text item เป็นแถวตามค่า y แล้วเรียงในแถวตาม x
function groupByRow(items) {
  const rows = new Map();
  for (const it of items) {
    const key = Math.round(it.y);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(it);
  }
  return [...rows.values()].map((r) => r.sort((a, b) => a.x - b.x));
}

// คำนวณเลขกิจกรรมของ 7 หมวด (Business Logic ข้อ 4.1)
// เฉพาะ "ค่าพัสดุเข้างาน" (index 1) เท่านั้น ที่ถ้ายอด = 0 จะถูกข้ามและเลื่อนเลข
// หมวดอื่นถึงยอด = 0 ก็คงเลขเดิม (แค่ไม่เปิดใบ)
export function computeActivities(values) {
  const present = [];
  CATEGORIES.forEach((name, i) => {
    if (i === 1 && values[i] === 0) return; // ข้ามเฉพาะพัสดุเข้างานที่ยอด 0
    present.push({ name, value: values[i], catIndex: i });
  });
  present.forEach((c, idx) => {
    c.act = String((idx + 1) * 10).padStart(4, '0'); // 0010, 0020, ...
    // เปิดใบตัดงบได้เฉพาะหมวด 2–7 (ไม่ใช่ค่าพัสดุ) ที่มียอด > 0
    c.openSlip = c.catIndex !== 0 && c.value > 0;
  });
  return present;
}

// ยอดจัดสรรรวมทั้ง WBS — บรรทัดสรุป "ได้รับจัดสรรงบประมาณจำนวณ X บาท"
// ฟอนต์ไทยเพี้ยนจับคำไม่ได้ → ใช้ลายเซ็นเลข: บรรทัดเดียวที่ จัดสรร − เบิกแล้ว = คงเหลือ (n0-n1=n2)
// อยู่กลางหน้าไม่ใช่ท้ายหน้า → ยึดตำแหน่งไม่ได้ ต้องยึดความสัมพันธ์เลข คืน null ถ้าหน้าไม่มีบรรทัดนี้
// ponytail: heuristic อาจ false-match; การกรอกมือในแอปคือทางหลัก (fallback) ถ้าเลขเพี้ยน
export function extractAllocationTotal(items) {
  for (const row of groupByRow(items)) {
    const nums = row.filter((it) => NUM_RE.test(it.s)).map((it) => toNum(it.s));
    if (nums.length < 3 || nums[0] <= 0) continue;
    if (Math.abs(nums[0] - nums[1] - nums[2]) < 0.005) return nums[0];
  }
  return null;
}

// parse ทั้งเอกสาร → { wbs, networks:[{network, dept, allocation[7], categories[]}], wbsTotal }
export function parseZpsr018(items) {
  let wbs = null;
  const networks = [];
  for (const row of groupByRow(items)) {
    if (!wbs) {
      const w = row.find((it) => WBS_RE.test(it.s));
      if (w) wbs = w.s;
    }
    const net = row.find((it) => NET_RE.test(it.s));
    if (!net) continue; // มีเฉพาะบรรทัด "งบจัดสรร" เท่านั้นที่มีหมายเลขโครงข่าย
    const dept = row.find((it) => DEPT_RE.test(it.s));
    const nums = row.filter((it) => NUM_RE.test(it.s)).map((it) => toNum(it.s));
    if (nums.length < 7) continue;
    const allocation = nums.slice(0, 7); // 7 หมวดแรก (คอลัมน์ 1–7)
    networks.push({
      network: net.s,
      dept: dept ? dept.s : '',
      allocation,
      categories: computeActivities(allocation),
    });
  }
  return { wbs, networks, wbsTotal: extractAllocationTotal(items) };
}
