// api.js — คุยกับ Supabase (แทน GAS) — คง callApi(action, data) + รูปแบบผลลัพธ์เดิม → app.js แทบไม่ต้องแก้
// ใช้ REST ตรงด้วย fetch ไม่พึ่ง supabase-js · ตาราง/ฟังก์ชันดู supabase/schema.sql
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const REST = SUPABASE_URL + '/rest/v1';
const H = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };

// สำนักงานที่เลือกไว้ จำในเครื่อง (เลือกครั้งเดียว) — ทุกคำขอกรองด้วย office นี้เสมอ
const LS_KEY = 'peabudget_office';
export const getOffice = () => localStorage.getItem(LS_KEY) || '';
export const setOffice = (id) => localStorage.setItem(LS_KEY, id);
export const hasBackend = () => !!getOffice();

async function sb(method, path, body, prefer) {
  const res = await fetch(REST + path, {
    method, headers: prefer ? { ...H, Prefer: prefer } : H, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const j = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(thaiErr(j?.message || text));
  return j;
}
function thaiErr(m) {
  if (/offices_prefix_unique/.test(m)) return 'ตัวย่อรหัสแฟ้มนี้มีสำนักงานอื่นใช้แล้ว';
  if (/offices_prefix_format/.test(m)) return 'ตัวย่อต้องเป็น A-Z หรือ 0-9 ยาว 2-5 ตัว';
  if (/offices_name_nonempty/.test(m)) return 'ยังไม่ได้ใส่ชื่อสำนักงาน';
  return m;
}
// PostgREST คืนทีละไม่เกิน 1000 แถว → ไล่หน้าจนหมด
async function all(path) {
  let out = [];
  for (let off = 0; ; off += 1000) {
    const rows = await sb('GET', `${path}&limit=1000&offset=${off}`);
    out = out.concat(rows);
    if (rows.length < 1000) return out;
  }
}
const eq = (v) => 'eq.' + encodeURIComponent(v);
const inList = (arr) => 'in.(' + arr.map((v) => encodeURIComponent('"' + String(v).replace(/"/g, '\\"') + '"')).join(',') + ')';
const O = () => 'office=' + eq(getOffice());

// ---------- สำนักงาน ----------
export const listOffices = () => sb('GET', '/offices?select=*&order=name');
export async function addOffice(name, prefix) {
  name = String(name || '').trim(); prefix = String(prefix || '').trim().toUpperCase();
  // id สุ่ม ไม่ผูกกับตัวย่อ — ตัวย่อเปลี่ยนได้/ปล่อยให้คนอื่นใช้ต่อได้ โดย id ไม่ชน
  const [o] = await sb('POST', '/offices', { id: crypto.randomUUID(), name, file_prefix: prefix }, 'return=representation');
  return o;
}

// ---------- ตัวช่วยเดิมจาก Code.gs / logic.gs ----------
// แยก WBS แบบ C เป็น base/node/budgetOf/ownership — แบบ I/P หรือไม่มี node → base = WBS เต็ม
function parseWbs(wbs) {
  const m = String(wbs || '').match(/^(C-.*)\.(\d{2})\.(\d)$/);
  return m ? { base: m[1], node: m[2] + '.' + m[3], budgetOf: m[2], ownership: m[3] }
    : { base: String(wbs || ''), node: '', budgetOf: '', ownership: '' };
}
const cents = (x) => Math.round(Number(x) * 100);
const pad2 = (n) => (n < 10 ? '0' : '') + n;
const fmtDate = (d) => { const [y, m, dd] = String(d).split('-'); return `${+dd}/${+m}/${+y + 543}`; };

function toBudget(r) {
  return {
    key: r.key, wbs: r.wbs, network: r.network, dept: r.dept, category: r.category, act: r.act,
    allocation: Number(r.allocation), paid: Number(r.paid), balance: Number(r.balance),
    workName: r.work_name, wbsTotal: r.wbs_total === null ? null : Number(r.wbs_total),
    fileCode: r.file_code, oper: r.oper, imported: r.imported, ...parseWbs(r.wbs),
  };
}
async function getBudgets() {
  return (await all(`/budgets_v?select=*&${O()}&order=imported,key`)).map(toBudget);
}
async function getSettings() {
  const out = {};
  (await all(`/settings?select=type,value&${O()}`)).forEach((r) => (out[r.type] ||= []).push(r.value));
  return out;
}
async function addSetting(type, name) {
  name = String(name || '').trim();
  if (!name) throw new Error('ยังไม่ได้ใส่ชื่อ');
  await sb('POST', '/settings', { office: getOffice(), type, value: name }, 'resolution=ignore-duplicates');
  return (await getSettings())[type] || [];
}
const logRev = (key, oldVal, newVal, note) =>
  sb('POST', '/revisions', { office: getOffice(), key, old_val: String(oldVal), new_val: String(newVal), note });

// ---------- นำเข้างบ + re-import (แทน apiImportBudget_) ----------
// data = { fileName, workName, oper, wbsTotal, budgets:[{key,wbs,network,dept,category,act,allocation}], confirmKeys }
async function importBudget(data) {
  const incoming = data.budgets || [];
  const wbs = incoming[0] ? incoming[0].wbs : '';
  const existing = await getBudgets();
  const ex = Object.fromEntries(existing.map((b) => [b.key, b]));
  const confirm = new Set(data.confirmKeys || []);
  const toAdd = [], toConfirm = [];
  let unchanged = 0;
  for (const inc of incoming) {
    const e = ex[inc.key];
    if (!e) toAdd.push(inc);
    else if (cents(e.allocation) === cents(inc.allocation)) unchanged++;
    else toConfirm.push({ key: inc.key, oldVal: e.allocation, newVal: Number(inc.allocation), paid: e.paid,
      negativeRemaining: cents(inc.allocation) < cents(e.paid) });
  }
  const wbsTotal = data.wbsTotal === null || data.wbsTotal === undefined || data.wbsTotal === '' ? null : Number(data.wbsTotal);

  // รหัสแฟ้ม: base เดิม → รหัสเดิม, base ใหม่ → เลขรันถัดไปของสำนักงาน
  let fileCode = '';
  if (wbs) {
    const base = parseWbs(wbs).base;
    const same = existing.find((b) => b.base === base && b.fileCode);
    if (same) fileCode = same.fileCode;
    else {
      const [o] = await sb('GET', `/offices?select=file_prefix&id=${eq(getOffice())}`);
      const max = Math.max(0, ...existing.map((b) => Number(String(b.fileCode).replace(/\D/g, '')) || 0));
      fileCode = o.file_prefix + pad2(max + 1);
    }
  }
  const oper = data.oper || '';
  const now = new Date().toISOString();

  if (toAdd.length) {
    await sb('POST', '/budgets', toAdd.map((b) => ({
      office: getOffice(), key: b.key, wbs: b.wbs, network: String(b.network), dept: b.dept || '', category: b.category || '',
      act: String(b.act), allocation: Number(b.allocation), imported: now, file_name: data.fileName || '',
      work_name: data.workName || '', wbs_total: wbsTotal, file_code: fileCode, oper,
    })));
  }
  if (wbs && oper) await sb('PATCH', `/budgets?${O()}&wbs=${eq(wbs)}`, { oper });
  if (wbs && wbsTotal !== null) await sb('PATCH', `/budgets?${O()}&wbs=${eq(wbs)}`, { wbs_total: wbsTotal });

  const updated = [], needConfirm = [];
  for (const c of toConfirm) {
    if (!confirm.has(c.key)) { needConfirm.push(c); continue; }
    await sb('PATCH', `/budgets?${O()}&key=${eq(c.key)}`, { allocation: c.newVal, imported: now, file_name: data.fileName || '' });
    await logRev(c.key, c.oldVal, c.newVal, 're-import' + (c.negativeRemaining ? ` (⚠ ยอดใหม่ < ที่เบิกแล้ว ${c.paid.toFixed(2)})` : ''));
    updated.push(c.key);
  }
  return { added: toAdd.map((b) => b.key), unchanged, updated, needConfirm };
}

// ---------- ใบตัด ----------
async function getSlips(key) {
  const wbs = String(key).split('|')[0];
  // งวดของแฟ้ม = ลำดับใบในบรรดาใบทุกคีย์ของ WBS เดียวกัน (เรียงตามเลขใบ)
  const keys = (await all(`/budgets?select=key&${O()}&wbs=${eq(wbs)}`)).map((r) => r.key);
  if (!keys.length) return [];
  const rows = await all(`/ledger?select=slip_no,key,slip_date,pay_now,balance_after,work_name,requester&${O()}&key=${inList(keys)}&order=slip_no`);
  return rows.map((r, i) => ({ ...r, period: i + 1 })).filter((r) => r.key === key).map((r) => ({
    slipNo: r.slip_no, period: r.period, date: fmtDate(r.slip_date), payNow: Number(r.pay_now),
    balance: Number(r.balance_after), workName: r.work_name, requester: r.requester,
  }));
}
async function createSlip(d) {
  let extra = d.extra || {};
  if (typeof extra === 'string') extra = extra ? JSON.parse(extra) : {};
  const r = await sb('POST', '/rpc/create_slip', { p: { ...d, extra, office: getOffice() } });
  return { ...r, paid: r.paid === null ? null : Number(r.paid), balance: Number(r.balance) };
}

// ---------- ข้อมูลใบตัด 1 ใบ สำหรับวาด HTML แล้วพิมพ์ (แทน apiMakePdf_ + Google Doc template) ----------
const TH_M = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_MS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
// "YYYY-MM-DD" → "8 ก.ค. 2569" (ว่าง → '')
const thaiShort = (s) => { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${+d} ${TH_MS[m - 1]} ${+y + 543}`; };
// แยกเงินเป็น { baht: "12,345", sat: "60" }
function splitMoney(x) {
  const c = Math.round(Number(x) * 100), neg = c < 0, a = Math.abs(c);
  return { baht: (neg ? '-' : '') + Math.floor(a / 100).toLocaleString('en-US'), sat: String(a % 100).padStart(2, '0') };
}
const BUDGET_OF = { '01': 'งบของ กฟภ.', '02': 'งบของ ผู้ใช้ไฟ', '03': 'งบของ อื่นๆ' };

async function slipDoc(slipNo) {
  const [row] = await sb('GET', `/ledger?select=*&${O()}&slip_no=${eq(slipNo)}`);
  if (!row) throw new Error('ไม่พบใบตัดเลขที่ ' + slipNo);
  const [[bv], [o], same, wbsKeys] = await Promise.all([
    sb('GET', `/budgets_v?select=*&${O()}&key=${eq(row.key)}`),
    sb('GET', `/offices?select=name&id=${eq(getOffice())}`),
    all(`/ledger?select=pay_now&${O()}&key=${eq(row.key)}&slip_no=lt.${Number(slipNo)}`),
    getSlips(row.key), // ใช้หางวดของแฟ้ม
  ]);
  if (!bv) throw new Error('ไม่พบก้อนงบของใบตัดนี้: ' + row.key);
  const b = toBudget(bv);
  // จ่ายแล้ว = ยอดเบิกทุกใบก่อนหน้าใบนี้ (คีย์เดียวกัน เลขใบน้อยกว่า)
  const paidBefore = same.reduce((s, r) => s + cents(r.pay_now), 0) / 100;
  const x = row.extra || {}, chk = x.chk || {};
  const ck = (on) => (on ? '(✓)' : '(    )');
  const [yy, mm, dd] = row.slip_date.split('-');
  const m = (v) => splitMoney(v);
  const [Y, J, K, C, L] = [b.allocation, paidBefore, b.allocation - paidBefore, row.pay_now, row.balance_after].map(m);
  const period = (wbsKeys.find((s) => s.slipNo === row.slip_no) || {}).period || slipNo;
  return {
    filename: `ใบตัดงบ_งวด${period}_${row.key.replace(/\|/g, '-')}`,
    othText: x.othText || '', // แทนจุดไข่ปลาหลัง "อื่นๆ"
    map: {
      OFFICE: o ? o.name : '', REF: row.ref, JOB: row.work_name, WBS: b.wbs,
      DD: String(+dd), MM: TH_M[mm - 1], YY: String(+yy + 543), USR: row.requester, POS: row.position,
      APV: x.apv || '', APD: thaiShort(x.apd),
      DPT: b.dept, CAT: b.category, NET: b.network, ACT: b.act,
      YB: Y.baht, YS: Y.sat, JB: J.baht, JS: J.sat, KB: K.baht, KS: K.sat, CB: C.baht, CS: C.sat, LB: L.baht, LS: L.sat,
      CHK_VEH: ck(chk.VEH), CHK_TRV: ck(chk.TRV), CHK_CRN: ck(chk.CRN), CHK_DLY: ck(chk.DLY),
      CHK_CON: ck(chk.CON), CHK_OIL: ck(chk.OIL), CHK_OTH: ck(chk.OTH),
      CRN_NAME: x.crnName || '', CRN_FROM: thaiShort(x.crnFrom), CRN_TO: thaiShort(x.crnTo),
      DLY_FROM: thaiShort(x.dlyFrom), DLY_TO: thaiShort(x.dlyTo), DLY_TEAM: x.dlyTeam || '',
      OIL_PLATE: x.oilPlate || '', CON_NO: row.contract, CON_DATE: thaiShort(row.con_date),
      NODE: b.node ? (BUDGET_OF[b.budgetOf] ? b.node + '  ' + BUDGET_OF[b.budgetOf] : b.node) : '',
      OPER: b.oper, FCODE: b.fileCode,
    },
  };
}

// ---------- ลบ (รหัสผ่านตรวจที่หน้าจอ — ponytail: ไม่ล็อกอิน server จึงตรวจไม่ได้จริง) ----------
async function delBudgets(filter) {
  const rows = await sb('DELETE', `/budgets?${O()}&${filter}`, undefined, 'return=representation');
  return { budgets: rows.length, slips: null }; // ใบตัดหายตามด้วย on delete cascade
}
async function deleteFileAll(base) {
  const keys = (await getBudgets()).filter((b) => b.base === String(base)).map((b) => b.key);
  if (!keys.length) return { budgets: 0, slips: 0 };
  return delBudgets('key=' + inList(keys));
}

// ---------- แก้ WBS / โครงข่าย: เปลี่ยนคีย์งบ → คีย์ใบตัดตามเอง (on update cascade) ----------
async function rekey(rows, fn) {
  for (const r of rows) await sb('PATCH', `/budgets?${O()}&key=${eq(r.key)}`, fn(r));
  return rows.length;
}
async function editWbs({ oldWbs = '', newWbs = '' }) {
  oldWbs = String(oldWbs).trim(); newWbs = String(newWbs).trim();
  if (!newWbs) throw new Error('ต้องระบุ WBS ใหม่');
  if (oldWbs === newWbs) return { changed: 0 };
  const rows = await all(`/budgets?select=key,network,act&${O()}&wbs=${eq(oldWbs)}`);
  if (!rows.length) throw new Error('ไม่พบก้อนงบของ WBS: ' + oldWbs);
  const n = await rekey(rows, (r) => ({ wbs: newWbs, key: [newWbs, r.network, r.act].join('|') }));
  await logRev(oldWbs, oldWbs, newWbs, 'แก้ WBS');
  return { changed: n, oldWbs, newWbs };
}
async function editNetwork({ wbs = '', oldNet = '', newNet = '' }) {
  oldNet = String(oldNet).trim(); newNet = String(newNet).trim();
  if (!oldNet) throw new Error('ไม่ระบุโครงข่ายเดิม');
  if (!newNet) throw new Error('ต้องระบุหมายเลขโครงข่ายใหม่');
  if (oldNet === newNet) return { changed: 0 };
  const rows = await all(`/budgets?select=key,wbs,act&${O()}&wbs=${eq(wbs)}&network=${eq(oldNet)}`);
  if (!rows.length) throw new Error('ไม่พบก้อนงบของโครงข่าย: ' + oldNet);
  return { changed: await rekey(rows, (r) => ({ network: newNet, key: [r.wbs, newNet, r.act].join('|') })), oldNet, newNet };
}
async function setWbsCol(wbs, patch) {
  if (!wbs) throw new Error('ไม่ระบุหมายเลขงาน (WBS)');
  const rows = await sb('PATCH', `/budgets?${O()}&wbs=${eq(wbs)}`, patch, 'return=representation');
  if (!rows.length) throw new Error('ไม่พบก้อนงบของ WBS: ' + wbs);
  return rows.length;
}
// เปลี่ยนตัวย่อ + เขียนรหัสแฟ้มเดิมใหม่ทั้งหมดโดยคงเลขรัน (KCE01 → KTW01)
async function setFilePrefix({ prefix }) {
  const np = String(prefix || '').trim().toUpperCase();
  await sb('PATCH', `/offices?id=${eq(getOffice())}`, { file_prefix: np }); // constraint กันซ้ำ/รูปแบบผิด
  const codes = [...new Set((await getBudgets()).map((b) => b.fileCode).filter(Boolean))];
  let changed = 0;
  for (const old of codes) {
    const nc = np + old.replace(/\D/g, '');
    if (nc !== old) changed += (await sb('PATCH', `/budgets?${O()}&file_code=${eq(old)}`, { file_code: nc }, 'return=representation')).length;
  }
  return { prefix: np, changed };
}

// ---------- router — ชื่อ action เดิมของ Code.gs ----------
export async function callApi(action, data = {}) {
  if (!getOffice()) throw new Error('ยังไม่ได้เลือกสำนักงาน');
  switch (action) {
    case 'getBudgets': return getBudgets();
    case 'getSettings': return getSettings();
    case 'getAll': {
      const [budgets, settings, [o]] = await Promise.all([getBudgets(), getSettings(),
        sb('GET', `/offices?select=*&id=${eq(getOffice())}`)]);
      if (!o) throw new Error('ไม่พบสำนักงานนี้ในระบบ — เลือกสำนักงานใหม่');
      return { budgets, settings, office: o.name, filePrefix: o.file_prefix, gsVersion: 'Supabase' };
    }
    case 'importBudget': return importBudget(data);
    case 'createSlip': return createSlip(data);
    case 'getSlips': return getSlips(data.key);
    case 'makePdf': return slipDoc(data.slipNo); // คืนข้อมูล ให้ slip.js วาด HTML แล้วพิมพ์
    case 'deleteSlip': {
      const rows = await sb('DELETE', `/ledger?${O()}&slip_no=${eq(data.slipNo)}`, undefined, 'return=representation');
      if (!rows.length) throw new Error('ไม่พบใบตัดเลขที่ ' + data.slipNo);
      return { deleted: rows.length };
    }
    case 'deleteFile': return delBudgets('wbs=' + eq(data.wbs));
    case 'deleteFileAll': return deleteFileAll(data.base);
    case 'deleteNetwork': return delBudgets(`wbs=${eq(data.wbs || '')}&network=${eq(data.network)}`);
    case 'addDriver': return addSetting('พขร.', data.name);
    case 'addRequester': return addSetting('ผู้เบิก', data.name);
    case 'addCompany': return addSetting('บริษัท', data.name);
    case 'addPlate': return addSetting('ทะเบียนรถ', data.name);
    case 'setWbsTotal': {
      const total = Number(data.total);
      if (isNaN(total) || total < 0) throw new Error('ยอดจัดสรรรวมไม่ถูกต้อง');
      return { wbs: data.wbs, total, rows: await setWbsCol(data.wbs, { wbs_total: total }) };
    }
    case 'setOper': {
      const oper = String(data.oper || '').trim();
      return { wbs: data.wbs, oper, rows: await setWbsCol(data.wbs, { oper }) };
    }
    case 'setFilePrefix': return setFilePrefix(data);
    case 'editWbs': return editWbs(data);
    case 'editNetwork': return editNetwork(data);
    default: throw new Error('ไม่รู้จัก action: ' + action);
  }
}
