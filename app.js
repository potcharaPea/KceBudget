// app.js — Phase 2: นำเข้า ZPSR018 → คุมงบ → เปิดใบตัด (ยังไม่ออก PDF)
import * as pdfjs from './vendor/pdf.min.mjs';
import { parseZpsr018 } from './parser.js';
import { callApi, hasBackend } from './api.js';

pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
};
const ic = (name) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
const spin = '<span class="spinner"></span>';

let parsed = null;      // ผลอ่านไฟล์ล่าสุด {wbs, networks, fileName}
let budgets = [];       // ก้อนงบจาก server
let settings = {};      // master data dropdown
let selectedWbs = null; // งานที่เลือกดูอยู่ (WBS)
let search = '';        // คำค้นในหน้าเลือกแฟ้ม
let dashMode = 'sum';   // โหมด Dashboard: sum | month | year
let flashCutKey = null; // key ก้อนงบที่เพิ่งตัด → ไฮไลต์แถวชั่วคราวหลัง re-render

// ---------- สลับ panel ใน main + เมนู sidebar ----------
function showPanel(name) {
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  $('panel-' + name).classList.add('active');
}
function setMenuActive(name) { // name = ชื่อ panel ของเมนู หรือ '' (ไม่ไฮไลต์)
  document.querySelectorAll('.menu-item').forEach((m) => m.classList.toggle('active', m.dataset.panel === name));
}
const PANEL_RENDER = { files: renderFiles, pending: renderPending, dashboard: renderDashboard };
function goPanel(name) { setMenuActive(name); showPanel(name); (PANEL_RENDER[name] || (() => {}))(); }

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
  $('modalBox').innerHTML = `<h3 style="text-align:center">ผู้พัฒนา</h3>
    <div style="text-align:center;padding:10px 0">
      <div style="color:var(--primary)"><svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg></div>
      <div style="font-size:18px;font-weight:600;margin-top:8px">นายพชระ ปรีดากรณ์</div>
      <div class="sub" style="margin-top:4px">วศก.ผปร. กฟส.คช.</div>
    </div>
    <div class="modal-actions" style="justify-content:center"><button class="btn" id="creditClose">ปิด</button></div>`;
  $('modal').classList.add('show');
  $('creditClose').addEventListener('click', closeModal);
});

// ================= View: นำเข้าไฟล์ =================
const drop = $('drop');
$('file').addEventListener('change', (e) => e.target.files[0] && handleFile(e.target.files[0]));
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

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
         <input id="f-jobName" placeholder="ชื่องานก่อสร้าง"></div>`
    : '';
  html += `<div id="wbs">หมายเลขงาน (WBS): <span>${esc(wbs || '—')}</span></div>`;
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
  if (hasBackend()) $('importBtn').addEventListener('click', () => doImport([]));
}

// แปลง networks → รายการก้อนงบ (เฉพาะหมวดที่เปิดใบได้)
function toBudgetRows() {
  const rows = [];
  for (const n of parsed.networks) {
    for (const c of n.categories) {
      if (!c.openSlip) continue;
      rows.push({
        key: [parsed.wbs, n.network, c.act].join('|'),
        wbs: parsed.wbs, network: n.network, dept: n.dept,
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
    const r = await callApi('importBudget', { fileName: parsed.fileName, workName, budgets: toBudgetRows(), confirmKeys });
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
  if ($('panel-job').classList.contains('active') && selectedWbs) renderDetail();
  else if ($('panel-pending').classList.contains('active')) renderPending();
  else if ($('panel-dashboard').classList.contains('active')) renderDashboard();
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
    const j = jobs[b.wbs] || (jobs[b.wbs] = { wbs: b.wbs, cats: 0, alloc: 0, paid: 0, bal: 0, nets: new Set(), created: null });
    j.cats++; j.alloc += b.allocation; j.paid += b.paid; j.bal += b.balance; j.nets.add(b.network);
    const d = b.imported ? new Date(b.imported) : null; // วันที่สร้างแฟ้ม = import ครั้งแรกสุด
    if (d && !isNaN(d) && (!j.created || d < j.created)) j.created = d;
  });
  return Object.values(jobs);
}

const TH_MONTH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const dayKey = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD สำหรับ sort
const thaiDay = (d) => `${d.getDate()} ${TH_MONTH[d.getMonth()]} ${d.getFullYear() + 543}`;
const jobStatus = (j) => (j.paid <= 0 ? 'none' : j.bal <= 0 ? 'done' : 'part'); // ยังไม่ตัด / เบิกครบ / กำลังตัด
const STATUS_LABEL = { none: 'ยังไม่ตัด', part: 'กำลังตัด', done: 'เบิกครบ' };

// การ์ดแฟ้ม 1 ใบ (ใช้ทั้งหน้าเลือกแฟ้ม + หน้ายังไม่ตัดงบ)
function fileCard(j) {
  const pct = j.alloc > 0 ? Math.min(100, (j.paid / j.alloc) * 100) : 0;
  const st = jobStatus(j);
  return `<button class="filecard" data-wbs="${esc(j.wbs)}">
    <div class="fc-top"><span class="fc-wbs">${esc(j.wbs)}</span>
      <span class="fc-badge ${st}">${STATUS_LABEL[st]}</span></div>
    <div class="fc-meta">${j.nets.size} โครงข่าย · ${j.cats} หมวดงบ</div>
    <div class="fc-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="fc-stats"><span>จัดสรร<b>${fmt(j.alloc)}</b></span>
      <span>คงเหลือ<b class="${j.bal < 0 ? 'err' : ''}">${fmt(j.bal)}</b></span></div></button>`;
}
function bindFileCards(root) {
  root.querySelectorAll('.filecard').forEach((c) => c.addEventListener('click', () => openJob(c.dataset.wbs)));
}

function updatePendingBadge() {
  const n = jobStats().filter((j) => jobStatus(j) === 'none').length;
  $('pendCount').textContent = n || '';
}

// ---------- หน้า: เลือกแฟ้มงาน (จัดกลุ่มตามวันที่สร้าง) ----------
function renderFiles() {
  const jobs = jobStats().filter((j) => j.wbs.toLowerCase().includes(search));
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
  const pend = jobStats().filter((j) => jobStatus(j) === 'none');
  if (!pend.length) { $('pendingOut').innerHTML = `<div class="list-empty"><span class="ok">${ic('check')}</span> ทุกแฟ้มเริ่มตัดงบแล้ว</div>`; return; }
  $('pendingOut').innerHTML = `<div class="files">${pend.map(fileCard).join('')}</div>`;
  bindFileCards($('pendingOut'));
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

// เข้าหน้ารายละเอียดแฟ้มที่เลือก
function openJob(wbs) {
  selectedWbs = wbs;
  showPanel('job');
  renderDetail();
}

function renderDetail() {
  const shown = budgets.filter((b) => b.wbs === selectedWbs);
  if (!shown.length) { $('detailOut').innerHTML = '<div class="card">ไม่พบก้อนงบของงานนี้</div>'; return; }
  const j = jobStats().find((x) => x.wbs === selectedWbs);
  const pct = j.alloc > 0 ? Math.min(100, (j.paid / j.alloc) * 100) : 0;
  const gc = j.bal < 0 ? 'var(--err)' : 'var(--primary)';
  const fk = flashCutKey; flashCutKey = null; // ก้อนที่เพิ่งตัด → ไฮไลต์ครั้งเดียว

  // ปุ่มย้อนกลับ + หัวเรื่อง + เกจ %เบิกแล้ว
  let html = `<div class="back-bar"><button class="btn sec" id="backFiles">← กลับหน้าเลือกแฟ้มงาน</button>
    <button class="btn sec" id="delFile" style="margin-left:auto;color:var(--err)">${ic('trash')}ลบแฟ้ม</button></div>
  <div class="detail-head">
    <div style="flex:1">
      <div class="dh-kicker">หมายเลขงาน (WBS)</div>
      <div class="dh-title">${esc(selectedWbs)}</div>
      <div class="chips"><span class="chip">${j.nets.size} โครงข่าย</span><span class="chip">${j.cats} หมวดงบ</span></div>
    </div>
    <div class="gauge" style="--pct:${pct.toFixed(1)};--gc:${gc}">
      <div class="g-v">${Math.round(pct)}%</div><div class="g-l">เบิกแล้ว</div></div>
  </div>`;

  // KPI 4 ช่อง
  html += `<div class="kpis">
    <div class="kpi"><div class="v">${fmt(j.alloc)}</div><div class="l">ยอดจัดสรรรวม</div></div>
    <div class="kpi"><div class="v">${fmt(j.paid)}</div><div class="l">จ่ายแล้วรวม</div></div>
    <div class="kpi ${j.bal < 0 ? 'err' : 'ok'}"><div class="v">${fmt(j.bal)}</div><div class="l">คงเหลือ</div></div>
    <div class="kpi"><div class="v">${shown.filter((b) => b.balance > 0).length}/${shown.length}</div><div class="l">หมวดเปิดใบได้</div></div>
  </div>`;

  // ตารางงบตามโครงข่าย
  const byNet = {};
  shown.forEach((b) => { (byNet[b.network + '|' + b.dept] = byNet[b.network + '|' + b.dept] || []).push(b); });
  for (const grp of Object.keys(byNet)) {
    const [network, dept] = grp.split('|');
    html += `<div class="net"><h2>โครงข่าย ${esc(network)}<span class="dept">${esc(dept)}</span></h2>
      <table><thead><tr><th>หมวดงบ</th><th>เลขกิจ</th><th class="num">ยอดจัดสรร</th><th class="num">จ่ายแล้ว</th><th class="num">คงเหลือ</th><th></th></tr></thead><tbody>`;
    for (const b of byNet[grp]) {
      const i = budgets.indexOf(b);
      const canCut = b.balance > 0;
      const flashCls = b.key === fk ? ' class="row-flash"' : '';
      html += `<tr${flashCls}><td>${esc(b.category)}</td><td class="act">${esc(b.act)}</td>
        <td class="num">${fmt(b.allocation)}</td><td class="num">${fmt(b.paid)}</td>
        <td class="num ${b.balance < 0 ? 'err' : ''}">${fmt(b.balance)}</td>
        <td><div class="row-actions"><button class="btn sec" data-sum="${i}">สรุป/งวด</button>
          <button class="btn sec" data-cut="${i}" ${canCut ? '' : 'disabled'}>เปิดใบตัด</button></div></td></tr>`;
    }
    html += `</tbody></table></div>`;
  }
  $('detailOut').innerHTML = html;
  $('backFiles').addEventListener('click', () => goPanel('files'));
  $('delFile').addEventListener('click', () => askDeleteFile(selectedWbs));
  document.querySelectorAll('[data-cut]').forEach((btn) =>
    btn.addEventListener('click', () => openSlip(budgets[+btn.dataset.cut])));
  document.querySelectorAll('[data-sum]').forEach((btn) =>
    btn.addEventListener('click', () => openSummary(budgets[+btn.dataset.sum])));
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
    goPanel('files');
    await loadBudgets();
    $('filesOut').insertAdjacentHTML('afterbegin',
      `<div class="flash ok">${ic('check')}ลบแฟ้ม ${esc(wbs)} แล้ว (งบ ${r.budgets} หมวด, ใบตัด ${r.slips} ใบ)</div>`);
  } catch (err) {
    btn.disabled = false;
    $('delErr').textContent = err.message;
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
    let html = `<table><thead><tr><th>งวด</th><th>วันที่</th><th class="num">จ่าย</th><th class="num">คงเหลือ</th><th>PDF</th></tr></thead><tbody>`;
    slips.forEach((s) => {
      html += `<tr><td>${esc(s.slipNo)}</td><td>${esc(s.date)}</td>
        <td class="num">${fmt(s.payNow)}</td><td class="num">${fmt(s.balance)}</td>
        <td><button class="btn sec" data-pdf="${esc(s.slipNo)}">${ic('download')}ออก PDF</button></td></tr>`;
    });
    $('sumList').innerHTML = html + '</tbody></table>';
    document.querySelectorAll('[data-pdf]').forEach((btn) =>
      btn.addEventListener('click', () => makePdf(btn)));
  } catch (err) {
    $('sumList').innerHTML = `<div class="err">โหลดงวดไม่สำเร็จ: ${esc(err.message)}</div>`;
  }
}

async function makePdf(btn) {
  btn.disabled = true; btn.innerHTML = spin + 'กำลังออก…';
  try {
    const r = await callApi('makePdf', { slipNo: btn.dataset.pdf });
    const bytes = Uint8Array.from(atob(r.b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const file = new File([blob], r.filename, { type: 'application/pdf' });
    // มือถือ (touch): เด้ง modal ให้กดแชร์เอง — iOS ต้องการ user gesture สดๆ ไม่งั้น share ถูกบล็อก
    if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
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
  $('modalBox').innerHTML = `<h3>${ic('check')}ออกใบตัดงบเรียบร้อย</h3>
    <div class="sub">${esc(file.name)}</div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:18px">
      <button class="btn block" id="pdfShare">${ic('upload')}แชร์ / บันทึกลงเครื่อง</button>
      <a class="btn sec block" href="${url}" target="_blank" rel="noopener" style="text-decoration:none">${ic('download')}เปิดดู PDF</a>
    </div>
    <div class="modal-actions"><button class="btn sec" id="pdfClose">ปิด</button></div>`;
  $('modal').classList.add('show');
  $('pdfClose').addEventListener('click', () => { setTimeout(() => URL.revokeObjectURL(url), 3000); closeModal(); });
  $('pdfShare').addEventListener('click', async () => {
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
  const today = new Date().toISOString().slice(0, 10);
  $('modalBox').innerHTML = `
    <h3>เปิดใบตัดงบ</h3>
    <div class="sub">${esc(b.category)} • เลขกิจกรรม <span class="mono">${esc(b.act)}</span> • โครงข่าย ${esc(b.network)}</div>
    <div class="field"><label>ชื่องาน</label><input id="f-workName" value="${esc(b.workName || '')}"></div>
    <div class="field"><label>ผู้เบิก</label><input id="f-requester"></div>
    <div class="field"><label>ตำแหน่ง/ที่อยู่</label><input id="f-position"></div>
    <div class="field"><label>ประกอบใบสำคัญจ่ายเลขที่</label><input id="f-ref"></div>
    <div class="field"><label>ชื่อ พขร.</label>
      <div style="display:flex;gap:8px">
        <select id="f-driver" style="flex:1"><option value="">— เลือก —</option>${drivers.map((d) => `<option>${esc(d)}</option>`).join('')}</select>
        <button type="button" class="btn sec" id="addDriver" style="flex:none">${ic('plus')}เพิ่ม</button>
      </div>
      <div id="addDriverRow" style="display:none;gap:8px;margin-top:8px">
        <input id="newDriver" placeholder="ชื่อ พขร. ใหม่" style="flex:1">
        <button type="button" class="btn" id="saveDriver" style="flex:none">บันทึก</button>
      </div>
      <div id="driverErr" class="err"></div></div>
    <div class="field"><label>สัญญาจ้างเลขที่</label><input id="f-contract"></div>
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
    $('slipErr').textContent = bottom < 0 ? 'เบิกเกินยอดคงเหลือ' : '';
  });
  $('addDriver').addEventListener('click', () => {
    $('addDriverRow').style.display = 'flex'; $('newDriver').focus();
  });
  $('saveDriver').addEventListener('click', saveDriver);
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
    const sel = $('f-driver');
    sel.innerHTML = `<option value="">— เลือก —</option>${list.map((d) => `<option>${esc(d)}</option>`).join('')}`;
    sel.value = name;
    $('addDriverRow').style.display = 'none'; $('newDriver').value = '';
  } catch (err) {
    $('driverErr').textContent = err.message;
  } finally { btn.disabled = false; }
}

function closeModal() { $('modal').classList.remove('show'); }

async function submitSlip(b) {
  const val = (id) => $(id).value.trim();
  const payNow = parseFloat($('f-payNow').value);
  if (!(payNow > 0)) { $('slipErr').textContent = 'ใส่จำนวนเงินให้ถูกต้อง'; return; }
  const btn = $('submitSlip'); btn.disabled = true;
  $('slipErr').textContent = '';
  try {
    const r = await callApi('createSlip', {
      key: b.key, payNow,
      workName: val('f-workName'), requester: val('f-requester'), position: val('f-position'),
      driver: val('f-driver'), contract: val('f-contract'), slipDate: val('f-slipDate'), ref: val('f-ref'),
    });
    flashCutKey = b.key; // ให้แถวที่เพิ่งตัดไฮไลต์หลัง re-render
    closeModal();
    await loadBudgets(); // รอ re-render เสร็จ แถวถึงไฮไลต์ + flash ไม่โดนล้าง
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
