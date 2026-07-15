// app.js — Phase 2: นำเข้า ZPSR018 → คุมงบ → เปิดใบตัด (ยังไม่ออก PDF)
import * as pdfjs from './vendor/pdf.min.mjs';
import { parseZpsr018 } from './parser.js';
import { callApi, hasBackend } from './api.js';

pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// แยก WBS แบบ C เป็น base/node/budgetOf/ownership (ข้อ 1/4) — แบบ I/ไม่มี node → base = WBS เต็ม
const parseWbs = (wbs) => {
  const m = String(wbs || '').match(/^(C-.*)\.(\d{2})\.(\d)$/);
  return m ? { base: m[1], node: m[2] + '.' + m[3], budgetOf: m[2], ownership: m[3] }
           : { base: String(wbs || ''), node: '', budgetOf: '', ownership: '' };
};
const extractNode = (wbs) => parseWbs(wbs).node; // เฉพาะ WBS แบบ C
const ownerLabel = (ownership) => (ownership === '1' ? 'กฟภ.' : ownership === '2' ? 'ผู้ใช้ไฟ' : '');
const budgetOfLabel = (budgetOf) => (budgetOf === '01' ? 'งบของ กฟภ.' : budgetOf === '02' ? 'งบของ ผู้ใช้ไฟ' : budgetOf === '03' ? 'งบของ อื่นๆ' : '');

// ไอคอน SVG line (stroke currentColor) แทน emoji — กลมกลืนทั้งแอป
const ICONS = {
  upload: '<path d="M12 15.5V4M8 7.5 12 3.5l4 4"/><path d="M4.5 16.5v1.5A2 2 0 0 0 6.5 20h11a2 2 0 0 0 2-2v-1.5"/>',
  download: '<path d="M12 4v11M8 11.5l4 4 4-4"/><path d="M4.5 17.5v1A2 2 0 0 0 6.5 20.5h11a2 2 0 0 0 2-2v-1"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M10 11v6M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17z"/><path d="M13.5 6.5l3 3"/>',
};
const ic = (name) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
const spin = '<span class="spinner"></span>';

let parsed = null;      // ผลอ่านไฟล์ล่าสุด {wbs, networks, fileName}
let budgets = [];       // ก้อนงบจาก server
let settings = {};      // master data dropdown
let selectedBase = null; // แฟ้มที่เลือกดูอยู่ (WBS base)
let selectedNode = 'ALL'; // โหนดที่เลือกในแฟ้ม: 'ALL' (ทุกโหนด) หรือ WBS เต็มของโหนดนั้น
let search = '';        // คำค้นในหน้าเลือกแฟ้ม
let dashMode = 'sum';   // โหมด Dashboard: sum | month | year
let remainCats = null;  // ข้อ 6: Set หมวดงบที่เลือก (null = ทั้งหมด)
let remainOper = 'all'; // ข้อ 6: ตัวกรองผู้ดำเนินการ all | pea | co
let remainSort = { col: 'fileCode', dir: 1 }; // ข้อ 6: คอลัมน์+ทิศทาง sort
let flashCutKey = null; // key ก้อนงบที่เพิ่งตัด → ไฮไลต์แถวชั่วคราวหลัง re-render

// ---------- สลับ panel ใน main + เมนู sidebar ----------
function showPanel(name) {
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  $('panel-' + name).classList.add('active');
}
function setMenuActive(name) { // name = ชื่อ panel ของเมนู หรือ '' (ไม่ไฮไลต์)
  document.querySelectorAll('.menu-item').forEach((m) => m.classList.toggle('active', m.dataset.panel === name));
}
const PANEL_RENDER = { files: renderFiles, pending: renderPending, dashboard: renderDashboard, remaining: renderRemaining };
function goPanel(name) { flashCutKey = null; setMenuActive(name); showPanel(name); (PANEL_RENDER[name] || (() => {}))(); }

$('menu').addEventListener('click', (e) => {
  const btn = e.target.closest('.menu-item'); if (btn) goPanel(btn.dataset.panel);
});
$('navImport').addEventListener('click', () => { setMenuActive(''); showPanel('import'); });
$('reloadBudgets').addEventListener('click', loadBudgets);
$('search').addEventListener('input', (e) => { search = e.target.value.trim().toLowerCase(); renderFiles(); });

// ---------- ธีมสว่าง/มืด (จำใน localStorage, default ตามระบบ) ----------
const ICON_SUN = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/></svg>';
const ICON_MOON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 13A8.5 8.5 0 1 1 11 3.5 6.6 6.6 0 0 0 20.5 13z"/></svg>';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('themeToggle').innerHTML = t === 'dark' ? ICON_SUN + 'โหมดสว่าง' : ICON_MOON + 'โหมดมืด';
}
applyTheme(localStorage.getItem('theme') ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('themeToggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

// PWA — ลงทะเบียน service worker (ติดตั้ง/ออฟไลน์). ทำงานเฉพาะ https หรือ localhost
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

// เครดิตผู้พัฒนา — กดแล้วเด้ง modal
$('credit').addEventListener('click', () => {
  const dev = (name, role) => `<div style="text-align:center;padding:10px 0">
      <div style="color:var(--primary)"><svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg></div>
      <div style="font-size:18px;font-weight:600;margin-top:8px">${name}</div>
      <div class="sub" style="margin-top:4px">${role}</div>
    </div>`;
  $('modalBox').innerHTML = `<h3 style="text-align:center">ผู้พัฒนา</h3>
    ${dev('นายพชระ ปรีดากรณ์', 'วศก.ผปร. กฟส.คช.')}
    ${dev('นายภัคพล คนซื่อ', 'พชง.ผปร. กฟส.คช.')}
    <div class="modal-actions" style="justify-content:center"><button class="btn" id="creditClose">ปิด</button></div>`;
  $('modal').classList.add('show');
  $('creditClose').addEventListener('click', closeModal);
});

// ================= View: นำเข้าไฟล์ =================
const drop = $('drop');
// 1 ไฟล์ = พรีวิวแล้วกดนำเข้า (flow เดิม) | หลายไฟล์ = นำเข้าเป็นชุด (loop + progress + สรุป)
const routeFiles = (list) => { const files = [...list]; if (files.length === 1) handleFile(files[0]); else if (files.length > 1) handleFiles(files); };
$('file').addEventListener('change', (e) => routeFiles(e.target.files));
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => routeFiles(e.dataTransfer.files));

async function extractItems(buf) {
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const items = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    for (const it of tc.items) {
      if (it.str.trim() === '') continue;
      items.push({ x: it.transform[4], y: it.transform[5] + p * 100000, s: it.str });
    }
  }
  return items;
}

async function handleFile(file) {
  $('importOut').innerHTML = '<div class="sub">' + spin + 'กำลังอ่านไฟล์…</div>';
  try {
    const items = await extractItems(await file.arrayBuffer());
    parsed = parseZpsr018(items);
    parsed.fileName = file.name;
    renderParsed();
  } catch (err) {
    $('importOut').innerHTML = `<div class="err">อ่านไฟล์ไม่สำเร็จ: ${esc(err.message)}</div>`;
    console.error(err);
  }
}

function renderParsed() {
  const { wbs, networks } = parsed;
  if (!networks.length) { $('importOut').innerHTML = '<div class="err">ไม่พบข้อมูลงบในไฟล์</div>'; return; }
  let html = hasBackend()
    ? `<div class="field" style="margin-bottom:16px"><label>ชื่องาน (ใช้กับทุกใบตัดในไฟล์นี้)</label>
         <input id="f-jobName" placeholder="ชื่องานก่อสร้าง"></div>` + operPickerHtml('')
    : '';
  // WBS: อ่านได้ → แสดง | อ่านไม่ได้ → ให้กรอกมือ (บังคับก่อน import)
  html += wbs
    ? `<div id="wbs">หมายเลขงาน (WBS): <span>${esc(wbs)}</span></div>`
    : `<div class="card" style="border-color:var(--warn-bd);background:var(--warn-soft)">
         <b class="warn">${ic('alert')}อ่าน WBS ไม่ได้ — กรอกหมายเลขงานเอง (จำเป็น)</b>
         <div class="field" style="margin:10px 0 0"><input id="f-wbsManual" placeholder="เช่น C-68-E-KCECS.0080.02.2"></div></div>`;
  for (const n of networks) {
    html += `<div class="net"><h2>โครงข่าย ${esc(n.network)}<span class="dept">${esc(n.dept)}</span></h2>
      <table><thead><tr><th>หมวดงบ</th><th class="num">ยอดจัดสรร (บาท)</th><th>เลขกิจกรรม</th><th>เปิดใบตัดงบ</th></tr></thead><tbody>`;
    for (const c of n.categories) {
      html += `<tr class="${c.openSlip ? '' : 'skip'}"><td>${esc(c.name)}</td><td class="num">${fmt(c.value)}</td>
        <td class="act">${c.act}</td><td>${c.openSlip ? `<span class="yes">${ic('check')}</span>` : '<span class="no">—</span>'}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }
  html += hasBackend()
    ? `<div style="text-align:center;margin-top:24px">
         <button class="btn" id="importBtn" style="font-size:1.15rem;padding:14px 44px">${ic('upload')}นำงบเข้าระบบ</button></div>
       <div id="importResult"></div>`
    : `<div class="warn" style="margin-top:12px">ℹ️ ยังไม่ได้ตั้งค่า GAS_URL ใน config.js — นำเข้าระบบไม่ได้ (แสดงผลบนจอเท่านั้น)</div>`;
  $('importOut').innerHTML = html;
  if (hasBackend()) {
    bindOperPicker();
    $('importBtn').addEventListener('click', () => doImport([]));
    // อ่าน WBS ไม่ได้ → บังคับกรอกก่อน กดนำเข้าไม่ได้จนกว่าจะกรอก
    const man = $('f-wbsManual');
    if (man) {
      const btn = $('importBtn'); btn.disabled = true;
      man.addEventListener('input', () => { btn.disabled = !man.value.trim(); });
    }
  }
}

// แปลง networks → รายการก้อนงบ (เฉพาะหมวดที่เปิดใบได้) — รับ parsed ตัวใดก็ได้ (default = ไฟล์ล่าสุด)
function toBudgetRows(p = parsed) {
  const rows = [];
  for (const n of p.networks) {
    for (const c of n.categories) {
      if (!c.openSlip) continue;
      rows.push({
        key: [p.wbs, n.network, c.act].join('|'),
        wbs: p.wbs, network: n.network, dept: n.dept,
        category: c.name, act: c.act, allocation: c.value,
      });
    }
  }
  return rows;
}

async function doImport(confirmKeys) {
  const btn = $('importBtn'); if (btn) btn.disabled = true;
  $('importResult').innerHTML = '<div class="sub">' + spin + 'กำลังนำเข้า…</div>';
  try {
    const workName = $('f-jobName') ? $('f-jobName').value.trim() : '';
    if ($('f-wbsManual')) parsed.wbs = $('f-wbsManual').value.trim(); // WBS กรอกมือ → ใช้สร้างคีย์
    const oper = readOper();
    const r = await callApi('importBudget', { fileName: parsed.fileName, workName, oper, wbsTotal: parsed.wbsTotal, budgets: toBudgetRows(), confirmKeys });
    let html = `<div class="ok">${ic('check')}นำเข้าเสร็จ — เพิ่มใหม่ ${r.added.length} | เท่าเดิม(ข้าม) ${r.unchanged} | อัปเดต ${r.updated.length}</div>`;
    if (r.needConfirm && r.needConfirm.length) {
      html += `<div class="card"><b class="warn">${ic('alert')}พบยอดจัดสรรเปลี่ยน — ต้องยืนยันก่อนทับ</b>`;
      for (const c of r.needConfirm) {
        html += `<div class="diff"><label><input type="checkbox" class="cf" value="${esc(c.key)}" checked>
          <span class="mono">${esc(c.key)}</span> : ${fmt(c.oldVal)} → <b>${fmt(c.newVal)}</b>
          ${c.negativeRemaining ? `<span class="err">(ยอดใหม่ต่ำกว่าที่เบิกไปแล้ว ${fmt(c.paid)} → คงเหลือจะติดลบ)</span>` : ''}</label></div>`;
      }
      html += `<button class="btn" id="confirmBtn">ยืนยันแก้ยอดที่ติ๊ก</button></div>`;
    }
    $('importResult').innerHTML = html;
    loadBudgets(); // รีเฟรชรายการงานใน sidebar ให้เห็นงานที่เพิ่งนำเข้า
    const cb = $('confirmBtn');
    if (cb) cb.addEventListener('click', () => {
      const keys = [...document.querySelectorAll('.cf:checked')].map((x) => x.value);
      doImport(keys);
    });
  } catch (err) {
    $('importResult').innerHTML = `<div class="err">นำเข้าไม่สำเร็จ: ${esc(err.message)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ================= นำเข้าหลายไฟล์เป็นชุด (ข้อ 2) =================
// เก็บผลรายไฟล์ไว้ระหว่างรอบยืนยัน re-import
let batchResults = [];

function handleFiles(files) {
  if (!hasBackend()) {
    $('importOut').innerHTML = `<div class="warn">ℹ️ ยังไม่ได้ตั้งค่า GAS_URL ใน config.js — นำเข้าระบบไม่ได้</div>`;
    return;
  }
  $('importOut').innerHTML = `<div class="field" style="margin-bottom:16px"><label>ชื่องาน (ใช้กับทุกไฟล์ในชุดนี้ — เว้นว่างได้)</label>
      <input id="f-jobName" placeholder="ชื่องานก่อสร้าง"></div>
    ${operPickerHtml('')}
    <div class="card">เลือกไว้ <b>${files.length}</b> ไฟล์ — จะนำเข้าตามลำดับ (ผู้ดำเนินการใช้ร่วมทั้งชุด)</div>
    <div style="text-align:center;margin-top:16px">
      <button class="btn" id="batchBtn" style="font-size:1.1rem;padding:13px 40px">${ic('upload')}เริ่มนำเข้า ${files.length} ไฟล์</button></div>
    <div id="batchOut"></div>`;
  bindOperPicker();
  $('batchBtn').addEventListener('click', () => runBatch(files));
}

async function runBatch(files) {
  const workName = $('f-jobName') ? $('f-jobName').value.trim() : '';
  const oper = readOper();
  $('batchBtn').disabled = true;
  const out = $('batchOut');
  batchResults = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    out.innerHTML = `<div class="sub">${spin}กำลังประมวลผล ${i + 1}/${files.length} — ${esc(f.name)}…</div>`;
    try {
      const p = parseZpsr018(await extractItems(await f.arrayBuffer()));
      if (!p.networks.length) { batchResults.push({ name: f.name, error: 'ไม่พบข้อมูลงบในไฟล์' }); continue; }
      if (!p.wbs) { batchResults.push({ name: f.name, error: 'อ่าน WBS ไม่ได้ — นำเข้าไฟล์นี้ทีละไฟล์เพื่อกรอก WBS เอง' }); continue; }
      const budgets = toBudgetRows(p);
      const r = await callApi('importBudget', { fileName: f.name, workName, oper, wbsTotal: p.wbsTotal, budgets, confirmKeys: [] });
      batchResults.push({ name: f.name, wbs: p.wbs, wbsTotal: p.wbsTotal, workName, budgets,
        added: r.added.length, unchanged: r.unchanged, updated: r.updated.length, needConfirm: r.needConfirm || [] });
    } catch (err) {
      batchResults.push({ name: f.name, error: err.message });
    }
  }
  renderBatchSummary();
  loadBudgets(); // รีเฟรช sidebar/การ์ดให้เห็นงานที่เพิ่งนำเข้า
}

// จัดกลุ่มผลรายไฟล์: สำเร็จ(เพิ่ม/อัปเดต) / ข้าม(เท่าเดิม) / เปลี่ยนแปลง(ต้องยืนยัน) / error
function renderBatchSummary() {
  const err = batchResults.filter((r) => r.error);
  const changed = batchResults.filter((r) => !r.error && r.needConfirm.length);
  const ok = batchResults.filter((r) => !r.error && !r.needConfirm.length && (r.added || r.updated));
  const skip = batchResults.filter((r) => !r.error && !r.needConfirm.length && !r.added && !r.updated);

  let html = `<div class="ok">${ic('check')}นำเข้าเสร็จ ${batchResults.length} ไฟล์ — สำเร็จ ${ok.length} · ข้าม(เท่าเดิม) ${skip.length} · พบการเปลี่ยนแปลง ${changed.length}${err.length ? ` · ผิดพลาด ${err.length}` : ''}</div>`;

  for (const r of err) html += `<div class="err">${esc(r.name)}: ${esc(r.error)}</div>`;

  if (changed.length) {
    html += `<div class="card"><b class="warn">${ic('alert')}พบยอดจัดสรรเปลี่ยน — ติ๊กเลือกยอดที่จะทับ แล้วกดยืนยัน</b>`;
    changed.forEach((r) => {
      const idx = batchResults.indexOf(r);
      html += `<div style="margin-top:10px;font-weight:600">${esc(r.name)}</div>`;
      for (const c of r.needConfirm) {
        html += `<div class="diff"><label><input type="checkbox" class="cf" value="${idx}::${esc(c.key)}" checked>
          <span class="mono">${esc(c.key)}</span> : ${fmt(c.oldVal)} → <b>${fmt(c.newVal)}</b>
          ${c.negativeRemaining ? `<span class="err">(ยอดใหม่ต่ำกว่าที่เบิกไปแล้ว ${fmt(c.paid)} → คงเหลือจะติดลบ)</span>` : ''}</label></div>`;
      }
    });
    html += `<button class="btn" id="batchConfirmBtn">ยืนยันแก้ยอดที่ติ๊ก</button></div>`;
  }
  $('batchOut').innerHTML = html;

  const cb = $('batchConfirmBtn');
  if (cb) cb.addEventListener('click', confirmBatchChanges);
}

// ยืนยันทับยอด — จัดกลุ่มคีย์ที่ติ๊กตามไฟล์ แล้ว re-import ทีละไฟล์ด้วย confirmKeys ของมัน
async function confirmBatchChanges() {
  const cb = $('batchConfirmBtn'); cb.disabled = true;
  const byFile = {};
  document.querySelectorAll('.cf:checked').forEach((x) => {
    const [idx, key] = x.value.split('::');
    (byFile[idx] = byFile[idx] || []).push(key);
  });
  try {
    for (const idx of Object.keys(byFile)) {
      const r = batchResults[+idx];
      await callApi('importBudget', { fileName: r.name, workName: r.workName, wbsTotal: r.wbsTotal, budgets: r.budgets, confirmKeys: byFile[idx] });
    }
    $('batchOut').innerHTML = `<div class="ok">${ic('check')}อัปเดตยอดที่เลือกแล้ว</div>`;
    loadBudgets();
  } catch (err) {
    $('batchOut').innerHTML += `<div class="err">ยืนยันไม่สำเร็จ: ${esc(err.message)}</div>`;
    cb.disabled = false;
  }
}

// ================= โหลดข้อมูล + แสดง panel =================
async function loadBudgets() {
  if (!hasBackend()) {
    setSync(false, 'ยังไม่ได้ตั้งค่า GAS_URL');
    $('filesOut').innerHTML = '<div class="list-empty">ยังไม่ได้ตั้งค่า GAS_URL ใน config.js</div>';
    return;
  }
  setSync(true, 'กำลังโหลด…');
  try {
    [budgets, settings] = await Promise.all([callApi('getBudgets'), callApi('getSettings')]);
    setSync(true, 'เชื่อมต่อฐานข้อมูลแล้ว');
    updatePendingBadge();
    renderActivePanel();
  } catch (err) {
    setSync(false, 'เชื่อมต่อไม่สำเร็จ');
    $('filesOut').innerHTML = `<div class="list-empty err">โหลดไม่สำเร็จ: ${esc(err.message)}</div>`;
  }
}

// เรนเดอร์เฉพาะ panel ที่กำลังเปิดอยู่ (หลังโหลดข้อมูลใหม่)
function renderActivePanel() {
  if ($('panel-job').classList.contains('active') && selectedBase) renderDetail();
  else if ($('panel-pending').classList.contains('active')) renderPending();
  else if ($('panel-dashboard').classList.contains('active')) renderDashboard();
  else if ($('panel-remaining').classList.contains('active')) renderRemaining();
  else renderFiles();
}

function setSync(ok, txt) {
  $('sync').className = 'sync ' + (ok ? 'on' : 'off');
  $('syncTxt').textContent = txt;
}

// รวมยอดต่อแฟ้ม (WBS) — ใช้ทุกหน้า
function jobStats() {
  const jobs = {};
  budgets.forEach((b) => {
    const j = jobs[b.wbs] || (jobs[b.wbs] = { wbs: b.wbs, fileCode: '', node: extractNode(b.wbs), oper: '', cats: 0, alloc: 0, paid: 0, bal: 0, nets: new Set(), created: null, wbsTotal: null });
    j.cats++; j.alloc += b.allocation; j.paid += b.paid; j.bal += b.balance; j.nets.add(b.network);
    if (b.fileCode && !j.fileCode) j.fileCode = b.fileCode; // รหัสแฟ้ม (เท่ากันทุกแถวของ WBS)
    if (b.oper && !j.oper) j.oper = b.oper; // ผู้ดำเนินการ (เท่ากันทุกแถวของ WBS)
    if (b.wbsTotal != null && j.wbsTotal == null) j.wbsTotal = b.wbsTotal; // ยอดจัดสรรรวมทั้งงาน (เท่ากันทุกแถวของ WBS)
    const d = b.imported ? new Date(b.imported) : null; // วันที่สร้างแฟ้ม = import ครั้งแรกสุด
    if (d && !isNaN(d) && (!j.created || d < j.created)) j.created = d;
  });
  return Object.values(jobs);
}

// รวมเป็น "แฟ้ม" ตาม WBS base (ข้อ 1) — 1 แฟ้ม = หลาย node (แต่ละ node = 1 WBS เต็ม)
function fileStats() {
  const files = {};
  jobStats().forEach((j) => {
    const w = parseWbs(j.wbs);
    const f = files[w.base] || (files[w.base] = { base: w.base, fileCode: '', oper: '', type: w.base.charAt(0), nodes: [], created: null });
    f.nodes.push(j);
    if (j.fileCode && !f.fileCode) f.fileCode = j.fileCode;
    if (j.oper && !f.oper) f.oper = j.oper;
    if (j.created && (!f.created || j.created < f.created)) f.created = j.created;
  });
  const vals = Object.values(files);
  vals.forEach((f) => f.nodes.sort((a, b) => parseWbs(a.wbs).node.localeCompare(parseWbs(b.wbs).node)));
  return vals;
}
// แฟ้มมีตัดงบแล้วอย่างน้อย 1 node หรือยัง (สถานะรวมทั้งแฟ้ม)
const fileStatus = (f) => (f.nodes.every((n) => jobStatus(n) === 'none') ? 'none'
  : f.nodes.every((n) => jobStatus(n) === 'done') ? 'done' : 'part');

const TH_MONTH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const dayKey = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD สำหรับ sort
const thaiDay = (d) => `${d.getDate()} ${TH_MONTH[d.getMonth()]} ${d.getFullYear() + 543}`;
// ฐานงบทั้งงาน = ยอดจัดสรรรวม (fallback: รวมหมวด ถ้ายังไม่ตั้งยอด) — ใช้คิด %/คงเหลือ/สถานะ ให้ตรงกันทุกที่
const jobBase = (j) => (j.wbsTotal != null && j.wbsTotal > 0) ? j.wbsTotal : j.alloc;
const jobRemain = (j) => j.wbsTotal != null ? Math.round((j.wbsTotal - j.paid) * 100) / 100 : j.bal;
const jobStatus = (j) => (j.paid <= 0 ? 'none' : jobRemain(j) <= 0.005 ? 'done' : 'part'); // ยังไม่ตัด / เบิกครบ / กำลังตัด
const STATUS_LABEL = { none: 'ยังไม่ตัด', part: 'กำลังตัด', done: 'เบิกครบ' };

// สรุป 1 node (ในการ์ดแฟ้ม) — กดเปิดหน้ารายละเอียดของ node นั้น (WBS เต็ม)
function nodeSummary(j, active) {
  const base = jobBase(j), remain = jobRemain(j);
  const pct = base > 0 ? Math.min(100, (j.paid / base) * 100) : 0;
  const st = jobStatus(j);
  return `<div class="fc-panel${active ? ' on' : ''}" data-wbs="${esc(j.wbs)}">
    <div class="fc-row"><span class="fc-badge ${st}">${STATUS_LABEL[st]}</span>
      <span class="fc-meta">${j.nets.size} โครงข่าย · ${j.cats} หมวดงบ</span></div>
    <div class="fc-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="fc-stats"><span>จัดสรร<b>${fmt(base)}</b></span>
      <span>คงเหลือ<b class="${remain < 0 ? 'err' : ''}">${fmt(remain)}</b></span></div></div>`;
}

// การ์ดแฟ้ม 1 ใบ = 1 base (ข้อ 1) — หัว รหัส—base + badge + tab ตาม node (ถ้ามีหลาย node)
function fileCard(f) {
  const st = fileStatus(f);
  const typeLabel = f.type === 'C' ? 'งบ C' : f.type === 'I' ? 'งบ I' : '';
  const multi = f.nodes.length > 1;
  const tabs = multi ? `<div class="fc-tabs">${f.nodes.map((n, i) => {
    const w = parseWbs(n.wbs);
    return `<button class="fc-tab${i === 0 ? ' on' : ''}" data-tab="${i}">${esc(w.node)}${w.ownership ? ' ' + esc(ownerLabel(w.ownership)) : ''}</button>`;
  }).join('')}</div>` : '';
  const panels = f.nodes.map((n, i) => nodeSummary(n, i === 0)).join('');
  return `<div class="filecard" data-file>
    <div class="fc-top"><span class="fc-wbs">${esc(f.fileCode)} — ${esc(f.base)}</span>
      <span class="fc-badge ${st}">${STATUS_LABEL[st]}</span></div>
    <div class="fc-pills">${typeLabel ? `<span class="fc-pill">${typeLabel}</span>` : ''}${f.oper ? `<span class="fc-pill">${esc(f.oper)}</span>` : ''}</div>
    ${tabs}${panels}</div>`;
}
function bindFileCards(root) {
  root.querySelectorAll('.filecard').forEach((card) => {
    card.querySelectorAll('.fc-tab').forEach((tab) => tab.addEventListener('click', (e) => {
      e.stopPropagation(); // กด tab = สลับ node ไม่เข้าแฟ้ม
      const i = tab.dataset.tab;
      card.querySelectorAll('.fc-tab').forEach((t) => t.classList.toggle('on', t === tab));
      card.querySelectorAll('.fc-panel').forEach((p, pi) => p.classList.toggle('on', String(pi) === i));
    }));
    // กดที่ไหนก็ได้ในการ์ด (ยกเว้น tab) → เข้าแฟ้มที่ node ที่เลือกอยู่
    card.addEventListener('click', () => {
      const active = card.querySelector('.fc-panel.on');
      if (active) openJob(active.dataset.wbs);
    });
  });
}

function updatePendingBadge() {
  const n = fileStats().filter((f) => fileStatus(f) === 'none').length;
  $('pendCount').textContent = n || '';
}

// ---------- หน้า: เลือกแฟ้มงาน (จัดกลุ่มตามวันที่สร้าง) ----------
function renderFiles() {
  const jobs = fileStats().filter((f) => (f.base + ' ' + f.fileCode).toLowerCase().includes(search));
  if (!jobs.length) {
    $('filesOut').innerHTML = `<div class="list-empty">${budgets.length ? 'ไม่พบแฟ้มที่ค้นหา' : 'ยังไม่มีแฟ้ม — กด “นำเข้าไฟล์ ZPSR018” เพื่อเพิ่มแฟ้มแรก'}</div>`;
    return;
  }
  const groups = {};
  jobs.forEach((j) => { const k = j.created ? dayKey(j.created) : '~'; (groups[k] = groups[k] || []).push(j); });
  const keys = Object.keys(groups).sort((a, b) => (a === '~' ? 1 : b === '~' ? -1 : b.localeCompare(a))); // ใหม่→เก่า, ไม่ระบุไว้ท้าย
  $('filesOut').innerHTML = keys.map((k) => {
    const label = k === '~' ? 'ไม่ระบุวันที่' : thaiDay(groups[k][0].created);
    return `<div class="date-group"><div class="date-head">📅 ${label}</div>
      <div class="files">${groups[k].map(fileCard).join('')}</div></div>`;
  }).join('');
  bindFileCards($('filesOut'));
}

// ---------- หน้า: แฟ้มที่ยังไม่ตัดงบ ----------
function renderPending() {
  const pend = fileStats().filter((f) => fileStatus(f) === 'none');
  if (!pend.length) { $('pendingOut').innerHTML = `<div class="list-empty"><span class="ok">${ic('check')}</span> ทุกแฟ้มเริ่มตัดงบแล้ว</div>`; return; }
  $('pendingOut').innerHTML = `<div class="files">${pend.map(fileCard).join('')}</div>`;
  bindFileCards($('pendingOut'));
}

// ---------- หน้า: ค้นหางบที่เหลือ (ข้อ 6) ----------
// แสดงหมวดงบที่ยังมีคงเหลือ > 0 และ WBS ยังมีงบรวมคงเหลือ > 0 — กรอง+เรียง+กดเปิดใบตัด
function renderRemaining() {
  const jobByWbs = {};
  jobStats().forEach((j) => { jobByWbs[j.wbs] = j; });
  const allCats = [...new Set(budgets.map((b) => b.category))].sort();
  if (remainCats === null) remainCats = new Set(allCats); // ครั้งแรก = เลือกทุกหมวด

  const rows = budgets.filter((b) => {
    const j = jobByWbs[b.wbs];
    if (!(b.balance > 0)) return false;               // คงเหลือหมวด > 0
    if (!j || !(jobRemain(j) > 0)) return false;      // งบรวมทั้ง WBS ยังเหลือ > 0
    if (!remainCats.has(b.category)) return false;
    const isPea = j.oper === 'กฟภ.';
    if (remainOper === 'pea' && !isPea) return false;
    if (remainOper === 'co' && (isPea || !j.oper)) return false;
    return true;
  }).map((b) => {
    const j = jobByWbs[b.wbs];
    return { b, fileCode: j.fileCode, node: extractNode(b.wbs), dept: b.dept, category: b.category,
             allocation: b.allocation, paid: b.paid, balance: b.balance, oper: j.oper, wbs: b.wbs };
  });

  const { col, dir } = remainSort;
  rows.sort((a, x) => {
    const va = a[col], vx = x[col];
    return (typeof va === 'number' ? va - vx : String(va).localeCompare(String(vx))) * dir;
  });

  const catChips = allCats.map((c) =>
    `<label class="rc-chip ${remainCats.has(c) ? 'on' : ''}"><input type="checkbox" data-cat="${esc(c)}" ${remainCats.has(c) ? 'checked' : ''} hidden>${esc(c)}</label>`).join('');
  const operSeg = [['all', 'ทั้งหมด'], ['pea', 'กฟภ.'], ['co', 'บริษัท']].map(([v, l]) =>
    `<button data-oper="${v}" class="${remainOper === v ? 'on' : ''}">${l}</button>`).join('');

  const COLS = [['fileCode', 'รหัสแฟ้ม'], ['wbs', 'WBS'], ['node', 'โหนด'], ['dept', 'แผนก'], ['category', 'หมวดงบ'],
    ['allocation', 'ยอดจัดสรร', 1], ['paid', 'จ่ายแล้ว', 1], ['balance', 'คงเหลือ', 1], ['oper', 'ผู้ดำเนินการ']];
  const head = COLS.map(([c, l, num]) =>
    `<th data-sort="${c}" class="rc-th${num ? ' num' : ''}">${l}${col === c ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
  const body = rows.map((r, i) =>
    `<tr data-i="${i}"><td class="mono">${esc(r.fileCode)}</td><td class="mono">${esc(r.wbs)}</td>
      <td>${esc(r.node || '—')}</td><td>${esc(r.dept)}</td><td>${esc(r.category)}</td>
      <td class="num">${fmt(r.allocation)}</td><td class="num">${fmt(r.paid)}</td>
      <td class="num">${fmt(r.balance)}</td><td>${esc(r.oper || '—')}</td></tr>`).join('');

  $('remainOut').innerHTML = `
    <div class="rc-filters">
      <div class="rc-group"><span class="rc-lbl">หมวดงบ</span><div class="rc-chips">${catChips}</div></div>
      <div class="rc-group"><span class="rc-lbl">ผู้ดำเนินการ</span><div class="seg">${operSeg}</div></div>
    </div>
    ${rows.length
      ? `<div class="net"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
         <div class="sub" style="margin-top:8px">พบ ${rows.length} หมวดที่ยังมีงบเหลือ — กดที่แถวเพื่อเปิดใบตัด</div>`
      : `<div class="list-empty">ไม่พบหมวดงบที่ตรงเงื่อนไข</div>`}`;

  $('remainOut').querySelectorAll('[data-cat]').forEach((cb) =>
    cb.addEventListener('change', () => { cb.checked ? remainCats.add(cb.dataset.cat) : remainCats.delete(cb.dataset.cat); renderRemaining(); }));
  $('remainOut').querySelectorAll('[data-oper]').forEach((btn) =>
    btn.addEventListener('click', () => { remainOper = btn.dataset.oper; renderRemaining(); }));
  $('remainOut').querySelectorAll('[data-sort]').forEach((th) =>
    th.addEventListener('click', () => { const c = th.dataset.sort; remainSort = { col: c, dir: remainSort.col === c ? -remainSort.dir : 1 }; renderRemaining(); }));
  $('remainOut').querySelectorAll('tbody tr').forEach((tr) =>
    tr.addEventListener('click', () => openSlip(rows[+tr.dataset.i].b)));
}

// ---------- ชิ้นส่วนกราฟ (inline SVG/CSS ล้วน — ไม่พึ่ง lib) ----------
// โดนัท conic-gradient + ตัวเลขกลางวง
function donut(gradient, v, l) {
  return `<div class="donut" style="background:${gradient}">
    <div class="donut-c"><div class="v">${v}</div><div class="l">${l}</div></div></div>`;
}

// โดนัทสถานะแฟ้ม 3 สี (สี status + legend มี label — ไม่พึ่งสีอย่างเดียว)
function statusDonut(t) {
  const total = t.none + t.part + t.done;
  const a = total ? (t.none / total) * 360 : 0;
  const b = total ? ((t.none + t.part) / total) * 360 : 0;
  const grad = total
    ? `conic-gradient(var(--err) 0 ${a}deg, var(--warn) ${a}deg ${b}deg, var(--ok) ${b}deg 360deg)`
    : 'conic-gradient(var(--line) 0 360deg)';
  return donut(grad, total, 'แฟ้ม') + `<div class="legend">
    <div class="li"><span class="sw" style="background:var(--err)"></span>ยังไม่ตัด<b>${t.none}</b></div>
    <div class="li"><span class="sw" style="background:var(--warn)"></span>กำลังตัด<b>${t.part}</b></div>
    <div class="li"><span class="sw" style="background:var(--ok)"></span>เบิกครบ<b>${t.done}</b></div></div>`;
}

// แท่งแนวนอน: ความยาว ∝ value (งบจัดสรร), ส่วนเข้ม = filled (ตัดไปแล้ว), ส่วนอ่อน = คงเหลือ
// ponytail: ไม่มี 2px gap ระหว่าง segment (โดนัท/แท่ง) — legend+สีต่างพอแล้ว
function hbars(items) {
  const max = items.reduce((m, i) => Math.max(m, i.value), 0) || 1;
  return `<div class="bars">${items.map((i) => {
    const w = (i.value / max) * 100, pw = i.value > 0 ? (i.filled / i.value) * 100 : 0;
    const attrs = i.wbs ? `class="bar-row bar-clickable" data-job="${esc(i.wbs)}"` : 'class="bar-row"';
    return `<div ${attrs}>
      <div class="bl"><span>${esc(i.label)}</span><span class="bv">${fmt(i.value)}</span></div>
      <div class="bar-track" style="width:${w.toFixed(1)}%"><div class="bar-fill" style="width:${pw.toFixed(1)}%"></div></div>
    </div>`;
  }).join('')}</div>`;
}

const barLegend = `<div class="leg-row">
  <span><i style="background:var(--primary)"></i>ตัดไปแล้ว</span>
  <span><i style="background:var(--line)"></i>คงเหลือ</span></div>`;

// โดนัท 2 ใบ (ความคืบหน้า + สถานะ) — ใช้ร่วมทุกโหมด
function donutsRow(t) {
  const pct = t.alloc > 0 ? (t.paid / t.alloc) * 100 : 0;
  return `<div class="dash-charts">
    <div class="chart-card"><h3>ความคืบหน้าตัดงบรวม</h3>
      ${donut(`conic-gradient(var(--primary) ${pct.toFixed(1)}%, var(--line) 0)`, `${Math.round(pct)}%`, 'ตัดแล้ว')}
      <div class="legend">
        <div class="li"><span class="sw" style="background:var(--primary)"></span>ตัดไปแล้ว<b>${fmt(t.paid)}</b></div>
        <div class="li"><span class="sw" style="background:var(--line)"></span>คงเหลือ<b>${fmt(t.bal)}</b></div>
      </div>
    </div>
    <div class="chart-card"><h3>สถานะแฟ้มงาน</h3>${statusDonut(t)}</div>
  </div>`;
}

// ---------- หน้า: Dashboard (รวม / แยกเดือน / แยกปี) ----------
function renderDashboard() {
  const modes = [['sum', 'รวม'], ['month', 'แยกเดือน'], ['year', 'แยกปี']];
  const seg = `<div class="seg">${modes.map(([m, l]) =>
    `<button class="${m === dashMode ? 'on' : ''}" data-mode="${m}">${l}</button>`).join('')}</div>`;
  $('dashOut').innerHTML = seg + (dashMode === 'sum' ? dashSum() : dashByPeriod(dashMode));
  $('dashOut').querySelector('.seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]'); if (b) { dashMode = b.dataset.mode; renderDashboard(); }
  });
  $('dashOut').querySelectorAll('[data-job]').forEach((el) =>
    el.addEventListener('click', () => openJob(el.dataset.job)));
}

// ยอดรวมทั้งหมด (KPI)
function dashSum() {
  const jobs = jobStats();
  const t = periodTotal(jobs);
  const pct = t.alloc > 0 ? (t.paid / t.alloc) * 100 : 0;
  return `<div class="kpis">
      <div class="kpi"><div class="v">${jobs.length}</div><div class="l">แฟ้มงานทั้งหมด</div></div>
      <div class="kpi"><div class="v">${fmt(t.alloc)}</div><div class="l">งบจัดสรรรวม</div></div>
      <div class="kpi"><div class="v">${fmt(t.paid)}</div><div class="l">ตัดไปแล้ว (${Math.round(pct)}%)</div></div>
      <div class="kpi ${t.bal < 0 ? 'err' : 'ok'}"><div class="v">${fmt(t.bal)}</div><div class="l">คงเหลือ</div></div>
    </div>
    <div class="kpis">
      <div class="kpi err"><div class="v">${t.none}</div><div class="l">ยังไม่ตัดงบ</div></div>
      <div class="kpi"><div class="v" style="color:var(--warn)">${t.part}</div><div class="l">กำลังตัด</div></div>
      <div class="kpi ok"><div class="v">${t.done}</div><div class="l">เบิกครบแล้ว</div></div>
      <div class="kpi"><div class="v">${jobs.reduce((s, j) => s + j.cats, 0)}</div><div class="l">หมวดงบรวม</div></div>
    </div>
    ${donutsRow(t)}
    ${topCard(jobs)}`;
}

// การ์ดแท่ง Top แฟ้มงบสูงสุด (คลิกแท่ง = เข้าแฟ้ม)
function topCard(jobs) {
  const top = jobs.slice().sort((a, b) => b.alloc - a.alloc).slice(0, 8);
  if (!top.length) return '';
  return `<div class="chart-card"><h3>แฟ้มงบสูงสุด (Top ${top.length})</h3>${barLegend}
    ${hbars(top.map((j) => ({ label: j.workName || j.wbs, value: j.alloc, filled: j.paid, wbs: j.wbs })))}</div>`;
}

// สรุปตามงวด (เดือน/ปี ของวันที่สร้างแฟ้ม)
function dashByPeriod(mode) {
  const buckets = {};
  jobStats().forEach((j) => {
    const key = !j.created ? '~' : mode === 'year' ? String(j.created.getFullYear())
      : `${j.created.getFullYear()}-${String(j.created.getMonth() + 1).padStart(2, '0')}`;
    (buckets[key] = buckets[key] || []).push(j);
  });
  const keys = Object.keys(buckets).sort((a, b) => (a === '~' ? 1 : b === '~' ? -1 : b.localeCompare(a)));
  const periodLabel = (k, j) => k === '~' ? 'ไม่ระบุวันที่'
    : mode === 'year' ? `พ.ศ. ${+k + 543}` : `${TH_MONTH[j.created.getMonth()]} ${j.created.getFullYear() + 543}`;

  let rows = '';
  keys.forEach((k) => {
    const t = periodTotal(buckets[k]);
    rows += `<tr><td>${esc(periodLabel(k, buckets[k][0]))}</td><td class="num">${buckets[k].length}</td>
      <td class="num">${fmt(t.alloc)}</td><td class="num">${fmt(t.paid)}</td>
      <td class="num ${t.bal < 0 ? 'err' : ''}">${fmt(t.bal)}</td>
      <td class="num ${t.none ? 'err' : ''}">${t.none || '—'}</td></tr>`;
  });
  const g = periodTotal(jobStats());
  const foot = `<tr style="font-weight:700;background:var(--surface-soft)"><td>รวมทั้งหมด</td><td class="num">${jobStats().length}</td>
    <td class="num">${fmt(g.alloc)}</td><td class="num">${fmt(g.paid)}</td>
    <td class="num ${g.bal < 0 ? 'err' : ''}">${fmt(g.bal)}</td><td class="num">${g.none || '—'}</td></tr>`;

  const chartItems = keys.map((k) => {
    const t = periodTotal(buckets[k]);
    return { label: periodLabel(k, buckets[k][0]), value: t.alloc, filled: t.paid };
  });
  const chart = `<div class="chart-card"><h3>ตัดไปแล้ว vs คงเหลือ ราย${mode === 'year' ? 'ปี' : 'เดือน'}</h3>
    ${barLegend}${hbars(chartItems)}</div>`;

  return donutsRow(g) + chart + `<div class="net"><table>
    <thead><tr><th>${mode === 'year' ? 'ปี' : 'เดือน'}</th><th class="num">แฟ้ม</th>
      <th class="num">จัดสรร</th><th class="num">ตัดไปแล้ว</th><th class="num">คงเหลือ</th><th class="num">ยังไม่ตัด</th></tr></thead>
    <tbody>${rows}${foot}</tbody></table></div>`;
}

// รวมยอด + นับสถานะ จากชุดแฟ้ม
function periodTotal(jobs) {
  const t = { alloc: 0, paid: 0, bal: 0, none: 0, part: 0, done: 0 };
  jobs.forEach((j) => { t.alloc += j.alloc; t.paid += j.paid; t.bal += j.bal; t[jobStatus(j)]++; });
  return t;
}

// เข้าหน้ารายละเอียดแฟ้ม — รับ WBS ของโหนด → เปิดที่ระดับแฟ้ม (base) โหมด "ทั้งหมด"
function openJob(wbs) {
  flashCutKey = null; // เข้าแฟ้มใหม่ = เลิกไฮไลต์ก้อนที่เคยตัด
  selectedBase = parseWbs(wbs).base;
  selectedNode = 'ALL';
  showPanel('job');
  renderDetail();
}

function renderDetail() {
  const file = fileStats().find((f) => f.base === selectedBase);
  if (!file) { $('detailOut').innerHTML = '<div class="card">ไม่พบแฟ้มนี้</div>'; return; }
  const nodes = file.nodes; // per-WBS jobStats เรียงตามโหนด
  const multi = nodes.length > 1;
  // ถ้าโหนดที่เลือกไม่มีแล้ว (เช่นเพิ่งลบ) → กลับไป ALL
  if (selectedNode !== 'ALL' && !nodes.some((n) => n.wbs === selectedNode)) selectedNode = 'ALL';
  const active = selectedNode === 'ALL' ? nodes : nodes.filter((n) => n.wbs === selectedNode);

  // เกจ % รวมทั้งแฟ้ม
  const fBase = nodes.reduce((s, n) => s + jobBase(n), 0);
  const fPaid = nodes.reduce((s, n) => s + n.paid, 0);
  const pct = fBase > 0 ? Math.min(100, (fPaid / fBase) * 100) : 0;
  const isC = file.type === 'C';

  let html = `<div class="back-bar"><button class="btn sec" id="backFiles">← กลับหน้าเลือกแฟ้มงาน</button>
    ${multi ? `<button class="btn sec" id="delFileAll" style="margin-left:auto;color:var(--err)">${ic('trash')}ลบทั้งแฟ้ม (${nodes.length} โหนด)</button>` : ''}</div>
  <div class="detail-head">
    <div style="flex:1">
      <div class="dh-kicker">${isC ? 'หมายเลขงานหลัก (WBS base)' : 'หมายเลขงาน (WBS)'}</div>
      <div class="dh-title">${esc(file.base)}</div>
      <div class="chips">${file.fileCode ? `<span class="chip">รหัสแฟ้ม ${esc(file.fileCode)}</span>` : ''}<span class="chip">งบ ${esc(file.type)}</span><span class="chip">${nodes.length} โหนด</span></div>
    </div>
    <div class="gauge" style="--pct:${pct.toFixed(1)};--gc:var(--primary)">
      <div class="g-v">${Math.round(pct)}%</div><div class="g-l">เบิกแล้ว</div></div>
  </div>`;

  // ตัวเลือกโหนด (ทั้งหมด / แต่ละโหนด) — โชว์เมื่อมีหลายโหนด
  if (multi) {
    html += `<div class="seg node-seg"><button data-node="ALL" class="${selectedNode === 'ALL' ? 'on' : ''}">ทั้งหมด</button>${nodes.map((n) => {
      const w = parseWbs(n.wbs);
      return `<button data-node="${esc(n.wbs)}" class="${selectedNode === n.wbs ? 'on' : ''}">${esc(w.node)}${w.ownership ? ' ' + esc(ownerLabel(w.ownership)) : ''}</button>`;
    }).join('')}</div>`;
  }

  html += active.map((n) => renderNodeBlock(n, multi)).join('');
  $('detailOut').innerHTML = html;

  // events (ใช้ data-attr เพราะมีหลายโหนด)
  $('backFiles').addEventListener('click', () => goPanel('files'));
  if ($('delFileAll')) $('delFileAll').addEventListener('click', () => askDeleteFileAll(file.base, nodes.length));
  document.querySelectorAll('[data-node]').forEach((btn) =>
    btn.addEventListener('click', () => { selectedNode = btn.dataset.node; renderDetail(); }));
  document.querySelectorAll('[data-editwbs]').forEach((btn) => btn.addEventListener('click', () => editWbs(btn.dataset.editwbs)));
  document.querySelectorAll('[data-editoper]').forEach((btn) => btn.addEventListener('click', () => editOper(btn.dataset.editoper, budgets.find((b) => b.wbs === btn.dataset.editoper)?.oper || '')));
  document.querySelectorAll('[data-editwt]').forEach((btn) => btn.addEventListener('click', () => editWbsTotal(btn.dataset.editwt, nodeByWbs(btn.dataset.editwt).wbsTotal)));
  document.querySelectorAll('[data-delnode]').forEach((btn) => btn.addEventListener('click', () => askDeleteFile(btn.dataset.delnode)));
  document.querySelectorAll('[data-editnet]').forEach((btn) => btn.addEventListener('click', () => editNetwork(btn.dataset.wbs, btn.dataset.editnet)));
  document.querySelectorAll('[data-delnet]').forEach((btn) => btn.addEventListener('click', () => askDeleteNetwork(btn.dataset.wbs, btn.dataset.delnet)));
  document.querySelectorAll('[data-cut]').forEach((btn) => btn.addEventListener('click', () => openSlip(budgets[+btn.dataset.cut])));
  document.querySelectorAll('[data-sum]').forEach((btn) => btn.addEventListener('click', () => openSummary(budgets[+btn.dataset.sum])));
}

const nodeByWbs = (wbs) => jobStats().find((x) => x.wbs === wbs);

// 1 โหนด (block) — ผู้ดำเนินการ/ยอดจัดสรร/KPI/โครงข่าย + ปุ่มเดิม (target = WBS ของโหนด)
function renderNodeBlock(j, multi) {
  const w = parseWbs(j.wbs);
  const shown = budgets.filter((b) => b.wbs === j.wbs);
  const wbsRemain = jobRemain(j);
  const fk = flashCutKey;
  const delLabel = w.node ? 'ลบโหนด' : 'ลบแฟ้ม';

  let html = `<div class="node-block">`;
  // หัวโหนด: WBS เต็ม + chips โหนด/งบของ + ปุ่ม แก้ WBS / ลบโหนด
  html += `<div class="node-head">
    <div style="flex:1"><div class="nb-wbs">${esc(j.wbs)} <button class="link-edit" data-editwbs="${esc(j.wbs)}">${ic('edit')}แก้</button></div>
      <div class="chips">${w.node ? `<span class="chip">โหนด ${esc(w.node)}</span>` : ''}${budgetOfLabel(w.budgetOf) ? `<span class="chip">${esc(budgetOfLabel(w.budgetOf))}</span>` : ''}<span class="chip">${j.nets.size} โครงข่าย · ${j.cats} หมวดงบ</span></div></div>
    <button class="btn sec" data-delnode="${esc(j.wbs)}" style="color:var(--err);flex:none">${ic('trash')}${delLabel}</button>
  </div>`;

  // ผู้ดำเนินการ + ยอดจัดสรรรวม (แก้ได้)
  html += `<div class="wbs-total">
    <div><span class="l">ผู้ดำเนินการ</span>
      <span class="v">${j.oper ? esc(j.oper) : '<i style="color:var(--warn,#b8860b)">ยังไม่ระบุ</i>'}</span></div>
    <button class="btn sec" data-editoper="${esc(j.wbs)}">${ic('edit')}แก้</button>
  </div>
  <div class="wbs-total">
    <div><span class="l">ยอดจัดสรรรวมทั้งงาน (จาก ZPSR018)</span>
      <span class="v">${j.wbsTotal != null ? fmt(j.wbsTotal) + ' บาท' : '<i style="color:var(--warn,#b8860b)">ยังไม่มี — กดแก้เพื่อกรอกมือ</i>'}</span></div>
    <button class="btn sec" data-editwt="${esc(j.wbs)}">${ic('edit')}แก้ยอด</button>
  </div>`;

  // KPI
  html += `<div class="kpis">
    <div class="kpi"><div class="v">${fmt(j.alloc)}</div><div class="l">รวมทุกงบ</div></div>
    <div class="kpi"><div class="v">${j.wbsTotal != null ? fmt(j.wbsTotal) : '—'}</div><div class="l">ยอดจัดสรรรวม</div></div>
    <div class="kpi"><div class="v">${fmt(j.paid)}</div><div class="l">จ่ายแล้วรวม</div></div>
    <div class="kpi ${wbsRemain < 0 ? 'err' : 'ok'}"><div class="v">${fmt(wbsRemain)}</div><div class="l">ยอดงบจัดสรรคงเหลือ</div></div>
    <div class="kpi"><div class="v">${shown.filter((b) => b.balance > 0).length}/${shown.length}</div><div class="l">หมวดที่เปิดใบตัดได้</div></div>
  </div>`;

  // ตารางงบตามโครงข่าย
  const byNet = {};
  shown.forEach((b) => { (byNet[b.network + '|' + b.dept] = byNet[b.network + '|' + b.dept] || []).push(b); });
  for (const grp of Object.keys(byNet)) {
    const [network, dept] = grp.split('|');
    html += `<div class="net"><h2>โครงข่าย ${esc(network)}<span class="dept">${esc(dept)}</span>
        <button class="btn sec net-edit" data-editnet="${esc(network)}" data-wbs="${esc(j.wbs)}" style="padding:5px 10px;font-size:12px">${ic('edit')}แก้เลข</button>
        <button class="btn sec net-del" data-delnet="${esc(network)}" data-wbs="${esc(j.wbs)}" style="color:var(--err);padding:5px 10px;font-size:12px">${ic('trash')}ลบโครงข่าย</button></h2>
      <table><thead><tr><th>หมวดงบ</th><th>เลขกิจ</th><th class="num">ยอดจัดสรร</th><th class="num">จ่ายแล้ว</th><th class="num">คงเหลือ</th><th></th></tr></thead><tbody>`;
    for (const b of byNet[grp]) {
      const i = budgets.indexOf(b);
      const canCut = b.balance > 0;
      const flashCls = b.key === fk ? ' class="row-just"' : '';
      html += `<tr${flashCls}><td>${esc(b.category)}</td><td class="act">${esc(b.act)}</td>
        <td class="num">${fmt(b.allocation)}</td><td class="num">${fmt(b.paid)}</td>
        <td class="num ${b.balance < 0 ? 'err' : ''}">${fmt(b.balance)}</td>
        <td><div class="row-actions"><button class="btn sec" data-sum="${i}">สรุป/งวด</button>
          <button class="btn sec" data-cut="${i}" ${canCut ? '' : 'disabled'}>เปิดใบตัด</button></div></td></tr>`;
    }
    html += `</tbody></table></div>`;
  }
  return html + `</div>`;
}

// ---------- แก้ยอดจัดสรรรวมทั้งงานด้วยมือ (fallback ถ้าดึงจาก PDF ไม่ได้) ----------
function editWbsTotal(wbs, current) {
  $('modalBox').innerHTML = `<h3>${ic('edit')}แก้ยอดจัดสรรรวมทั้งงาน</h3>
    <div class="sub">หมายเลขงาน (WBS) <b>${esc(wbs)}</b></div>
    <div class="field" style="margin-top:12px"><label>ยอดจัดสรรรวม (บาท)</label>
      <input type="number" step="0.01" min="0" id="wtVal" value="${current != null ? current : ''}" placeholder="เช่น 219400.00"></div>
    <div id="wtErr" class="err"></div>
    <div class="modal-actions">
      <button class="btn sec" id="wtCancel">ยกเลิก</button>
      <button class="btn" id="wtSave">${ic('check')}บันทึก</button>
    </div>`;
  $('modal').classList.add('show');
  $('wtCancel').addEventListener('click', closeModal);
  $('wtSave').addEventListener('click', () => saveWbsTotal(wbs));
  $('wtVal').focus();
}

async function saveWbsTotal(wbs) {
  const raw = $('wtVal').value.trim();
  const val = Number(raw);
  if (raw === '' || isNaN(val) || val < 0) { $('wtErr').textContent = 'กรอกยอดเป็นตัวเลข ≥ 0'; return; }
  const btn = $('wtSave'); btn.disabled = true;
  try {
    await callApi('setWbsTotal', { wbs, total: val });
    closeModal();
    await loadBudgets(); // รีเฟรช → renderDetail แสดงยอดใหม่
  } catch (err) {
    $('wtErr').textContent = 'บันทึกไม่สำเร็จ: ' + err.message;
    btn.disabled = false;
  }
}

// ---------- แก้ผู้ดำเนินการ (ข้อ 5) ----------
function editOper(wbs, current) {
  const companies = settings['บริษัท'] || [];
  $('modalBox').innerHTML = `<h3>${ic('edit')}แก้ผู้ดำเนินการ</h3>
    <div class="sub">หมายเลขงาน (WBS) <b>${esc(wbs)}</b></div>
    ${operPickerHtml(current)}
    <div id="opErr" class="err"></div>
    <div class="modal-actions">
      <button class="btn sec" id="opCancel">ยกเลิก</button>
      <button class="btn" id="opSave">${ic('check')}บันทึก</button>
    </div>`;
  $('modal').classList.add('show');
  bindOperPicker();
  $('opCancel').addEventListener('click', closeModal);
  $('opSave').addEventListener('click', async () => {
    const oper = readOper();
    if (!oper) { $('opErr').textContent = 'เลือกผู้ดำเนินการก่อน'; return; }
    const btn = $('opSave'); btn.disabled = true;
    try { await callApi('setOper', { wbs, oper }); closeModal(); await loadBudgets(); }
    catch (err) { $('opErr').textContent = 'บันทึกไม่สำเร็จ: ' + err.message; btn.disabled = false; }
  });
}

// ---------- แก้ WBS (ข้อ 3 — กรณีระบบอ่านผิด) ----------
function editWbs(oldWbs) {
  $('modalBox').innerHTML = `<h3>${ic('edit')}แก้หมายเลขงาน (WBS)</h3>
    <div class="sub">ของเดิม <b>${oldWbs ? esc(oldWbs) : '(ยังไม่มี — อ่านไม่ได้ตอน import)'}</b> — แก้แล้วจะเปลี่ยนทุกก้อนงบ/ใบตัดของแฟ้มนี้</div>
    <div class="field" style="margin-top:12px"><label>WBS ใหม่</label>
      <input id="ewVal" value="${esc(oldWbs)}"></div>
    <div id="ewErr" class="err"></div>
    <div class="modal-actions">
      <button class="btn sec" id="ewCancel">ยกเลิก</button>
      <button class="btn" id="ewSave">${ic('check')}บันทึก</button>
    </div>`;
  $('modal').classList.add('show');
  $('ewCancel').addEventListener('click', closeModal);
  $('ewSave').addEventListener('click', async () => {
    const newWbs = $('ewVal').value.trim();
    if (!newWbs) { $('ewErr').textContent = 'กรอก WBS ใหม่'; return; }
    if (newWbs === oldWbs) { closeModal(); return; }
    const btn = $('ewSave'); btn.disabled = true;
    try {
      await callApi('editWbs', { oldWbs, newWbs });
      selectedBase = parseWbs(newWbs).base; // ตามไปดูแฟ้มที่เปลี่ยนเลขแล้ว
      if (selectedNode === oldWbs) selectedNode = newWbs;
      closeModal();
      await loadBudgets();
    } catch (err) { $('ewErr').textContent = 'บันทึกไม่สำเร็จ: ' + err.message; btn.disabled = false; }
  });
  $('ewVal').focus();
}

// ---------- แก้หมายเลขโครงข่าย (ยืนยัน 2 ชั้น + รหัสผ่าน) — เปลี่ยนทุกก้อนงบ/ใบตัดของโครงข่ายนี้ ----------
function editNetwork(wbs, oldNet) {
  $('modalBox').innerHTML = `<h3>${ic('edit')}แก้หมายเลขโครงข่าย</h3>
    <div class="sub">ของเดิม <b>${esc(oldNet)}</b> ในแฟ้ม <b>${esc(wbs)}</b> — แก้แล้วจะเปลี่ยนทุกก้อนงบ/ใบตัดของโครงข่ายนี้</div>
    <div class="field" style="margin-top:12px"><label>หมายเลขโครงข่ายใหม่</label>
      <input id="enVal" value="${esc(oldNet)}"></div>
    <div id="enErr" class="err"></div>
    <div class="modal-actions">
      <button class="btn sec" id="enCancel">ยกเลิก</button>
      <button class="btn" id="enNext">ดำเนินการต่อ →</button>
    </div>`;
  $('modal').classList.add('show');
  $('enCancel').addEventListener('click', closeModal);
  $('enNext').addEventListener('click', () => {
    const newNet = $('enVal').value.trim();
    if (!newNet) { $('enErr').textContent = 'กรอกหมายเลขโครงข่ายใหม่'; return; }
    if (newNet === oldNet) { closeModal(); return; }
    editNetworkPassword(wbs, oldNet, newNet);
  });
  $('enVal').focus();
}

function editNetworkPassword(wbs, oldNet, newNet) {
  $('modalBox').innerHTML = `<h3>${ic('lock')}ยืนยันการแก้ไข</h3>
    <div class="sub">ใส่รหัสผ่านเพื่อเปลี่ยนโครงข่าย <b>${esc(oldNet)}</b> → <b>${esc(newNet)}</b></div>
    <div class="field" style="margin-top:12px"><label>รหัสผ่าน</label>
      <input type="password" id="enPw" autocomplete="off"></div>
    <div id="enErr" class="err"></div>
    <div class="modal-actions">
      <button class="btn sec" id="enCancel2">ยกเลิก</button>
      <button class="btn" id="enSave">${ic('check')}บันทึก</button>
    </div>`;
  $('enCancel2').addEventListener('click', closeModal);
  $('enSave').addEventListener('click', async () => {
    const btn = $('enSave'); btn.disabled = true; $('enErr').textContent = '';
    try {
      await callApi('editNetwork', { wbs, oldNet, newNet, password: $('enPw').value });
      closeModal();
      await loadBudgets();
    } catch (err) { $('enErr').textContent = 'บันทึกไม่สำเร็จ: ' + err.message; btn.disabled = false; }
  });
  $('enPw').focus();
}

// ---------- ลบแฟ้มงาน (ยืนยัน 2 ชั้น + รหัสผ่าน) ----------
function askDeleteFile(wbs) {
  const shown = budgets.filter((b) => b.wbs === wbs);
  const hasCut = shown.some((b) => b.paid > 0);
  $('modalBox').innerHTML = `<h3><span style="color:var(--err)">${ic('alert')}</span>ลบแฟ้มงาน</h3>
    <div class="sub">หมายเลขงาน (WBS) <b>${esc(wbs)}</b></div>
    <div class="warn" style="margin:12px 0">จะลบก้อนงบ ${shown.length} หมวด${hasCut ? ' + ใบตัดทุกใบของแฟ้มนี้' : ''} ออกถาวร — กู้คืนไม่ได้</div>
    <div class="modal-actions">
      <button class="btn sec" id="delCancel">ยกเลิก</button>
      <button class="btn" id="delNext" style="background:var(--err)">ดำเนินการต่อ →</button>
    </div>`;
  $('modal').classList.add('show');
  $('delCancel').addEventListener('click', closeModal);
  $('delNext').addEventListener('click', () => askDeletePassword(wbs));
}

function askDeletePassword(wbs) {
  $('modalBox').innerHTML = `<h3>${ic('lock')}ยืนยันการลบ</h3>
    <div class="sub">ใส่รหัสผ่านเพื่อลบแฟ้ม <b>${esc(wbs)}</b> ถาวร</div>
    <div class="field" style="margin-top:12px"><label>รหัสผ่าน</label>
      <input type="password" id="delPw" autocomplete="off"></div>
    <div id="delErr" class="err"></div>
    <div class="modal-actions">
      <button class="btn sec" id="delCancel2">ยกเลิก</button>
      <button class="btn" id="delDo" style="background:var(--err)">${ic('trash')}ลบถาวร</button>
    </div>`;
  $('delCancel2').addEventListener('click', closeModal);
  $('delDo').addEventListener('click', () => doDeleteFile(wbs));
  $('delPw').focus();
}

async function doDeleteFile(wbs) {
  if ($('delPw').value !== '509758') { $('delErr').textContent = 'รหัสผ่านไม่ถูกต้อง'; return; }
  const btn = $('delDo'); btn.disabled = true; $('delErr').textContent = '';
  try {
    const r = await callApi('deleteFile', { wbs, password: $('delPw').value });
    closeModal();
    await loadBudgets();
    const flash = `<div class="flash ok">${ic('check')}ลบ ${esc(wbs)} แล้ว (งบ ${r.budgets} หมวด, ใบตัด ${r.slips} ใบ)</div>`;
    // ยังมีโหนดอื่นในแฟ้ม → อยู่ในแฟ้มเดิม; ไม่งั้นกลับหน้าเลือกแฟ้ม
    if (budgets.some((b) => parseWbs(b.wbs).base === selectedBase)) { $('detailOut').insertAdjacentHTML('afterbegin', flash); }
    else { goPanel('files'); $('filesOut').insertAdjacentHTML('afterbegin', flash); }
  } catch (err) {
    btn.disabled = false;
    $('delErr').textContent = err.message;
  }
}

// ---------- ลบทั้งแฟ้ม (ทุกโหนดของ base) — ยืนยัน 2 ชั้น + รหัสผ่าน ----------
function askDeleteFileAll(base, nodeCount) {
  const rows = budgets.filter((b) => parseWbs(b.wbs).base === base);
  const hasCut = rows.some((b) => b.paid > 0);
  $('modalBox').innerHTML = `<h3><span style="color:var(--err)">${ic('alert')}</span>ลบทั้งแฟ้ม</h3>
    <div class="sub">หมายเลขงานหลัก <b>${esc(base)}</b></div>
    <div class="warn" style="margin:12px 0">จะลบ <b>ทุกโหนด (${nodeCount} โหนด)</b> — ก้อนงบ ${rows.length} หมวด${hasCut ? ' + ใบตัดทุกใบของแฟ้มนี้' : ''} ออกถาวร กู้คืนไม่ได้</div>
    <div class="modal-actions">
      <button class="btn sec" id="dfaCancel">ยกเลิก</button>
      <button class="btn" id="dfaNext" style="background:var(--err)">ดำเนินการต่อ →</button>
    </div>`;
  $('modal').classList.add('show');
  $('dfaCancel').addEventListener('click', closeModal);
  $('dfaNext').addEventListener('click', () => askDeleteFileAllPassword(base));
}

function askDeleteFileAllPassword(base) {
  $('modalBox').innerHTML = `<h3>${ic('lock')}ยืนยันการลบ</h3>
    <div class="sub">ใส่รหัสผ่านเพื่อลบทั้งแฟ้ม <b>${esc(base)}</b> (ทุกโหนด) ถาวร</div>
    <div class="field" style="margin-top:12px"><label>รหัสผ่าน</label>
      <input type="password" id="dfaPw" autocomplete="off"></div>
    <div id="dfaErr" class="err"></div>
    <div class="modal-actions">
      <button class="btn sec" id="dfaCancel2">ยกเลิก</button>
      <button class="btn" id="dfaDo" style="background:var(--err)">${ic('trash')}ลบถาวร</button>
    </div>`;
  $('dfaCancel2').addEventListener('click', closeModal);
  $('dfaDo').addEventListener('click', () => doDeleteFileAll(base));
  $('dfaPw').focus();
}

async function doDeleteFileAll(base) {
  if ($('dfaPw').value !== '509758') { $('dfaErr').textContent = 'รหัสผ่านไม่ถูกต้อง'; return; }
  const btn = $('dfaDo'); btn.disabled = true; $('dfaErr').textContent = '';
  try {
    const r = await callApi('deleteFileAll', { base, password: $('dfaPw').value });
    closeModal();
    goPanel('files');
    await loadBudgets();
    $('filesOut').insertAdjacentHTML('afterbegin',
      `<div class="flash ok">${ic('check')}ลบทั้งแฟ้ม ${esc(base)} แล้ว (งบ ${r.budgets} หมวด, ใบตัด ${r.slips} ใบ)</div>`);
  } catch (err) {
    btn.disabled = false;
    $('dfaErr').textContent = err.message;
  }
}

// ---------- ลบเลขโครงข่าย (ยืนยัน 2 ชั้น + รหัสผ่าน) ----------
function askDeleteNetwork(wbs, network) {
  const shown = budgets.filter((b) => b.wbs === wbs && b.network === network);
  const hasCut = shown.some((b) => b.paid > 0);
  $('modalBox').innerHTML = `<h3><span style="color:var(--err)">${ic('alert')}</span>ลบเลขโครงข่าย</h3>
    <div class="sub">โครงข่าย <b>${esc(network)}</b> ในแฟ้ม <b>${esc(wbs)}</b></div>
    <div class="warn" style="margin:12px 0">จะลบก้อนงบ ${shown.length} หมวด${hasCut ? ' + ใบตัดทุกใบของโครงข่ายนี้' : ''} ออกถาวร — กู้คืนไม่ได้</div>
    <div class="modal-actions">
      <button class="btn sec" id="dnCancel">ยกเลิก</button>
      <button class="btn" id="dnNext" style="background:var(--err)">ดำเนินการต่อ →</button>
    </div>`;
  $('modal').classList.add('show');
  $('dnCancel').addEventListener('click', closeModal);
  $('dnNext').addEventListener('click', () => askDeleteNetworkPassword(wbs, network));
}

function askDeleteNetworkPassword(wbs, network) {
  $('modalBox').innerHTML = `<h3>${ic('lock')}ยืนยันการลบ</h3>
    <div class="sub">ใส่รหัสผ่านเพื่อลบโครงข่าย <b>${esc(network)}</b> ถาวร</div>
    <div class="field" style="margin-top:12px"><label>รหัสผ่าน</label>
      <input type="password" id="dnPw" autocomplete="off"></div>
    <div id="dnErr" class="err"></div>
    <div class="modal-actions">
      <button class="btn sec" id="dnCancel2">ยกเลิก</button>
      <button class="btn" id="dnDo" style="background:var(--err)">${ic('trash')}ลบถาวร</button>
    </div>`;
  $('dnCancel2').addEventListener('click', closeModal);
  $('dnDo').addEventListener('click', () => doDeleteNetwork(wbs, network));
  $('dnPw').focus();
}

async function doDeleteNetwork(wbs, network) {
  if ($('dnPw').value !== '509758') { $('dnErr').textContent = 'รหัสผ่านไม่ถูกต้อง'; return; }
  const btn = $('dnDo'); btn.disabled = true; $('dnErr').textContent = '';
  try {
    const r = await callApi('deleteNetwork', { wbs, network, password: $('dnPw').value });
    closeModal();
    await loadBudgets();
    const flash = `<div class="flash ok">${ic('check')}ลบโครงข่าย ${esc(network)} แล้ว (งบ ${r.budgets} หมวด, ใบตัด ${r.slips} ใบ)</div>`;
    // ยังมีก้อนงบในแฟ้มนี้ → อยู่หน้าเดิม; ไม่งั้นกลับหน้าเลือกแฟ้ม
    if (budgets.some((b) => parseWbs(b.wbs).base === selectedBase)) { $('detailOut').insertAdjacentHTML('afterbegin', flash); }
    else { goPanel('files'); $('filesOut').insertAdjacentHTML('afterbegin', flash); }
  } catch (err) {
    btn.disabled = false;
    $('dnErr').textContent = err.message;
  }
}

// ---------- หน้าสรุปงบต่อคีย์ + ออก PDF (modal) ----------
async function openSummary(b) {
  $('modalBox').innerHTML = `<h3>สรุปงบ — ${esc(b.category)}</h3>
    <div class="sub">เลขกิจกรรม <span class="mono">${esc(b.act)}</span> • โครงข่าย ${esc(b.network)}</div>
    <div class="balrow"><span>ยอดจัดสรร</span><b>${fmt(b.allocation)}</b></div>
    <div class="balrow"><span>จ่ายแล้วรวม</span><b>${fmt(b.paid)}</b></div>
    <div class="balrow big"><span>คงเหลือ</span><b class="${b.balance < 0 ? 'err' : ''}">${fmt(b.balance)}</b></div>
    <div id="sumList" class="sub">${spin}กำลังโหลดงวด…</div>
    <div class="modal-actions"><button class="btn sec" id="cancelSlip">ปิด</button></div>`;
  $('modal').classList.add('show');
  $('cancelSlip').addEventListener('click', closeModal);
  try {
    const slips = await callApi('getSlips', { key: b.key });
    if (!slips.length) { $('sumList').innerHTML = '<div class="card">ยังไม่มีงวดในคีย์นี้</div>'; return; }
    let html = `<table><thead><tr><th>งวด</th><th>วันที่</th><th class="num">จ่าย</th><th class="num">คงเหลือ</th><th>จัดการ</th></tr></thead><tbody>`;
    slips.forEach((s) => {
      html += `<tr><td>${esc(s.period)}</td><td>${esc(s.date)}</td>
        <td class="num">${fmt(s.payNow)}</td><td class="num">${fmt(s.balance)}</td>
        <td><div class="row-actions"><button class="btn sec" data-pdf="${esc(s.slipNo)}">${ic('download')}PDF</button>
          <button class="btn sec" data-delslip="${esc(s.slipNo)}" style="color:var(--err)">${ic('trash')}ลบ</button></div></td></tr>`;
    });
    $('sumList').innerHTML = html + '</tbody></table>';
    document.querySelectorAll('[data-pdf]').forEach((btn) =>
      btn.addEventListener('click', () => makePdf(btn)));
    document.querySelectorAll('[data-delslip]').forEach((btn) =>
      btn.addEventListener('click', () => askDeleteSlip(slips.find((s) => String(s.slipNo) === btn.dataset.delslip), b)));
  } catch (err) {
    $('sumList').innerHTML = `<div class="err">โหลดงวดไม่สำเร็จ: ${esc(err.message)}</div>`;
  }
}

// ---------- ลบใบตัดงบผิด (ย้อนกลับได้ทีละใบ — ยอดจ่ายคืนเข้าคงเหลือ, ยืนยัน 2 ชั้น + รหัสผ่าน) ----------
function askDeleteSlip(s, b) {
  if (!s) return;
  $('modalBox').innerHTML = `<h3><span style="color:var(--err)">${ic('alert')}</span>ลบใบตัดงบ (งวด ${esc(s.period)})</h3>
    <div class="sub">${esc(b.category)} • จ่าย ${fmt(s.payNow)} บาท • วันที่ ${esc(s.date)}</div>
    <div class="warn" style="margin:12px 0">จะลบใบตัดนี้ถาวร — ยอด ${fmt(s.payNow)} บาท จะคืนกลับเข้าคงเหลือ (กู้คืนใบไม่ได้)</div>
    <div class="modal-actions">
      <button class="btn sec" id="dsCancel">ยกเลิก</button>
      <button class="btn" id="dsNext" style="background:var(--err)">ดำเนินการต่อ →</button>
    </div>`;
  $('dsCancel').addEventListener('click', () => openSummary(b)); // กลับไปหน้าสรุปเดิม
  $('dsNext').addEventListener('click', () => askDeleteSlipPassword(s, b));
}

function askDeleteSlipPassword(s, b) {
  $('modalBox').innerHTML = `<h3>${ic('lock')}ยืนยันการลบ</h3>
    <div class="sub">ใส่รหัสผ่านเพื่อลบใบตัดงบ <b>งวด ${esc(s.period)}</b> (จ่าย ${fmt(s.payNow)} บาท) ถาวร</div>
    <div class="field" style="margin-top:12px"><label>รหัสผ่าน</label><input type="password" id="dsPw" autocomplete="off"></div>
    <div id="dsErr" class="err"></div>
    <div class="modal-actions">
      <button class="btn sec" id="dsCancel">ยกเลิก</button>
      <button class="btn" id="dsDo" style="background:var(--err)">${ic('trash')}ลบถาวร</button>
    </div>`;
  $('dsCancel').addEventListener('click', () => openSummary(b));
  $('dsDo').addEventListener('click', () => doDeleteSlip(s.slipNo, b));
  $('dsPw').focus();
}

async function doDeleteSlip(slipNo, b) {
  if ($('dsPw').value !== '509758') { $('dsErr').textContent = 'รหัสผ่านไม่ถูกต้อง'; return; }
  const btn = $('dsDo'); btn.disabled = true; $('dsErr').textContent = '';
  try {
    await callApi('deleteSlip', { slipNo, password: $('dsPw').value });
    await loadBudgets(); // paid/คงเหลือคำนวณใหม่ + หน้ารายละเอียดหลัง modal อัปเดต
    const fresh = budgets.find((x) => x.key === b.key);
    if (fresh) openSummary(fresh); // เปิดสรุปใหม่ให้เห็นงวดที่เหลือ + ยอดอัปเดต
    else closeModal();
  } catch (err) {
    btn.disabled = false;
    $('dsErr').textContent = err.message;
  }
}

async function makePdf(btn) {
  btn.disabled = true; btn.innerHTML = spin + 'กำลังออก…';
  try {
    const r = await callApi('makePdf', { slipNo: btn.dataset.pdf });
    const bytes = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const file = new File([blob], r.filename, { type: 'application/pdf' });
    // มือถือ (touch): เด้ง modal ให้กดแชร์/เปิดเอง — iOS ต้องการ user gesture สดๆ ไม่งั้น share ถูกบล็อก
    if (matchMedia('(pointer: coarse)').matches) {
      showPdfResult(blob, file);
    } else {
      downloadBlob(blob, r.filename); // เดสก์ท็อป: ดาวน์โหลดตรง
    }
  } catch (err) {
    alert('ออก PDF ไม่สำเร็จ: ' + err.message);
  } finally {
    btn.disabled = false; btn.innerHTML = ic('download') + 'ออก PDF';
  }
}

// modal ผลลัพธ์ PDF (มือถือ) — ปุ่มแชร์เป็น gesture ใหม่ (iOS-safe) + ลิงก์เปิดดู
function showPdfResult(blob, file) {
  const url = URL.createObjectURL(blob);
  const canShare = navigator.canShare && navigator.canShare({ files: [file] });
  $('modalBox').innerHTML = `<h3>${ic('check')}ออกใบตัดงบเรียบร้อย</h3>
    <div class="sub">${esc(file.name)}</div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:18px">
      ${canShare ? `<button class="btn block" id="pdfShare">${ic('upload')}แชร์ / บันทึกลงเครื่อง</button>` : ''}
      <a class="btn ${canShare ? 'sec ' : ''}block" href="${url}" target="_blank" rel="noopener" style="text-decoration:none">${ic('download')}เปิดดู PDF (แล้วกดแชร์/บันทึก)</a>
    </div>
    <div class="modal-actions"><button class="btn sec" id="pdfClose">ปิด</button></div>`;
  $('modal').classList.add('show');
  $('pdfClose').addEventListener('click', () => { setTimeout(() => URL.revokeObjectURL(url), 3000); closeModal(); });
  if (canShare) $('pdfShare').addEventListener('click', async () => {
    try { await navigator.share({ files: [file], title: file.name }); }
    catch (e) { if (e.name !== 'AbortError') alert('แชร์ไม่สำเร็จ — ลองปุ่ม "เปิดดู PDF" แล้วกดแชร์จากตัวอ่าน PDF: ' + e.message); }
  });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- ฟอร์มเปิดใบตัด (modal) ----------
function openSlip(b) {
  const drivers = settings['พขร.'] || [];
  const drvOpts = drivers.map((d) => `<option>${esc(d)}</option>`).join('');
  const requesters = settings['ผู้เบิก'] || [];
  const plateOpts = (settings['ทะเบียนรถ'] || []).map((d) => `<option>${esc(d)}</option>`).join('');
  const today = new Date().toISOString().slice(0, 10);
  // เพดานทั้งงาน: ตัดรวมทุกหมวดของ WBS นี้ต้องไม่เกินยอดจัดสรรรวม (ถ้าตั้งไว้)
  const wbsCap = b.wbsTotal; // null = ยังไม่ตั้งยอด → ไม่บังคับเพดานรวม
  const wbsPaid = budgets.filter((x) => x.wbs === b.wbs).reduce((s, x) => s + x.paid, 0);
  $('modalBox').innerHTML = `
    <h3>เปิดใบตัดงบ</h3>
    <div class="sub">${esc(b.category)} • เลขกิจกรรม <span class="mono">${esc(b.act)}</span> • โครงข่าย ${esc(b.network)}</div>
    <div class="field"><label>ชื่องาน</label><input id="f-workName" value="${esc(b.workName || '')}"></div>
    <div class="field"><label>ผู้เบิก</label>
      <div style="display:flex;gap:8px">
        <select id="f-requester" style="flex:1"><option value="">— เลือก —</option>${requesters.map((d) => `<option>${esc(d)}</option>`).join('')}</select>
        <button type="button" class="btn sec" id="addRequester" style="flex:none">${ic('plus')}เพิ่ม</button>
      </div>
      <div id="addRequesterRow" style="display:none;gap:8px;margin-top:8px">
        <input id="newRequester" placeholder="ชื่อผู้เบิกใหม่" style="flex:1">
        <button type="button" class="btn" id="saveRequester" style="flex:none">บันทึก</button>
      </div>
      <div id="requesterErr" class="err"></div></div>
    <div class="field"><label>ตำแหน่ง/ที่อยู่</label><input id="f-position"></div>
    <div class="field"><label>ประกอบใบสำคัญจ่ายเลขที่</label><input id="f-ref"></div>
    <div class="field"><label>อนุมัติที่</label><input id="f-apv"></div>
    <div class="field"><label>อนุมัติ ลว.</label><input type="date" id="f-apd"></div>
    <div class="field"><label>รายการค่าใช้จ่ายหน้างาน (ติ๊กที่เกี่ยวข้อง)</label>
      <div class="chklist">
        <label class="chk"><input type="checkbox" id="chk-VEH"> ค่ายานพาหนะ / เบี้ยเลี้ยง พชง</label>
        <label class="chk"><input type="checkbox" id="chk-TRV"> ค่าพาหนะ / เบี้ยเลี้ยง พชร(บ)</label>
        <label class="chk"><input type="checkbox" id="chk-CRN"> ค่าแรง พขร.(บ.)</label>
        <div class="chk-detail" id="detail-CRN">
          <select id="f-crnName" class="drv"><option value="">— เลือกชื่อ พขร. —</option>${drvOpts}</select>
          <label class="minl">ตั้งแต่ <input type="date" id="f-crnFrom"></label>
          <label class="minl">ถึง <input type="date" id="f-crnTo"></label>
        </div>
        <div class="chk-detail">
          <button type="button" class="btn sec" id="addDriver">${ic('plus')}เพิ่มชื่อ พขร.</button>
          <span id="addDriverRow" style="display:none;gap:8px">
            <input id="newDriver" placeholder="ชื่อ พขร. ใหม่">
            <button type="button" class="btn" id="saveDriver">บันทึก</button>
          </span>
          <div id="driverErr" class="err" style="flex-basis:100%;margin:0"></div>
        </div>
        <label class="chk"><input type="checkbox" id="chk-DLY"> ค่าแรงคนงานรายวัน</label>
        <div class="chk-detail" id="detail-DLY">
          <label class="minl">ตั้งแต่ <input type="date" id="f-dlyFrom"></label>
          <label class="minl">ถึง <input type="date" id="f-dlyTo"></label>
          <label class="minl">ทีม <input id="f-dlyTeam"></label>
        </div>
        <label class="chk"><input type="checkbox" id="chk-CON"> ค่าแรงจ้างเหมา</label>
        <div class="chk-detail" id="detail-CON">
          <label class="minl">สัญญาจ้างที่ <input id="f-conNo"></label>
          <label class="minl">ลว. <input type="date" id="f-conDate"></label>
        </div>
        <label class="chk"><input type="checkbox" id="chk-OIL"> ค่าน้ำมันยานพาหนะ</label>
        <div class="chk-detail" id="detail-OIL">
          <label class="minl">ทะเบียนรถ <select id="f-oilPlate" class="drv"><option value="">— เลือก —</option>${plateOpts}</select></label>
          <button type="button" class="btn sec" id="addPlate">${ic('plus')}เพิ่ม</button>
          <span id="addPlateRow" style="display:none;gap:8px">
            <input id="newPlate" placeholder="ทะเบียนรถใหม่">
            <button type="button" class="btn" id="savePlate">บันทึก</button>
          </span>
          <div id="plateErr" class="err" style="flex-basis:100%;margin:0"></div>
        </div>
        <label class="chk"><input type="checkbox" id="chk-OTH"> อื่นๆ</label>
        <div class="chk-detail" id="detail-OTH"><label class="minl">ระบุ <input id="f-othText" style="min-width:220px"></label></div>
      </div></div>
    <div class="field"><label>วันที่ตัด</label><input type="date" id="f-slipDate" value="${today}"></div>
    <div class="field"><label>จ่ายครั้งนี้ (บาท)</label><input type="number" step="0.01" min="0" id="f-payNow"></div>
    <div class="balrow"><span>คงเหลือ (บน)</span><b id="balTop">${fmt(b.balance)}</b></div>
    <div class="balrow big"><span>คงเหลือ (ล่าง)</span><b id="balBottom">${fmt(b.balance)}</b></div>
    <div id="slipErr" class="err"></div>
    <div class="modal-actions">
      <button class="btn sec" id="cancelSlip">ยกเลิก</button>
      <button class="btn" id="submitSlip">บันทึกใบตัด</button>
    </div>`;
  $('modal').classList.add('show');

  const pay = $('f-payNow');
  pay.addEventListener('input', () => {
    const v = parseFloat(pay.value) || 0;
    const bottom = b.balance - v;
    const el = $('balBottom');
    el.textContent = fmt(bottom);
    el.className = bottom < 0 ? 'err' : '';
    let err = '';
    if (bottom < 0) err = 'เบิกเกินยอดคงเหลือของหมวดนี้';
    else if (wbsCap != null && wbsPaid + v > wbsCap + 0.005) err = `ตัดรวมทั้งงานเกินยอดจัดสรรรวม (${fmt(wbsCap)}) — ตัดได้อีก ${fmt(wbsCap - wbsPaid)}`;
    $('slipErr').textContent = err;
  });
  // แสดงช่องรายละเอียด (วันที่/ชื่อ/ทีม) เฉพาะเมื่อ checkbox ของหัวข้อนั้นถูกติ๊ก (ข้อ 2)
  ['CRN', 'DLY', 'CON', 'OIL', 'OTH'].forEach((k) => {
    const cb = $('chk-' + k), det = $('detail-' + k);
    const sync = () => { det.style.display = cb.checked ? 'flex' : 'none'; };
    cb.addEventListener('change', sync); sync();
  });
  $('addDriver').addEventListener('click', () => {
    $('addDriverRow').style.display = 'flex'; $('newDriver').focus();
  });
  $('saveDriver').addEventListener('click', saveDriver);
  $('addRequester').addEventListener('click', () => {
    $('addRequesterRow').style.display = 'flex'; $('newRequester').focus();
  });
  $('saveRequester').addEventListener('click', saveRequester);
  $('addPlate').addEventListener('click', () => {
    $('addPlateRow').style.display = 'flex'; $('newPlate').focus();
  });
  $('savePlate').addEventListener('click', savePlate);
  $('cancelSlip').addEventListener('click', closeModal);
  $('submitSlip').addEventListener('click', () => submitSlip(b));
}

// เพิ่มชื่อ พขร. ใหม่จากในฟอร์ม → เก็บลงชีต + เติม dropdown + เลือกให้เลย
async function saveDriver() {
  const name = $('newDriver').value.trim();
  if (!name) { $('driverErr').textContent = 'ใส่ชื่อ พขร. ก่อน'; return; }
  const btn = $('saveDriver'); btn.disabled = true; $('driverErr').textContent = '';
  try {
    const list = await callApi('addDriver', { name });
    settings['พขร.'] = list;
    const opts = `<option value="">— เลือกชื่อ พขร. —</option>${list.map((d) => `<option>${esc(d)}</option>`).join('')}`;
    const sel = $('f-crnName'); const cur = sel.value; sel.innerHTML = opts; sel.value = cur;
    $('addDriverRow').style.display = 'none'; $('newDriver').value = '';
  } catch (err) {
    $('driverErr').textContent = err.message;
  } finally { btn.disabled = false; }
}

// เพิ่มชื่อผู้เบิกใหม่จากในฟอร์ม → เก็บลงชีต + เติม dropdown + เลือกให้เลย
async function saveRequester() {
  const name = $('newRequester').value.trim();
  if (!name) { $('requesterErr').textContent = 'ใส่ชื่อผู้เบิกก่อน'; return; }
  const btn = $('saveRequester'); btn.disabled = true; $('requesterErr').textContent = '';
  try {
    const list = await callApi('addRequester', { name });
    settings['ผู้เบิก'] = list;
    const sel = $('f-requester');
    sel.innerHTML = `<option value="">— เลือก —</option>${list.map((d) => `<option>${esc(d)}</option>`).join('')}`;
    sel.value = name;
    $('addRequesterRow').style.display = 'none'; $('newRequester').value = '';
  } catch (err) {
    $('requesterErr').textContent = err.message;
  } finally { btn.disabled = false; }
}

// เพิ่มทะเบียนรถใหม่จากในฟอร์ม → เก็บลงชีต + เติม dropdown + เลือกให้เลย
async function savePlate() {
  const name = $('newPlate').value.trim();
  if (!name) { $('plateErr').textContent = 'ใส่ทะเบียนรถก่อน'; return; }
  const btn = $('savePlate'); btn.disabled = true; $('plateErr').textContent = '';
  try {
    const list = await callApi('addPlate', { name });
    settings['ทะเบียนรถ'] = list;
    const sel = $('f-oilPlate');
    sel.innerHTML = `<option value="">— เลือก —</option>${list.map((d) => `<option>${esc(d)}</option>`).join('')}`;
    sel.value = name;
    $('addPlateRow').style.display = 'none'; $('newPlate').value = '';
  } catch (err) {
    $('plateErr').textContent = err.message;
  } finally { btn.disabled = false; }
}

// ---------- ตัวเลือกผู้ดำเนินการ (ข้อ 5) — กฟภ. หรือบริษัทผู้รับเหมา (ใช้ทั้งตอน import และแก้ทีหลัง) ----------
function operPickerHtml(current) {
  const isCo = current && current !== 'กฟภ.';
  const companies = (settings['บริษัท'] || []).slice(); // copy — กัน mutate settings
  if (isCo && !companies.includes(current)) companies.unshift(current); // เผื่อบริษัทเดิมยังไม่อยู่ใน list
  const opts = companies.map((c) => `<option ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');
  return `<div class="field"><label>ผู้ดำเนินการ</label>
    <label class="chk"><input type="radio" name="operMode" value="pea" ${isCo ? '' : 'checked'}> กฟภ.</label>
    <label class="chk"><input type="radio" name="operMode" value="co" ${isCo ? 'checked' : ''}> บริษัทผู้รับเหมา</label>
    <div id="operCo" style="display:${isCo ? 'block' : 'none'};margin-top:6px">
      <div style="display:flex;gap:8px">
        <select id="operCompany" style="flex:1"><option value="">— เลือกบริษัท —</option>${opts}</select>
        <button type="button" class="btn sec" id="addCompany" style="flex:none">${ic('plus')}เพิ่ม</button>
      </div>
      <div id="addCompanyRow" style="display:none;gap:8px;margin-top:8px">
        <input id="newCompany" placeholder="ชื่อบริษัทใหม่" style="flex:1">
        <button type="button" class="btn" id="saveCompany" style="flex:none">บันทึก</button>
      </div>
      <div id="companyErr" class="err"></div>
    </div></div>`;
}
function bindOperPicker() {
  document.querySelectorAll('input[name=operMode]').forEach((r) =>
    r.addEventListener('change', () => { $('operCo').style.display = readMode() === 'co' ? 'block' : 'none'; }));
  $('addCompany').addEventListener('click', () => { $('addCompanyRow').style.display = 'flex'; $('newCompany').focus(); });
  $('saveCompany').addEventListener('click', saveCompany);
}
const readMode = () => (document.querySelector('input[name=operMode]:checked') || {}).value;
function readOper() { return readMode() === 'co' ? $('operCompany').value.trim() : 'กฟภ.'; }

// เพิ่มบริษัทใหม่ → เก็บลงชีต + เติม dropdown + เลือกให้เลย
async function saveCompany() {
  const name = $('newCompany').value.trim();
  if (!name) { $('companyErr').textContent = 'ใส่ชื่อบริษัทก่อน'; return; }
  const btn = $('saveCompany'); btn.disabled = true; $('companyErr').textContent = '';
  try {
    const list = await callApi('addCompany', { name });
    settings['บริษัท'] = list;
    const sel = $('operCompany');
    sel.innerHTML = `<option value="">— เลือกบริษัท —</option>${list.map((c) => `<option>${esc(c)}</option>`).join('')}`;
    sel.value = name;
    $('addCompanyRow').style.display = 'none'; $('newCompany').value = '';
  } catch (err) { $('companyErr').textContent = err.message; } finally { btn.disabled = false; }
}

function closeModal() { $('modal').classList.remove('show'); }

async function submitSlip(b) {
  const val = (id) => $(id).value.trim();
  const payNow = parseFloat($('f-payNow').value);
  if (!(payNow > 0)) { $('slipErr').textContent = 'ใส่จำนวนเงินให้ถูกต้อง'; return; }
  const btn = $('submitSlip'); btn.disabled = true;
  $('slipErr').textContent = '';
  // clientId คงที่ต่อการกด 1 ครั้ง → callApi retry ได้ปลอดภัย (server เจอซ้ำจะไม่ตัดเบิล)
  const clientId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  // checkbox หน้างาน + รายละเอียด (เก็บเฉพาะรายละเอียดของช่องที่ติ๊ก → PDF เว้นว่างถ้าไม่ติ๊ก)
  const chk = {};
  ['VEH', 'TRV', 'CRN', 'DLY', 'CON', 'OIL', 'OTH'].forEach((k) => { chk[k] = $('chk-' + k).checked; });
  const extra = {
    chk,
    crnName: chk.CRN ? val('f-crnName') : '',
    crnFrom: chk.CRN ? val('f-crnFrom') : '', crnTo: chk.CRN ? val('f-crnTo') : '', // ช่วงวันที่ พขร.เครน (ข้อ 2)
    dlyFrom: chk.DLY ? val('f-dlyFrom') : '', dlyTo: chk.DLY ? val('f-dlyTo') : '', // ช่วงวันที่ แรงรายวัน
    dlyTeam: chk.DLY ? val('f-dlyTeam') : '',
    oilPlate: chk.OIL ? val('f-oilPlate') : '', // ทะเบียนรถ ค่าน้ำมันยานพาหนะ
    othText: chk.OTH ? val('f-othText') : '', // อื่นๆ ระบุ → แทนจุดไข่ปลาใน PDF
    apv: val('f-apv'), apd: val('f-apd'), // อนุมัติที่ / อนุมัติ ลว. (กรอกในแอป → PDF)
  };
  try {
    const r = await callApi('createSlip', {
      key: b.key, payNow, clientId,
      workName: val('f-workName'), requester: val('f-requester'), position: val('f-position'),
      slipDate: val('f-slipDate'), ref: val('f-ref'),
      contract: chk.CON ? val('f-conNo') : '', conDate: chk.CON ? val('f-conDate') : '', // CON_NO + ลว.
      extra: JSON.stringify(extra),
    });
    flashCutKey = b.key; // ให้แถวที่เพิ่งตัดไฮไลต์หลัง re-render
    closeModal();
    // เร็วขึ้น: อัปเดตยอดจากที่ server คืน (paid/balance ของหมวดนี้) แล้ว re-render เลย
    // ไม่ต้องยิง getBudgets/getSettings ซ้ำ (เดิมโหลดใหม่ทั้งหมด = ช้า 2 คำขอ)
    const bud = budgets.find((x) => x.key === b.key);
    if (bud && r.paid != null) {
      bud.paid = r.paid; bud.balance = r.balance;
      updatePendingBadge();
      renderActivePanel(); // เรนเดอร์ detailOut ใหม่ก่อน แล้วค่อยแทรก flash
    } else {
      await loadBudgets(); // เคส duplicate (retry ซ้ำ) server ไม่คืน paid → โหลดใหม่ให้ชัวร์
    }
    $('detailOut').insertAdjacentHTML('afterbegin',
      `<div class="flash ok">${ic('check')}บันทึกใบตัดเลขที่ ${r.slipNo} — คงเหลือใหม่ ${fmt(r.balance)}</div>`);
  } catch (err) {
    // server เป็นคนตัดสิน (กันเบิกเกิน/แข่งกันเบิก) — โชว์เหตุผลจาก server
    $('slipErr').textContent = err.message;
    btn.disabled = false;
  }
}

// โหลดรายการงานทันทีที่เปิดแอป (หน้าหลักเป็นค่าเริ่มต้น)
loadBudgets();
