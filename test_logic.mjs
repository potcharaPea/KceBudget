// test_logic.mjs — เทส business logic ใน logic.gs (รัน: node test_logic.mjs)
import { readFileSync } from 'fs';
import assert from 'assert';

// โหลด logic.gs (เป็น plain JS) เข้ามาเป็นโมดูล
const mod = { exports: {} };
new Function('module', readFileSync('logic.gs', 'utf8'))(mod);
const { budgetKey, round2, sumPaid, classifyReimport, validateSlip, validateWbsCap } = mod.exports;

// --- คีย์งบ ---
assert.strictEqual(budgetKey('I-69-E-KCE69.M4.1104', '7001189571', '0020'),
  'I-69-E-KCE69.M4.1104|7001189571|0020');

// --- จ่ายเงินแล้ว (running) ---
const led = [
  { key: 'K1', payNow: 1000 }, { key: 'K1', payNow: 500 }, { key: 'K2', payNow: 200 },
];
assert.strictEqual(sumPaid(led, 'K1'), 1500, 'สะสม K1');
assert.strictEqual(sumPaid(led, 'K2'), 200);
assert.strictEqual(sumPaid(led, 'K9'), 0, 'ไม่มีใบ = 0');

// --- กันเบิกเกิน (4.4) ---
assert.ok(validateSlip(1000, 1000).ok, 'เบิกพอดี = ผ่าน');
assert.ok(validateSlip(1000, 999.99).ok, 'เบิกน้อยกว่า = ผ่าน');
assert.ok(!validateSlip(1000, 1000.01).ok, 'เบิกเกิน 1 สตางค์ = block');
assert.ok(!validateSlip(1000, 0).ok, '0 บาท = block');
assert.ok(!validateSlip(1000, -5).ok, 'ติดลบ = block');
// float: 22705.44 - 705.44 = 22000.00 เบิกได้พอดี
assert.ok(validateSlip(22705.44 - 705.44, 22000).ok, 'float ต้องแม่น');

// --- re-import (4.5) ---
const existing = [
  { key: 'K1', allocation: 187549.00 },  // ยอดต่าง (เบิกไป 50000)
  { key: 'K2', allocation: 22705.44 },   // ยอดเท่าเดิม
  { key: 'K3', allocation: 100000 },     // ยอดใหม่ < เบิกแล้ว → เตือน
];
const incoming = [
  { key: 'K1', allocation: 200000 },
  { key: 'K2', allocation: 22705.44 },
  { key: 'K3', allocation: 30000 },
  { key: 'K4', allocation: 5000 },       // คีย์ใหม่
];
const paidByKey = { K1: 50000, K2: 0, K3: 40000 };
const c = classifyReimport(existing, incoming, paidByKey);
assert.strictEqual(c.toAdd.length, 1); assert.strictEqual(c.toAdd[0].key, 'K4');
assert.strictEqual(c.unchanged.length, 1); assert.strictEqual(c.unchanged[0].key, 'K2');
assert.strictEqual(c.toConfirm.length, 2, 'K1, K3 ต้องยืนยัน');
const k1 = c.toConfirm.find((x) => x.key === 'K1');
assert.deepStrictEqual([k1.oldVal, k1.newVal, k1.negativeRemaining], [187549, 200000, false]);
const k3 = c.toConfirm.find((x) => x.key === 'K3');
assert.strictEqual(k3.negativeRemaining, true, 'K3 ยอดใหม่ 30000 < เบิกแล้ว 40000 → เตือน');

// --- scenario: เบิกหลายรอบจากยอดคงเหลือ (ข้อ 4.3 หัวใจของแอป) ---
const alloc = 22705.44;
const ledgerK = []; // ledger ของคีย์นี้
function cut(amt) {
  const paid = sumPaid(ledgerK, 'X');        // จ่ายเงินแล้ว = สะสมรอบก่อน
  const balance = round2(alloc - paid);      // คงเหลือบน (ปัดสตางค์เหมือน server)
  const v = validateSlip(balance, amt);
  if (v.ok) ledgerK.push({ key: 'X', payNow: amt });
  return { balance, ok: v.ok };
}
let s = cut(10000);
assert.deepStrictEqual([s.balance, s.ok], [22705.44, true], 'รอบ1 คงเหลือ=ยอดจัดสรร');
s = cut(12705.44);
assert.strictEqual(s.balance, 12705.44, 'รอบ2 ตัดจากคงเหลือรอบ1');
assert.ok(s.ok, 'รอบ2 เบิกได้');
s = cut(0.01);
assert.strictEqual(s.balance, 0, 'รอบ3 คงเหลือ 0');
assert.ok(!s.ok, 'รอบ3 เบิกเกิน → block');

// --- เพดานทั้งงาน: ตัดรวมทุกหมวดไม่เกินยอดจัดสรรรวม (219,400.00) ---
assert.ok(validateWbsCap(219400, 0, 219400).ok, 'ตัดพอดีเพดาน = ผ่าน');
assert.ok(validateWbsCap(219400, 200000, 19400).ok, 'ตัดสะสมพอดี 219,400 = ผ่าน');
assert.ok(!validateWbsCap(219400, 200000, 19400.01).ok, 'เกินเพดาน 1 สตางค์ = block');
assert.ok(!validateWbsCap(219400, 219400, 0.01).ok, 'ตัดครบเพดานแล้ว เบิกอีก = block');
assert.ok(validateWbsCap(null, 999999, 999999).ok, 'ยังไม่ตั้งยอด (null) = ไม่บังคับ');
assert.ok(validateWbsCap('', 500, 500).ok, 'ยอดว่าง = ไม่บังคับ');

console.log('✅ logic ผ่านทุกเคส (คงเหลือ / กันเบิกเกิน / re-import / เบิกหลายรอบ / เพดานทั้งงาน)');
