// test_alloc.mjs — เทส extractAllocationTotal กับไฟล์จริง (ข้อ 1)
// รัน: node test_alloc.mjs
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'fs';
import { parseZpsr018 } from './parser.js';
import assert from 'assert';

async function total(file) {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(file)) }).promise;
  const items = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    for (const it of tc.items) {
      if (it.str.trim() === '') continue;
      items.push({ x: it.transform[4], y: it.transform[5] + p * 100000, s: it.str });
    }
  }
  return parseZpsr018(items).wbsTotal;
}

// ไฟล์ 2 มีบรรทัด "ได้รับจัดสรรงบประมาณจำนวณ 219,400.00 บาท" (219,400.00 − 29.11 = 219,370.89)
assert.strictEqual(await total('ตัวอย่าง zpsr018 2.pdf'), 219400.0, 'ไฟล์ 2 ต้องดึงยอดจัดสรร 219,400.00');
// ไฟล์ 1 เป็นหน้ารายการพัสดุ ไม่มีบรรทัดยอดจัดสรร → null (ตกไปกรอกมือ)
assert.strictEqual(await total('ตัวอย่าง zpsr018 1.pdf'), null, 'ไฟล์ 1 ไม่มีบรรทัดยอดจัดสรร → null');

console.log('✅ ยอดจัดสรรรวม: ไฟล์2=219,400.00 | ไฟล์1=null');
