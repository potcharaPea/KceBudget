// check_api.mjs — ตรวจ api.js ทุก action กับ Supabase จริง:  node supabase/check_api.mjs
// ใช้สำนักงานทดสอบ (ตัวย่อ ZZT) แล้วลบทิ้งท้ายสุด ไม่แตะข้อมูลจริง
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = String(v)) };
const { callApi, addOffice, setOffice, listOffices } = await import('../api.js');
const { SUPABASE_URL, SUPABASE_KEY } = await import('../config.js');
const H = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
const del = (t, f) => fetch(`${SUPABASE_URL}/rest/v1/${t}?${f}`, { method: 'DELETE', headers: H });
let ZID = null;
const zid = () => ZID || "none";
async function cleanup() {
  // หา id ของสำนักงานทดสอบที่ค้างจากรอบก่อน (ตัวย่อ ZZT/ZZQ)
  const r = await fetch(`${SUPABASE_URL}/rest/v1/offices?select=id&file_prefix=in.(ZZT,ZZQ)`, { headers: H });
  for (const x of await r.json()) { ZID = x.id; await wipe(); }
  ZID = null;
}
async function wipe() {
  for (const t of ['budgets', 'settings', 'revisions']) await del(t, 'office=in.(' + zid() + ')');
  await del('offices', 'id=in.(' + zid() + ')');
}

let n = 0; const ok = (c, m) => { if (!c) throw new Error('FAIL ' + m); n++; console.log('✅', m); };
const fails = async (p, want, m) => { try { await p; } catch (e) { ok(e.message.includes(want), m + ' — ' + e.message); return; } throw new Error('FAIL ควรล้ม: ' + m); };

const W = 'C-68-E-TEST.0001.02.2', mk = (net, act, a) => ({ key: [W, net, act].join('|'), wbs: W, network: net, dept: 'D', category: 'หมวด' + act, act, allocation: a });
await cleanup();
try {
  const o = await addOffice('ทดสอบระบบ', 'zzt');
  ZID = o.id;
  ok(o.id.length === 36 && o.file_prefix === 'ZZT', 'เพิ่มสำนักงานใหม่ (ตัวย่อแปลงเป็นตัวใหญ่)');
  await fails(addOffice('ซ้ำ', 'KCE'), 'มีสำนักงานอื่นใช้แล้ว', 'ตัวย่อซ้ำโดนบล็อก');
  ok((await listOffices()).some((x) => x.id === 'kce'), 'listOffices เห็นคำชะอี');
  setOffice(o.id);

  const imp = await callApi('importBudget', { fileName: 'a.pdf', workName: 'งานทดสอบ', oper: 'กฟภ.', wbsTotal: 150,
    budgets: [mk('6001', '0020', 100), mk('6001', '0030', 100)], confirmKeys: [] });
  ok(imp.added.length === 2 && imp.unchanged === 0, 'import 2 ก้อน');
  let all = await callApi('getAll');
  ok(all.office === 'ทดสอบระบบ' && all.filePrefix === 'ZZT', 'getAll ชื่อ+prefix สำนักงาน');
  const b0 = all.budgets[0];
  ok(b0.fileCode === 'ZZT01' && b0.wbsTotal === 150 && b0.oper === 'กฟภ.' && b0.base === 'C-68-E-TEST.0001' && b0.node === '02.2',
    'รหัสแฟ้ม ZZT01 + wbsTotal + oper + base/node');

  const re = await callApi('importBudget', { fileName: 'b.pdf', budgets: [mk('6001', '0020', 120), mk('6001', '0030', 100)], confirmKeys: [] });
  ok(re.unchanged === 1 && re.needConfirm.length === 1 && re.needConfirm[0].newVal === 120, 're-import ยอดต่าง → ถามยืนยัน');
  const re2 = await callApi('importBudget', { fileName: 'b.pdf', budgets: [mk('6001', '0020', 120)], confirmKeys: [mk('6001', '0020').key] });
  ok(re2.updated.length === 1, 'ยืนยันแล้วอัปเดตยอด');

  const K1 = mk('6001', '0020').key;
  const s1 = await callApi('createSlip', { key: K1, payNow: 50.5, clientId: 'zzt-1', slipDate: '2026-09-24', extra: JSON.stringify({ chk: { VEH: true } }) });
  ok(s1.slipNo === 1 && s1.paid === 50.5 && s1.balance === 69.5, 'createSlip คืน paid/balance เป็นตัวเลข');
  const dup = await callApi('createSlip', { key: K1, payNow: 50.5, clientId: 'zzt-1' });
  ok(dup.duplicate && dup.paid === null, 'createSlip ซ้ำ clientId → paid null (app โหลดใหม่)');
  await fails(callApi('createSlip', { key: mk('6001', '0030').key, payNow: 100 }), 'ตัดได้อีก 99.50', 'เพดานทั้งงานผ่าน api.js');
  await callApi('createSlip', { key: mk('6001', '0030').key, payNow: 10 });
  const sl = await callApi('getSlips', { key: mk('6001', '0030').key });
  ok(sl.length === 1 && sl[0].period === 2, 'getSlips งวดระดับแฟ้ม = 2');
  const sl1 = await callApi('getSlips', { key: K1 });
  ok(sl1[0].period === 1 && sl1[0].date === '24/9/2569', 'getSlips งวด 1 วันที่ไทยจาก slipDate');

  ok((await callApi('addDriver', { name: 'นายทดสอบ' })).includes('นายทดสอบ'), 'addDriver');
  ok((await callApi('addDriver', { name: 'นายทดสอบ' })).length === 1, 'addDriver ซ้ำไม่เพิ่ม');
  await callApi('setWbsTotal', { wbs: W, total: 500 });
  await callApi('setOper', { wbs: W, oper: 'บ.ทดสอบ' });
  all = await callApi('getAll');
  ok(all.budgets.every((b) => b.wbsTotal === 500 && b.oper === 'บ.ทดสอบ'), 'setWbsTotal + setOper ทุกแถวของ WBS');
  ok(all.settings['พขร.'][0] === 'นายทดสอบ', 'settings จัดกลุ่มตามประเภท');

  const W2 = 'C-68-E-TEST.0002.02.2';
  ok((await callApi('editWbs', { oldWbs: W, newWbs: W2 })).changed === 2, 'editWbs 2 ก้อน');
  ok((await callApi('getSlips', { key: [W2, '6001', '0020'].join('|') })).length === 1, 'ใบตัดตามคีย์ใหม่หลังแก้ WBS');
  ok((await callApi('editNetwork', { wbs: W2, oldNet: '6001', newNet: '6009' })).changed === 2, 'editNetwork');
  all = await callApi('getAll');
  ok(all.budgets.every((b) => b.network === '6009' && b.key.startsWith(W2 + '|6009|')) && all.budgets.find((b) => b.act === '0020').paid === 50.5, 'คีย์ใหม่ + ยอดจ่ายยังอยู่');

  const pf = await callApi('setFilePrefix', { prefix: 'zzq' });
  ok(pf.prefix === 'ZZQ' && pf.changed === 2, 'setFilePrefix เขียนรหัสแฟ้มใหม่');
  ok((await callApi('getAll')).budgets[0].fileCode === 'ZZQ01', 'รหัสแฟ้มเป็น ZZQ01');
  await callApi('setFilePrefix', { prefix: 'ZZT' });

  ok((await callApi('deleteSlip', { slipNo: 1 })).deleted === 1, 'deleteSlip');
  ok((await callApi('getAll')).budgets.find((b) => b.act === '0020').paid === 0, 'ลบใบแล้วยอดคืน');
  await callApi('importBudget', { fileName: 'c.pdf', budgets: [{ ...mk('7001', '0020', 5), wbs: W2, key: [W2, '7001', '0020'].join('|') }], confirmKeys: [] });
  ok((await callApi('deleteNetwork', { wbs: W2, network: '7001' })).budgets === 1, 'deleteNetwork เฉพาะโครงข่ายนั้น');
  ok((await callApi('deleteFileAll', { base: 'C-68-E-TEST.0002' })).budgets === 2, 'deleteFileAll ตาม base');
  ok((await callApi('getAll')).budgets.length === 0, 'แฟ้มว่าง');
} finally {
  if (ZID) await wipe();
  await cleanup();
}
console.log(`\nผ่าน ${n} ข้อ`);
