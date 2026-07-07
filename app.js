// app.js — Phase 2: นำเข้า ZPSR018 → คุมงบ → เปิดใบตัด (ยังไม่ออก PDF)
import * as pdfjs from './vendor/pdf.min.mjs';
import { parseZpsr018 } from './parser.js';
import { callApi, hasBackend } from './api.js';

pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let parsed = null;      // ผลอ่านไฟล์ล่าสุด {wbs, networks, fileName}
let budgets = [];       // ก้อนงบจาก server
let settings = {};      // master data dropdown
let selectedWbs = null; // งานที่เลือกดูอยู่ (WBS)

// ---------- สลับ view ----------
document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('view-' + b.dataset.view).classList.add('active');
    if (b.dataset.view === 'ledger') loadBudgets();
  }));

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
  $('importOut').innerHTML = '<div class="sub">⏳ กำลังอ่านไฟล์…</div>';
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
  let html = `<div id="wbs">หมายเลขงาน (WBS): <span>${esc(wbs || '—')}</span></div>`;
  for (const n of networks) {
    html += `<div class="net"><h2>โครงข่าย ${esc(n.network)}<span class="dept">${esc(n.dept)}</span></h2>
      <table><thead><tr><th>หมวดงบ</th><th class="num">ยอดจัดสรร (บาท)</th><th>เลขกิจกรรม</th><th>เปิดใบตัดงบ</th></tr></thead><tbody>`;
    for (const c of n.categories) {
      html += `<tr class="${c.openSlip ? '' : 'skip'}"><td>${esc(c.name)}</td><td class="num">${fmt(c.value)}</td>
        <td class="act">${c.act}</td><td>${c.openSlip ? '<span class="yes">✅</span>' : '<span class="no">—</span>'}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }
  html += hasBackend()
    ? `<button class="btn" id="importBtn">⬆️ นำเข้างบเข้าระบบ</button><div id="importResult"></div>`
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
  $('importResult').innerHTML = '<div class="sub">⏳ กำลังนำเข้า…</div>';
  try {
    const r = await callApi('importBudget', { fileName: parsed.fileName, budgets: toBudgetRows(), confirmKeys });
    let html = `<div class="ok">✅ นำเข้าเสร็จ — เพิ่มใหม่ ${r.added.length} | เท่าเดิม(ข้าม) ${r.unchanged} | อัปเดต ${r.updated.length}</div>`;
    if (r.needConfirm && r.needConfirm.length) {
      html += `<div class="card"><b class="warn">⚠️ พบยอดจัดสรรเปลี่ยน — ต้องยืนยันก่อนทับ</b>`;
      for (const c of r.needConfirm) {
        html += `<div class="diff"><label><input type="checkbox" class="cf" value="${esc(c.key)}" checked>
          <span class="mono">${esc(c.key)}</span> : ${fmt(c.oldVal)} → <b>${fmt(c.newVal)}</b>
          ${c.negativeRemaining ? `<span class="err">(ยอดใหม่ต่ำกว่าที่เบิกไปแล้ว ${fmt(c.paid)} → คงเหลือจะติดลบ)</span>` : ''}</label></div>`;
      }
      html += `<button class="btn" id="confirmBtn">ยืนยันแก้ยอดที่ติ๊ก</button></div>`;
    }
    $('importResult').innerHTML = html;
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

// ================= View: ก้อนงบ / เปิดใบตัด =================
$('reloadBudgets').addEventListener('click', loadBudgets);

async function loadBudgets() {
  if (!hasBackend()) { $('ledgerOut').innerHTML = '<div class="warn">ยังไม่ได้ตั้งค่า GAS_URL ใน config.js</div>'; return; }
  $('ledgerOut').innerHTML = '<div class="sub">⏳ กำลังโหลด…</div>';
  try {
    [budgets, settings] = await Promise.all([callApi('getBudgets'), callApi('getSettings')]);
    renderBudgets();
  } catch (err) {
    $('ledgerOut').innerHTML = `<div class="err">โหลดไม่สำเร็จ: ${esc(err.message)}</div>`;
  }
}

function renderBudgets() {
  if (!budgets.length) { $('ledgerOut').innerHTML = '<div class="card">ยังไม่มีก้อนงบ — ไปนำเข้าไฟล์ ZPSR018 ก่อน</div>'; return; }
  // รายการงาน (WBS) — 1 WBS = 1 งาน; เลือกดูทีละงาน (ค่าเริ่ม = งานแรก)
  const jobs = [...new Set(budgets.map((b) => b.wbs))];
  if (!jobs.includes(selectedWbs)) selectedWbs = jobs[0];
  const shown = budgets.filter((b) => b.wbs === selectedWbs);

  let html = `<div class="jobbar"><label>งาน (WBS)</label>
    <select id="jobSel">${jobs.map((w) => `<option ${w === selectedWbs ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select>
    <span class="jobcount">${jobs.length} งานในระบบ</span></div>`;

  // จัดกลุ่มตามโครงข่าย (เฉพาะงานที่เลือก)
  const byNet = {};
  shown.forEach((b) => { (byNet[b.network + '|' + b.dept] = byNet[b.network + '|' + b.dept] || []).push(b); });
  for (const grp of Object.keys(byNet)) {
    const [network, dept] = grp.split('|');
    html += `<div class="net"><h2>โครงข่าย ${esc(network)}<span class="dept">${esc(dept)}</span></h2>
      <table><thead><tr><th>หมวดงบ</th><th>เลขกิจ</th><th class="num">ยอดจัดสรร</th><th class="num">จ่ายแล้ว</th><th class="num">คงเหลือ</th><th></th></tr></thead><tbody>`;
    for (const b of byNet[grp]) {
      const i = budgets.indexOf(b);
      const canCut = b.balance > 0;
      html += `<tr><td>${esc(b.category)}</td><td class="act">${esc(b.act)}</td>
        <td class="num">${fmt(b.allocation)}</td><td class="num">${fmt(b.paid)}</td>
        <td class="num ${b.balance < 0 ? 'err' : ''}">${fmt(b.balance)}</td>
        <td><button class="btn sec" data-sum="${i}">สรุป/งวด</button>
          <button class="btn sec" data-cut="${i}" ${canCut ? '' : 'disabled'}>เปิดใบตัด</button></td></tr>`;
    }
    html += `</tbody></table></div>`;
  }
  $('ledgerOut').innerHTML = html;
  $('jobSel').addEventListener('change', (e) => { selectedWbs = e.target.value; renderBudgets(); });
  document.querySelectorAll('[data-cut]').forEach((btn) =>
    btn.addEventListener('click', () => openSlip(budgets[+btn.dataset.cut])));
  document.querySelectorAll('[data-sum]').forEach((btn) =>
    btn.addEventListener('click', () => openSummary(budgets[+btn.dataset.sum])));
}

// ---------- หน้าสรุปงบต่อคีย์ + ออก PDF (modal) ----------
async function openSummary(b) {
  $('modalBox').innerHTML = `<h3>สรุปงบ — ${esc(b.category)}</h3>
    <div class="sub">เลขกิจกรรม <span class="mono">${esc(b.act)}</span> • โครงข่าย ${esc(b.network)}</div>
    <div class="balrow"><span>ยอดจัดสรร</span><b>${fmt(b.allocation)}</b></div>
    <div class="balrow"><span>จ่ายแล้วรวม</span><b>${fmt(b.paid)}</b></div>
    <div class="balrow big"><span>คงเหลือ</span><b class="${b.balance < 0 ? 'err' : ''}">${fmt(b.balance)}</b></div>
    <div id="sumList" class="sub">⏳ กำลังโหลดงวด…</div>
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
        <td>${s.pdf ? `<a href="${esc(s.pdf)}" target="_blank">เปิด</a>`
                    : `<button class="btn sec" data-pdf="${esc(s.slipNo)}">ออก PDF</button>`}</td></tr>`;
    });
    $('sumList').innerHTML = html + '</tbody></table>';
    document.querySelectorAll('[data-pdf]').forEach((btn) =>
      btn.addEventListener('click', () => makePdf(btn)));
  } catch (err) {
    $('sumList').innerHTML = `<div class="err">โหลดงวดไม่สำเร็จ: ${esc(err.message)}</div>`;
  }
}

async function makePdf(btn) {
  btn.disabled = true; btn.textContent = '⏳ กำลังออก…';
  try {
    const r = await callApi('makePdf', { slipNo: btn.dataset.pdf });
    const a = document.createElement('a');
    a.href = r.url; a.target = '_blank'; a.textContent = 'เปิด';
    btn.replaceWith(a);
    window.open(r.url, '_blank');
  } catch (err) {
    btn.disabled = false; btn.textContent = 'ออก PDF';
    alert('ออก PDF ไม่สำเร็จ: ' + err.message);
  }
}

// ---------- ฟอร์มเปิดใบตัด (modal) ----------
function openSlip(b) {
  const drivers = settings['พขร.'] || [];
  const today = new Date().toISOString().slice(0, 10);
  $('modalBox').innerHTML = `
    <h3>เปิดใบตัดงบ</h3>
    <div class="sub">${esc(b.category)} • เลขกิจกรรม <span class="mono">${esc(b.act)}</span> • โครงข่าย ${esc(b.network)}</div>
    <div class="field"><label>ชื่องาน</label><input id="f-workName"></div>
    <div class="field"><label>ผู้เบิก</label><input id="f-requester"></div>
    <div class="field"><label>ตำแหน่ง/ที่อยู่</label><input id="f-position"></div>
    <div class="field"><label>ชื่อ พขร.</label>
      <select id="f-driver"><option value="">— เลือก —</option>${drivers.map((d) => `<option>${esc(d)}</option>`).join('')}</select></div>
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
  $('cancelSlip').addEventListener('click', closeModal);
  $('submitSlip').addEventListener('click', () => submitSlip(b));
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
      driver: val('f-driver'), contract: val('f-contract'), slipDate: val('f-slipDate'),
    });
    closeModal();
    $('ledgerOut').insertAdjacentHTML('afterbegin',
      `<div class="ok">✅ บันทึกใบตัดเลขที่ ${r.slipNo} — คงเหลือใหม่ ${fmt(r.balance)}</div>`);
    loadBudgets();
  } catch (err) {
    // server เป็นคนตัดสิน (กันเบิกเกิน/แข่งกันเบิก) — โชว์เหตุผลจาก server
    $('slipErr').textContent = err.message;
    btn.disabled = false;
  }
}
