// ย้ายข้อมูลจาก Google Sheet (GAS เดิม) → Supabase — ใช้ตอน cutover
// 1) ดาวน์โหลดชีต: https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=xlsx (ชีตต้องแชร์ลิงก์)
// 2) npm i --no-save xlsx@0.18.5
// 3) node supabase/migrate_from_sheet.cjs kce.xlsx kce <GAS /exec URL>          ← dry run เทียบยอดกับ GAS
//    node supabase/migrate_from_sheet.cjs kce.xlsx kce <GAS /exec URL> --write  ← เขียนจริง (รันซ้ำได้)
const X = require('xlsx');
const [file, office, gas] = process.argv.slice(2);
const WRITE = process.argv.includes('--write');
const SB = 'https://ufosqepftnixsshsdajg.supabase.co/rest/v1';
const KEY = 'sb_publishable_qMa5JuIFY-vqPA-Ss54a8w_wLnZWPTJ';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

const wb = X.readFile(file);
const tab = (n) => X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }).slice(1);
// serial ของ Sheets = เวลาผนังตามโซนของชีต (Asia/Bangkok) นับวันจาก 1899-12-30
const wall = (s) => new Date(Date.UTC(1899, 11, 30) + Math.round(s * 864e5));
const toTs = (s) => (typeof s === 'number' ? new Date(wall(s).getTime() - 7 * 36e5).toISOString() : s || null);
const toDate = (s) => (typeof s === 'number' ? wall(s).toISOString().slice(0, 10) : s ? String(s).slice(0, 10) : null);
const str = (v) => (v === null || v === undefined ? '' : String(v));

const budgets = tab('งบ').map((r) => ({
  office, key: str(r[0]), wbs: str(r[1]), network: str(r[2]), dept: str(r[3]), category: str(r[4]),
  act: str(r[0]).split('|')[2], allocation: Number(r[6]), imported: toTs(r[7]), file_name: str(r[8]),
  work_name: str(r[9]), wbs_total: r[10] === '' ? null : Number(r[10]), file_code: str(r[11]), oper: str(r[12]),
}));
const ledger = tab('บันทึกการตัด').map((r) => ({
  office, slip_no: Number(r[0]), key: str(r[1]), slip_date: toDate(r[2]), pay_now: Number(r[3]),
  balance_after: Number(r[4]), work_name: str(r[5]), requester: str(r[6]), position: str(r[7]),
  driver: str(r[8]), contract: str(r[9]), ref: str(r[10]), user_email: str(r[11]),
  ts: toTs(r[12]) || new Date().toISOString(), client_id: str(r[13]) || null,
  con_date: toDate(r[14]), extra: r[15] ? JSON.parse(r[15]) : {},
}));
const revisions = tab('ประวัติแก้งบ').map((r) => ({
  office, key: str(r[0]), old_val: str(r[1]), new_val: str(r[2]), at: toTs(r[3]), note: str(r[4]), by_user: str(r[5]),
}));
const settings = [...new Map(tab('ตั้งค่า')
  .filter((r) => r[0] && r[1] !== '' && r[1] !== '(ใส่ชื่อ พขร. ที่นี่)')
  .map((r) => [r[0] + '|' + r[1], { office, type: str(r[0]), value: str(r[1]) }])).values()];

(async () => {
  console.log(`อ่านชีต: งบ ${budgets.length} · ใบตัด ${ledger.length} · ประวัติ ${revisions.length} · ตั้งค่า ${settings.length}`);

  // เทียบกับ GAS: ยอดจ่าย/คงเหลือทุกก้อน + รหัสแฟ้ม + wbsTotal ต้องตรง
  const res = await fetch(gas, { method: 'POST', body: JSON.stringify({ action: 'getAll', data: {} }) });
  const g = (await res.json()).result;
  const paid = {};
  ledger.forEach((l) => (paid[l.key] = Math.round(((paid[l.key] || 0) + l.pay_now) * 100) / 100));
  const mine = Object.fromEntries(budgets.map((b) => [b.key, b]));
  const bad = [];
  if (g.budgets.length !== budgets.length) bad.push(`จำนวนก้อน GAS ${g.budgets.length} ≠ ชีต ${budgets.length}`);
  for (const gb of g.budgets) {
    const b = mine[gb.key];
    if (!b) { bad.push('ไม่มีในชีต: ' + gb.key); continue; }
    const p = paid[gb.key] || 0;
    if (Math.round(p * 100) !== Math.round(gb.paid * 100)) bad.push(`paid ${gb.key} ${p} ≠ ${gb.paid}`);
    if (Math.round((b.allocation - p) * 100) !== Math.round(gb.balance * 100)) bad.push(`balance ${gb.key}`);
    if (b.file_code !== gb.fileCode) bad.push(`fileCode ${gb.key} ${b.file_code} ≠ ${gb.fileCode}`);
    if ((b.wbs_total ?? null) !== (gb.wbsTotal ?? null)) bad.push(`wbsTotal ${gb.key} ${b.wbs_total} ≠ ${gb.wbsTotal}`);
    if (b.work_name !== gb.workName || b.oper !== gb.oper) bad.push(`ชื่องาน/ผู้ดำเนินการ ${gb.key}`);
  }
  // วันที่ใบตัด: เทียบกับ getSlips (dd/mm/yyyy) ตัวอย่าง 3 คีย์
  for (const k of [...new Set(ledger.map((l) => l.key))].slice(0, 3)) {
    const r2 = await fetch(gas, { method: 'POST', body: JSON.stringify({ action: 'getSlips', data: { key: k } }) });
    const s = (await r2.json()).result || [];
    s.forEach((x) => console.log(`  วันที่ใบ #${x.slipNo}: GAS "${x.date}" · แปลงได้ ${ledger.find((l) => l.slip_no == x.slipNo).slip_date}`));
  }
  const totPaid = ledger.reduce((s, l) => s + l.pay_now, 0);
  console.log(`ยอดตัดรวม ${totPaid.toLocaleString('th', { minimumFractionDigits: 2 })} บาท · GAS office=${g.office} prefix=${g.filePrefix}`);
  if (bad.length) { console.log('❌ ไม่ตรง', bad.length, 'จุด\n' + bad.slice(0, 20).join('\n')); process.exit(1); }
  console.log('✅ ตรงกับ GAS ทุกก้อน (' + g.budgets.length + ')');
  if (!WRITE) return console.log('(dry run — ใส่ --write เพื่อเขียนลง Supabase)');

  const post = async (t, rows) => {
    for (let i = 0; i < rows.length; i += 500) {
      const r = await fetch(`${SB}/${t}`, { method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify(rows.slice(i, i + 500)) });
      if (!r.ok) throw new Error(t + ': ' + (await r.text()));
    }
    console.log(`  เขียน ${t} ${rows.length}`);
  };
  await post('budgets', budgets);
  await post('ledger', ledger);
  await post('settings', settings);
  // ประวัติไม่มีคีย์ธรรมชาติ → ลบของสำนักงานนี้ก่อนแล้วใส่ใหม่ (รันซ้ำได้ไม่ซ้ำ)
  await fetch(`${SB}/revisions?office=eq.${office}`, { method: 'DELETE', headers: H });
  await post('revisions', revisions);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
