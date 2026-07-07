// logic.gs — business logic ล้วน ไม่เรียก GAS API → เทสใน Node ได้ (test_logic.mjs)
// GAS รวมทุกไฟล์ .gs เป็น global scope เดียว ฟังก์ชันเหล่านี้จึงถูกเรียกจาก Code.gs ได้

// คีย์ก้อนงบ (ข้อ 4.2) = WBS | หมายเลขโครงข่าย | เลขกิจกรรม
function budgetKey(wbs, network, act) {
  return [wbs, network, act].join('|');
}

// เทียบเงินแบบสตางค์ (เลี่ยง float error)
function cents(x) {
  return Math.round(Number(x) * 100);
}

// ปัดเงินเป็น 2 ตำแหน่ง (กัน float drift สะสมเวลาลบยอดหลายรอบ)
function round2(x) {
  return Math.round(Number(x) * 100) / 100;
}

// จ่ายเงินแล้ว = ผลรวม "จ่ายครั้งนี้" ของทุกใบก่อนหน้าในคีย์งบนี้ (ข้อ 4.3)
function sumPaid(ledger, key) {
  return round2(ledger
    .filter(function (r) { return r.key === key; })
    .reduce(function (s, r) { return s + Number(r.payNow || 0); }, 0));
}

// จัดประเภทตอน re-import (ข้อ 4.5)
// existing/incoming: [{key, allocation, ...}], paidByKey: {key: จ่ายเงินแล้ว}
// คืน { toAdd:[], unchanged:[], toConfirm:[{key, oldVal, newVal, paid, negativeRemaining}] }
function classifyReimport(existing, incoming, paidByKey) {
  var exMap = {};
  existing.forEach(function (b) { exMap[b.key] = Number(b.allocation); });
  var toAdd = [], unchanged = [], toConfirm = [];
  incoming.forEach(function (inc) {
    var newVal = Number(inc.allocation);
    if (!(inc.key in exMap)) { toAdd.push(inc); return; }         // คีย์ใหม่
    var oldVal = exMap[inc.key];
    if (cents(oldVal) === cents(newVal)) { unchanged.push(inc); return; } // ยอดเท่าเดิม → ข้าม
    var paid = Number(paidByKey[inc.key] || 0);
    toConfirm.push({                                              // ยอดต่าง → ให้ยืนยัน
      key: inc.key, oldVal: oldVal, newVal: newVal, paid: paid,
      negativeRemaining: cents(newVal) < cents(paid),             // ยอดใหม่ < ที่เบิกแล้ว → เตือน
    });
  });
  return { toAdd: toAdd, unchanged: unchanged, toConfirm: toConfirm };
}

// กันเบิกเกิน (ข้อ 4.4) — ต้องเรียกฝั่ง server เสมอ
function validateSlip(balance, payNow) {
  var amt = Number(payNow);
  if (!(amt > 0)) return { ok: false, reason: 'จำนวนเงินต้องมากกว่า 0' };
  if (cents(amt) > cents(balance)) {
    return { ok: false, reason: 'เบิกเกินยอดคงเหลือ (คงเหลือ ' + Number(balance).toFixed(2) + ')' };
  }
  return { ok: true };
}

// export สำหรับเทสใน Node เท่านั้น (GAS ไม่มี module → เงื่อนไขนี้ข้ามไป)
if (typeof module !== 'undefined') {
  module.exports = { budgetKey: budgetKey, cents: cents, round2: round2, sumPaid: sumPaid, classifyReimport: classifyReimport, validateSlip: validateSlip };
}
