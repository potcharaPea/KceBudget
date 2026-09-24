// check_schema.mjs — ตรวจ schema.sql หลังรันใน SQL Editor:  node supabase/check_schema.mjs
// ใช้สำนักงานทดสอบ 'zz' แล้วลบทิ้งท้ายสุด ไม่แตะข้อมูลจริง
const URL = 'https://ufosqepftnixsshsdajg.supabase.co/rest/v1';
const KEY = 'sb_publishable_qMa5JuIFY-vqPA-Ss54a8w_wLnZWPTJ';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };

async function req(method, path, body) {
  const r = await fetch(URL + path, { method, headers: H, body: body && JSON.stringify(body) });
  const t = await r.text();
  const j = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(j?.message || t);
  return j;
}
const slip = (p) => req('POST', '/rpc/create_slip', { p: { office: 'zz', ...p } });
async function fails(p, want) {
  try { await slip(p); } catch (e) { if (e.message.includes(want)) return; throw new Error('ข้อความผิด: ' + e.message); }
  throw new Error('ควรถูกบล็อก: ' + want);
}
let n = 0; const ok = (c, m) => { if (!c) throw new Error('FAIL ' + m); n++; console.log('✅', m); };

const K1 = 'W-1|600|0010', K2 = 'W-1|600|0020';
try {
  await req('DELETE', '/offices?id=eq.zz').catch(() => {}); // เผื่อรอบก่อนค้าง
  await req('POST', '/offices', { id: 'zz', name: 'ทดสอบ', file_prefix: 'ZZ' });
  await req('POST', '/budgets', [
    { office: 'zz', key: K1, wbs: 'W-1', network: '600', act: '0010', allocation: 100, wbs_total: 150 },
    { office: 'zz', key: K2, wbs: 'W-1', network: '600', act: '0020', allocation: 100, wbs_total: 150 },
  ]);

  const a = await slip({ key: K1, payNow: 60.1, clientId: 'c1' });
  ok(a.slipNo === 1 && Number(a.balance) === 39.9, 'ตัดใบแรก เลข 1 คงเหลือ 39.90 (ไม่มี float drift)');
  const d = await slip({ key: K1, payNow: 60.1, clientId: 'c1' });
  ok(d.duplicate === true && d.slipNo === 1, 'clientId ซ้ำ → คืนใบเดิม ไม่ตัดเบิล');
  await fails({ key: K1, payNow: 39.91 }, 'เบิกเกินยอดคงเหลือ (คงเหลือ 39.90)');
  ok(true, 'เบิกเกินรายหมวดโดนบล็อก');
  await fails({ key: K2, payNow: 90 }, 'ตัดได้อีก 89.90 บาท');
  ok(true, 'เพดานทั้งงาน wbs_total โดนบล็อก');
  await fails({ key: K1, payNow: 0 }, 'มากกว่า 0');
  ok(true, 'ยอด 0 โดนบล็อก');
  const b = await slip({ key: K2, payNow: 89.9, extra: { chk: { VEH: true } } });
  ok(b.slipNo === 2, 'ใบที่สองได้เลข 2');

  const v = await req('GET', '/budgets_v?office=eq.zz&key=eq.' + encodeURIComponent(K1));
  ok(Number(v[0].paid) === 60.1 && Number(v[0].balance) === 39.9, 'budgets_v คำนวณจ่าย/คงเหลือถูก');

  await req('PATCH', '/budgets?office=eq.zz&key=eq.' + encodeURIComponent(K1), { key: 'W-2|600|0010', wbs: 'W-2' });
  const l = await req('GET', '/ledger?office=eq.zz&slip_no=eq.1');
  ok(l[0].key === 'W-2|600|0010', 'แก้คีย์งบ → คีย์ใบตัดตามเอง (cascade)');

  await req('DELETE', '/budgets?office=eq.zz');
  ok((await req('GET', '/ledger?office=eq.zz')).length === 0, 'ลบงบ → ใบตัดหายตาม');
} finally {
  await req('DELETE', '/ledger?office=eq.zz').catch(() => {});
  await req('DELETE', '/budgets?office=eq.zz').catch(() => {});
  await req('DELETE', '/offices?id=eq.zz').catch(() => {});
}
console.log(`\nผ่าน ${n} ข้อ`);
