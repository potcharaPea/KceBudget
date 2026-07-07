// test_parser.mjs — เทส parser กับไฟล์ ZPSR018 จริง เทียบ Test case A/B
// รัน: node test_parser.mjs
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'fs';
import { parseZpsr018 } from './parser.js';
import assert from 'assert';

const data = new Uint8Array(readFileSync('ตัดอย่าง zpsr018.pdf'));
const doc = await getDocument({ data }).promise;
const items = [];
for (let p = 1; p <= doc.numPages; p++) {
  const tc = await (await doc.getPage(p)).getTextContent();
  for (const it of tc.items) {
    if (it.str.trim() === '') continue;
    items.push({ x: it.transform[4], y: it.transform[5] + p * 100000, s: it.str });
  }
}

const { wbs, networks } = parseZpsr018(items);
assert.strictEqual(wbs, 'I-69-E-KCE69.M4.1104', 'WBS ต้องตรง');
assert.strictEqual(networks.length, 6, 'ต้องอ่านได้ 6 โครงข่าย');

// หา act ของหมวดในโครงข่ายที่ระบุ
const find = (net) => networks.find((n) => n.network === net);
const catBy = (n, name) => n.categories.find((c) => c.name === name);

// --- Case A: 7001189571 (HT-C-E) ทุกหมวดมีงบ ---
const A = find('7001189571');
assert.strictEqual(A.dept, 'HT-C-E');
const expA = [
  ['ค่าพัสดุ', 680960.68, '0010', false],
  ['ค่าพัสดุเข้างาน', 22705.44, '0020', true],
  ['ค่าแรงงาน/ค่าจ้างเหมา', 187549.0, '0030', true],
  ['ค่าควบคุมงาน', 56265.0, '0040', true],
  ['ค่าขนส่ง/ยานพาหนะ', 34394.0, '0050', true],
  ['ค่าเบ็ดเตล็ด', 49094.0, '0060', true],
  ['ค่าดำเนินการ', 50759.0, '0070', true],
];
for (const [name, val, act, open] of expA) {
  const c = catBy(A, name);
  assert.strictEqual(c.value, val, `A ${name} ยอด`);
  assert.strictEqual(c.act, act, `A ${name} เลขกิจกรรม`);
  assert.strictEqual(c.openSlip, open, `A ${name} เปิดใบ`);
}

// --- Case B: 7001189572 (HT-R-E) ค่าพัสดุเข้างาน = 0 (กรณีพิเศษเลื่อนเลข) ---
const B = find('7001189572');
assert.strictEqual(B.dept, 'HT-R-E');
// พัสดุเข้างานต้องถูกข้าม (ไม่อยู่ใน categories)
assert.ok(!catBy(B, 'ค่าพัสดุเข้างาน'), 'B พัสดุเข้างานต้องถูกข้าม');
const expB = [
  ['ค่าพัสดุ', 0, '0010', false],
  ['ค่าแรงงาน/ค่าจ้างเหมา', 45741.0, '0020', true],
  ['ค่าควบคุมงาน', 13722.0, '0030', true],
  ['ค่าขนส่ง/ยานพาหนะ', 4002.0, '0040', true],
  ['ค่าเบ็ดเตล็ด', 16009.0, '0050', true],
  ['ค่าดำเนินการ', 3974.0, '0060', true],
];
for (const [name, val, act, open] of expB) {
  const c = catBy(B, name);
  assert.strictEqual(c.value, val, `B ${name} ยอด`);
  assert.strictEqual(c.act, act, `B ${name} เลขกิจกรรม`);
  assert.strictEqual(c.openSlip, open, `B ${name} เปิดใบ`);
}

console.log('✅ ผ่านทุกเคส — WBS:', wbs, '| โครงข่าย:', networks.map((n) => n.network).join(', '));
