// Code.gs — เว็บแอป GAS: เก็บ state, คำนวณคงเหลือ, validate, จัดการ re-import
// ใช้คู่กับ logic.gs (business logic ล้วน)
//
// วิธี deploy (ครั้งแรก):
//   1) วาง Code.gs + logic.gs ในโปรเจก Apps Script เดียวกัน
//   2) รันฟังก์ชัน setup() หนึ่งครั้ง (อนุญาต scope) → สร้างสเปรดชีต 4 แท็บ ดู URL ใน Log
//   3) Deploy > New deployment > Web app > Execute as: me, Who has access: Anyone
//   4) เอา URL /exec ไปใส่ config.js ฝั่งหน้าเว็บ
// แก้โค้ดภายหลังต้อง Deploy > Manage deployments > แก้ deployment เดิม > Version: New

var PROP = PropertiesService.getScriptProperties();
var SHEET_ID_KEY = 'SHEET_ID';
var TABS = { budget: 'งบ', ledger: 'บันทึกการตัด', revision: 'ประวัติแก้งบ', settings: 'ตั้งค่า' };

// ---------- setup / โครงสร้างชีต ----------
function setup() {
  var id = PROP.getProperty(SHEET_ID_KEY);
  var ss = id ? SpreadsheetApp.openById(id)
              : SpreadsheetApp.create('ใบตัดงบ กฟส.คำชะอี — ฐานข้อมูล');
  if (!id) PROP.setProperty(SHEET_ID_KEY, ss.getId());

  ensureTab_(ss, TABS.budget, ['คีย์งบ', 'WBS', 'หมายเลขโครงข่าย', 'แผนก', 'ชื่อหมวดงบ', 'เลขกิจกรรม', 'ยอดจัดสรร', 'วันที่ import', 'ไฟล์ต้นทาง', 'ชื่องาน', 'ยอดจัดสรรรวม', 'รหัสแฟ้ม', 'ผู้ดำเนินการ']);
  // migrate ชีตที่ deploy ไปแล้ว — เติมหัวคอลัมน์ยอดจัดสรรรวม (11) + รหัสแฟ้ม (12) + ผู้ดำเนินการ (13) ถ้ายังไม่มี
  var bSh = ss.getSheetByName(TABS.budget);
  if (bSh.getRange(1, 11).getValue() !== 'ยอดจัดสรรรวม') bSh.getRange(1, 11).setValue('ยอดจัดสรรรวม');
  if (bSh.getRange(1, 12).getValue() !== 'รหัสแฟ้ม') bSh.getRange(1, 12).setValue('รหัสแฟ้ม');
  if (bSh.getRange(1, 13).getValue() !== 'ผู้ดำเนินการ') bSh.getRange(1, 13).setValue('ผู้ดำเนินการ');
  ensureFileCodes_(bSh); // backfill รหัสแฟ้ม KCE## ให้แถวเก่าที่ยังไม่มี (เรียงตามลำดับแถว = ลำดับ import)
  ensureTab_(ss, TABS.ledger, ['เลขที่ใบ', 'คีย์งบ', 'วันที่ตัด', 'จ่ายครั้งนี้', 'คงเหลือหลังตัด', 'ชื่องาน', 'ผู้เบิก', 'ตำแหน่ง', 'ชื่อ พขร.', 'สัญญาจ้าง', 'เลขใบสำคัญจ่าย', 'ผู้ทำรายการ', 'timestamp', 'clientId', 'ลว.สัญญา', 'รายละเอียด']);
  // migrate — เติมหัวคอลัมน์ clientId (14) + ลว.สัญญา (15) + รายละเอียด JSON (16) ถ้ายังไม่มี
  var ledSh0 = ss.getSheetByName(TABS.ledger);
  if (ledSh0.getRange(1, 14).getValue() !== 'clientId') ledSh0.getRange(1, 14).setValue('clientId');
  if (ledSh0.getRange(1, 15).getValue() !== 'ลว.สัญญา') ledSh0.getRange(1, 15).setValue('ลว.สัญญา');
  if (ledSh0.getRange(1, 16).getValue() !== 'รายละเอียด') ledSh0.getRange(1, 16).setValue('รายละเอียด');
  ensureTab_(ss, TABS.revision, ['คีย์งบ', 'ยอดเก่า', 'ยอดใหม่', 'วันที่', 'หมายเหตุ', 'ผู้แก้']);
  ensureTab_(ss, TABS.settings, ['ประเภท', 'ค่า']);
  // ใส่ตัวอย่างประเภท พขร. ถ้าแท็บตั้งค่ายังว่าง
  var setSh = ss.getSheetByName(TABS.settings);
  if (setSh.getLastRow() === 1) setSh.appendRow(['พขร.', '(ใส่ชื่อ พขร. ที่นี่)']);

  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);

  Logger.log('สเปรดชีต: ' + ss.getUrl());
  return ss.getUrl();
}

// รหัสแฟ้ม KCE## — 1 WBS = 1 แฟ้ม, รันตามลำดับที่ import (คอลัมน์ 12 ของแท็บงบ)
// backfill แถวที่ยังไม่มีรหัสตามลำดับแถว (= ลำดับ import) → คืน { map:{wbs:code}, maxNum }
function ensureFileCodes_(sh) {
  var v = sh.getDataRange().getValues();
  var map = {}, maxNum = 0;
  for (var i = 1; i < v.length; i++) { // รอบแรก: เก็บรหัสที่มี + หาเลขสูงสุด
    var code = v[i][11];
    if (code) {
      map[v[i][1]] = code;
      var n = Number(String(code).replace(/^KCE/, ''));
      if (n > maxNum) maxNum = n;
    }
  }
  for (var i = 1; i < v.length; i++) { // รอบสอง: แถวที่ยังไม่มีรหัส → กำหนดใหม่, ทั้ง WBS ใช้รหัสเดียว
    var wbs = v[i][1];
    if (!map[wbs]) map[wbs] = 'KCE' + pad2_(++maxNum);
    if (v[i][11] !== map[wbs]) sh.getRange(i + 1, 12).setValue(map[wbs]);
  }
  return { map: map, maxNum: maxNum };
}
function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function ensureTab_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(header);
  return sh;
}

// ---------- router ----------
function doGet() {
  return json_({ ok: true, service: 'ใบตัดงบ กฟส.คำชะอี', tabs: Object.keys(TABS).map(function (k) { return TABS[k]; }) });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var data = req.data || {};
    var result;
    switch (req.action) {
      case 'getBudgets': result = apiGetBudgets_(); break;
      case 'getSettings': result = apiGetSettings_(); break;
      case 'importBudget': result = apiImportBudget_(data); break;
      case 'createSlip': result = apiCreateSlip_(data); break;
      case 'getSlips': result = apiGetSlips_(data.key); break;
      case 'makePdf': result = apiMakePdf_(data.slipNo); break;
      case 'deleteFile': result = apiDeleteFile_(data); break;
      case 'deleteNetwork': result = apiDeleteNetwork_(data); break;
      case 'addDriver': result = apiAddSetting_('พขร.', data.name); break;
      case 'addRequester': result = apiAddSetting_('ผู้เบิก', data.name); break;
      case 'addCompany': result = apiAddSetting_('บริษัท', data.name); break;
      case 'setWbsTotal': result = apiSetWbsTotal_(data); break;
      case 'setOper': result = apiSetOper_(data); break;
      case 'editWbs': result = apiEditWbs_(data); break;
      default: throw new Error('ไม่รู้จัก action: ' + req.action);
    }
    return json_({ ok: true, result: result });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- helpers อ่านชีต ----------
function ss_() { return SpreadsheetApp.openById(PROP.getProperty(SHEET_ID_KEY)); }

function rows_(tab) {
  var sh = ss_().getSheetByName(tab);
  var values = sh.getDataRange().getValues();
  values.shift(); // ตัด header
  return { sh: sh, values: values };
}

function ledgerLite_() {
  return rows_(TABS.ledger).values.map(function (r) { return { key: r[1], payNow: r[3] }; });
}

// ---------- API ----------
// รายการก้อนงบ + คงเหลือที่คำนวณสด (server)
function apiGetBudgets_() {
  var led = ledgerLite_();
  return rows_(TABS.budget).values.map(function (r) {
    var allocation = Number(r[6]);
    var paid = sumPaid(led, r[0]);
    return {
      // เลขกิจกรรมดึงจากคีย์ (ปลอดภัยจาก Sheet ตัด leading zero — คีย์เก็บ "0020" ครบ)
      key: r[0], wbs: r[1], network: r[2], dept: r[3], category: r[4], act: String(r[0]).split('|')[2],
      allocation: allocation, paid: paid, balance: round2(allocation - paid),
      workName: r[9] || '', // ชื่องาน (กรอกครั้งเดียวตอน import → prefill ตอนเปิดใบตัด)
      wbsTotal: (r[10] === '' || r[10] === undefined || r[10] === null) ? null : Number(r[10]), // ยอดจัดสรรรวมทั้ง WBS
      fileCode: r[11] || '', // รหัสแฟ้ม KCE## (1 WBS = 1 รหัส)
      oper: r[12] || '', // ผู้ดำเนินการ (กฟภ. หรือชื่อบริษัท)
      imported: r[7] ? new Date(r[7]).toISOString() : '', // วันที่ import (ใช้จัดกลุ่มแฟ้มตามวันที่สร้าง)
    };
  });
}

// master data สำหรับ dropdown จัดกลุ่มตามประเภท { 'พขร.': [...], ... }
function apiGetSettings_() {
  var out = {};
  rows_(TABS.settings).values.forEach(function (r) {
    var type = r[0], val = r[1];
    if (!type || val === '' || val === '(ใส่ชื่อ พขร. ที่นี่)') return;
    if (!out[type]) out[type] = [];
    out[type].push(val);
  });
  return out;
}

// เพิ่มค่าลงแท็บตั้งค่าตามประเภท (พขร./ผู้เบิก) กันซ้ำ → คืนรายชื่อล่าสุดของประเภทนั้นให้ dropdown
function apiAddSetting_(type, name) {
  name = String(name || '').trim();
  if (!name) throw new Error('ยังไม่ได้ใส่ชื่อ');
  var existing = apiGetSettings_()[type] || [];
  if (existing.indexOf(name) < 0) ss_().getSheetByName(TABS.settings).appendRow([type, name]);
  return apiGetSettings_()[type] || [];
}

// นำเข้างบ + จัดการ re-import (4.5)
// data = { fileName, workName, budgets:[{key,wbs,network,dept,category,act,allocation}], confirmKeys:[] }
function apiImportBudget_(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var bTab = rows_(TABS.budget);
    var existing = bTab.values.map(function (r) { return { key: r[0], allocation: r[6] }; });
    var led = ledgerLite_();
    var paidByKey = {};
    existing.forEach(function (b) { paidByKey[b.key] = sumPaid(led, b.key); });

    var cls = classifyReimport(existing, data.budgets || [], paidByKey);
    var confirm = {};
    (data.confirmKeys || []).forEach(function (k) { confirm[k] = true; });
    var now = new Date();
    var user = Session.getActiveUser().getEmail();
    // ยอดจัดสรรรวมทั้ง WBS (ดึงจากบรรทัดสรุป best-effort — null ถ้าไฟล์นี้ไม่มีบรรทัด → กรอกมือทีหลัง)
    var wbsTotal = (data.wbsTotal === null || data.wbsTotal === undefined || data.wbsTotal === '') ? '' : Number(data.wbsTotal);

    // รหัสแฟ้ม: WBS เดิม → รหัสเดิม, WBS ใหม่ → รันเลขถัดไป (backfill แถวเก่าที่ยังไม่มีด้วย)
    var wbs = (data.budgets && data.budgets[0]) ? data.budgets[0].wbs : '';
    var fc = ensureFileCodes_(bTab.sh);
    var fileCode = wbs ? (fc.map[wbs] || 'KCE' + pad2_(fc.maxNum + 1)) : '';

    var oper = data.oper || ''; // ผู้ดำเนินการ: "กฟภ." หรือชื่อบริษัท

    // เพิ่มคีย์ใหม่
    cls.toAdd.forEach(function (b) {
      // นำหน้า act ด้วย ' บังคับ Sheet เก็บเป็น text ไม่ตัด leading zero (คอลัมน์เลขกิจกรรมโชว์ 0020)
      bTab.sh.appendRow([b.key, b.wbs, b.network, b.dept, b.category, "'" + b.act, b.allocation, now, data.fileName || '', data.workName || '', wbsTotal, fileCode, oper]);
    });
    // WBS เดิม (re-import) → เซ็ตผู้ดำเนินการทุกแถวถ้าส่งค่ามา
    if (oper && wbs) setColForWbs_(bTab.sh, wbs, 13, oper);

    // เติมยอดจัดสรรรวมให้ทุกแถวของ WBS นี้ (กรณี re-import ไฟล์สรุปหลังไฟล์อื่น) — เฉพาะเมื่อดึงได้
    if (wbsTotal !== '' && wbs) setColForWbs_(bTab.sh, wbs, 11, wbsTotal);

    // อัปเดตที่ยืนยันแล้ว + log ประวัติแก้งบ (ledger เดิมไม่แตะ)
    var revSh = ss_().getSheetByName(TABS.revision);
    var updated = [], pending = [];
    cls.toConfirm.forEach(function (c) {
      if (confirm[c.key]) {
        updateAllocation_(bTab.sh, c.key, c.newVal, now, data.fileName);
        revSh.appendRow([c.key, c.oldVal, c.newVal, now,
          're-import' + (c.negativeRemaining ? ' (⚠ ยอดใหม่ < ที่เบิกแล้ว ' + c.paid.toFixed(2) + ')' : ''), user]);
        updated.push(c.key);
      } else {
        pending.push(c);
      }
    });

    return {
      added: cls.toAdd.map(function (b) { return b.key; }),
      unchanged: cls.unchanged.length,
      updated: updated,
      needConfirm: pending, // [{key, oldVal, newVal, paid, negativeRemaining}] ให้หน้าเว็บถามยืนยัน
    };
  } finally {
    lock.releaseLock();
  }
}

// เลขใบตัดถัดไป = max ที่มีอยู่ + 1 (กันเลขซ้ำเมื่อมีการลบแถว)
function nextSlipNo_(sh) {
  var v = sh.getDataRange().getValues(), max = 0;
  for (var i = 1; i < v.length; i++) { var n = Number(v[i][0]); if (n > max) max = n; }
  return max + 1;
}

// ลบทั้งแฟ้ม (WBS) — งบทุกหมวด + ใบตัดทุกใบของ WBS นั้น (ยืนยันด้วยรหัสผ่าน)
// data = { wbs, password }
function apiDeleteFile_(data) {
  if (String(data.password) !== '509758') throw new Error('รหัสผ่านไม่ถูกต้อง');
  if (!data.wbs) throw new Error('ไม่ระบุหมายเลขงาน (WBS)');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var wbs = data.wbs;
    var budgets = deleteRowsWhere_(ss_().getSheetByName(TABS.budget), function (r) { return r[1] === wbs; });
    var slips = deleteRowsWhere_(ss_().getSheetByName(TABS.ledger), function (r) { return String(r[1]).split('|')[0] === wbs; });
    return { budgets: budgets, slips: slips };
  } finally {
    lock.releaseLock();
  }
}

// ลบเลขโครงข่ายเดียวในแฟ้ม — งบทุกหมวด + ใบตัดทุกใบของโครงข่ายนั้น (ยืนยันด้วยรหัสผ่าน)
// data = { wbs, network, password }
function apiDeleteNetwork_(data) {
  if (String(data.password) !== '509758') throw new Error('รหัสผ่านไม่ถูกต้อง');
  if (!data.network) throw new Error('ไม่ระบุโครงข่าย'); // wbs ว่างได้ (แฟ้มเก่าที่อ่าน WBS ไม่ได้)
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var wbs = String(data.wbs || ''), net = data.network;
    var budgets = deleteRowsWhere_(ss_().getSheetByName(TABS.budget), function (r) { return r[1] === wbs && r[2] === net; });
    var slips = deleteRowsWhere_(ss_().getSheetByName(TABS.ledger), function (r) {
      var p = String(r[1]).split('|'); return p[0] === wbs && p[1] === net; // คีย์ = wbs|network|act
    });
    return { budgets: budgets, slips: slips };
  } finally {
    lock.releaseLock();
  }
}

// ลบแถวที่เข้าเงื่อนไข (ข้าม header) — วนจากล่างขึ้นบนกัน index เลื่อน
function deleteRowsWhere_(sh, pred) {
  var v = sh.getDataRange().getValues(), n = 0;
  for (var i = v.length - 1; i >= 1; i--) { // i=0 = header
    if (pred(v[i])) { sh.deleteRow(i + 1); n++; }
  }
  return n;
}

// แก้ยอดจัดสรรรวมทั้ง WBS ด้วยมือ (กรณีดึง auto ไม่ได้ หรือต้องการแก้) → อัปเดตทุกแถวของ WBS นั้น
// data = { wbs, total }
function apiSetWbsTotal_(data) {
  var wbs = data.wbs;
  var total = Number(data.total);
  if (!wbs) throw new Error('ไม่ระบุหมายเลขงาน (WBS)');
  if (isNaN(total) || total < 0) throw new Error('ยอดจัดสรรรวมไม่ถูกต้อง');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var n = setColForWbs_(ss_().getSheetByName(TABS.budget), wbs, 11, total);
    if (!n) throw new Error('ไม่พบก้อนงบของ WBS: ' + wbs);
    return { wbs: wbs, total: total, rows: n };
  } finally {
    lock.releaseLock();
  }
}

// เปลี่ยนผู้ดำเนินการทั้งแฟ้ม (ข้อ 5) — data = { wbs, oper }
function apiSetOper_(data) {
  var wbs = data.wbs, oper = String(data.oper || '').trim();
  if (!wbs) throw new Error('ไม่ระบุหมายเลขงาน (WBS)');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var n = setColForWbs_(ss_().getSheetByName(TABS.budget), wbs, 13, oper);
    if (!n) throw new Error('ไม่พบก้อนงบของ WBS: ' + wbs);
    return { wbs: wbs, oper: oper, rows: n };
  } finally { lock.releaseLock(); }
}

// แก้ WBS ทั้งแฟ้ม (ข้อ 3 — กรณีอ่านผิด) — เปลี่ยน budget (คีย์+WBS) + ledger (คีย์) + log ประวัติ
// data = { oldWbs, newWbs }
function apiEditWbs_(data) {
  var oldWbs = String(data.oldWbs || '').trim(), newWbs = String(data.newWbs || '').trim();
  if (!newWbs) throw new Error('ต้องระบุ WBS ใหม่'); // oldWbs ว่างได้ (แฟ้มเก่าที่อ่าน WBS ไม่ได้)
  if (oldWbs === newWbs) return { changed: 0 };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var bSh = ss_().getSheetByName(TABS.budget);
    var bv = bSh.getDataRange().getValues(), bn = 0;
    for (var i = 1; i < bv.length; i++) {
      if (bv[i][1] === oldWbs) {
        bSh.getRange(i + 1, 1).setValue(String(bv[i][0]).replace(oldWbs, newWbs)); // คีย์ = wbs|net|act
        bSh.getRange(i + 1, 2).setValue(newWbs);
        bn++;
      }
    }
    if (!bn) throw new Error('ไม่พบก้อนงบของ WBS: ' + oldWbs);
    var lSh = ss_().getSheetByName(TABS.ledger); // คีย์ในใบตัดขึ้นต้นด้วย wbs|
    var lv = lSh.getDataRange().getValues();
    for (var j = 1; j < lv.length; j++) {
      if (String(lv[j][1]).split('|')[0] === oldWbs) lSh.getRange(j + 1, 2).setValue(String(lv[j][1]).replace(oldWbs, newWbs));
    }
    ss_().getSheetByName(TABS.revision).appendRow([oldWbs, oldWbs, newWbs, new Date(), 'แก้ WBS', Session.getActiveUser().getEmail()]);
    return { changed: bn, oldWbs: oldWbs, newWbs: newWbs };
  } finally { lock.releaseLock(); }
}

// เซ็ตค่าใน 1 คอลัมน์ให้ทุกแถวที่ WBS (คอลัมน์ 2) ตรง — คืนจำนวนแถวที่แก้
function setColForWbs_(sh, wbs, col, val) {
  var v = sh.getDataRange().getValues(), n = 0;
  for (var i = 1; i < v.length; i++) {
    if (v[i][1] === wbs) { sh.getRange(i + 1, col).setValue(val); n++; }
  }
  return n;
}

function updateAllocation_(sh, key, newVal, now, fileName) {
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sh.getRange(i + 1, 7).setValue(newVal);       // ยอดจัดสรร
      sh.getRange(i + 1, 8).setValue(now);          // วันที่ import
      sh.getRange(i + 1, 9).setValue(fileName || '');
      return;
    }
  }
}

// เปิดใบตัดงบ 1 ใบ — validate กันเบิกเกินฝั่ง server + ล็อกกันเบิกซ้ำพร้อมกัน
// data = { key, payNow, workName, requester, position, driver, contract, slipDate, ref }
function apiCreateSlip_(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // idempotent: ถ้า clientId นี้เคยบันทึกแล้ว (retry หลัง response หายเป็น HTML) → คืนใบเดิม ไม่เขียนซ้ำ
    if (data.clientId) {
      var lv = rows_(TABS.ledger).values;
      for (var d = 0; d < lv.length; d++) {
        if (String(lv[d][13]) === String(data.clientId)) {
          return { slipNo: lv[d][0], paid: null, balance: Number(lv[d][4]), duplicate: true };
        }
      }
    }

    var budgets = apiGetBudgets_();
    var bud = null;
    for (var i = 0; i < budgets.length; i++) if (budgets[i].key === data.key) { bud = budgets[i]; break; }
    if (!bud) throw new Error('ไม่พบก้อนงบ: ' + data.key);

    var v = validateSlip(bud.balance, data.payNow); // กันเบิกเกินรายหมวด (4.4) ฝั่ง server
    if (!v.ok) throw new Error(v.reason);

    var payNow = Number(data.payNow);

    // เพดานระดับทั้งงาน: ตัดรวมทุกหมวดต้องไม่เกินยอดจัดสรรรวมทั้งงาน (ถ้าตั้งยอดไว้)
    var wbsPaid = 0;
    for (var k = 0; k < budgets.length; k++) if (budgets[k].wbs === bud.wbs) wbsPaid += budgets[k].paid;
    var cap = validateWbsCap(bud.wbsTotal, round2(wbsPaid), payNow);
    if (!cap.ok) throw new Error(cap.reason);

    var newBalance = round2(bud.balance - payNow);
    var ledSh = ss_().getSheetByName(TABS.ledger);
    var slipNo = nextSlipNo_(ledSh); // max+1 (กัน slipNo ซ้ำหลังลบแฟ้ม — ไม่พึ่งจำนวนแถว)

    ledSh.appendRow([
      slipNo, data.key, data.slipDate || new Date(), payNow, newBalance,
      data.workName || '', data.requester || '', data.position || '',
      data.driver || '', data.contract || '', data.ref || '', // สัญญาจ้าง=CON_NO, เลขใบสำคัญจ่าย
      Session.getActiveUser().getEmail(), new Date(), data.clientId || '', // clientId กันตัดซ้ำ
      data.conDate || '', data.extra || '', // 15 ลว.สัญญา, 16 รายละเอียด (JSON checkbox+ชื่อ/งวด/ทีม)
    ]);
    return { slipNo: slipNo, paid: round2(bud.paid + payNow), balance: newBalance };
  } finally {
    lock.releaseLock();
  }
}

// ---------- Phase 3: สรุปงวด + ออกใบตัดงบ PDF ----------

// งวดระดับแฟ้ม: อันดับใบตัด (เรียงตามเลขใบ = ตามเวลา) ในบรรดาใบทุกคีย์ของ WBS เดียวกัน เริ่มที่ 1
// slipNo เป็น id ทั้ง ledger (5,6,...) แต่ผู้ใช้อยากเห็นงวดของแต่ละแฟ้มเริ่มที่ 1 → แยกเลขงวดออกจาก id
function periodMap_(ledgerValues, wbs) {
  var m = {};
  ledgerValues.filter(function (r) { return String(r[1]).split('|')[0] === wbs; })
    .sort(function (a, b) { return Number(a[0]) - Number(b[0]); })
    .forEach(function (r, i) { m[r[0]] = i + 1; });
  return m;
}

// ทุกงวด (ใบตัด) ของคีย์งบเดียว — สำหรับหน้าสรุป + ปุ่มออก PDF (period = งวดของแฟ้ม, slipNo = id ภายใน)
function apiGetSlips_(key) {
  var vals = rows_(TABS.ledger).values;
  var period = periodMap_(vals, String(key).split('|')[0]);
  return vals
    .filter(function (r) { return r[1] === key; })
    .map(function (r) {
      return { slipNo: r[0], period: period[r[0]], date: fmtDate_(r[2]), payNow: Number(r[3]), balance: Number(r[4]),
               workName: r[5], requester: r[6] };
    });
}

// ออกใบตัดงบ PDF จาก template Google Doc → ส่ง bytes ให้เครื่องโหลด (ไม่เก็บ Drive)
function apiMakePdf_(slipNo) {
  var led = rows_(TABS.ledger);
  var row = null;
  for (var i = 0; i < led.values.length; i++) {
    if (String(led.values[i][0]) === String(slipNo)) { row = led.values[i]; break; }
  }
  if (!row) throw new Error('ไม่พบใบตัดเลขที่ ' + slipNo);

  var key = row[1];
  var bud = null, budgets = apiGetBudgets_();
  for (var j = 0; j < budgets.length; j++) if (budgets[j].key === key) { bud = budgets[j]; break; }
  if (!bud) throw new Error('ไม่พบก้อนงบของใบตัดนี้: ' + key);

  // จ่ายแล้ว = ยอดเบิกทุกใบก่อนหน้าใบนี้ (คีย์เดียวกัน, เลขใบน้อยกว่า)
  var paidBefore = round2(led.values
    .filter(function (r) { return r[1] === key && Number(r[0]) < Number(slipNo); })
    .reduce(function (s, r) { return s + Number(r[3] || 0); }, 0));

  var payNow = Number(row[3]);
  var alloc = splitMoney_(bud.allocation);
  var paid = splitMoney_(paidBefore);
  var top = splitMoney_(round2(bud.allocation - paidBefore));
  var now = splitMoney_(payNow);
  var bottom = splitMoney_(Number(row[4]));
  var dp = thaiDateParts_(row[2]);

  // รายละเอียด checkbox หน้างาน (JSON คอลัมน์ 16) — submit เคลียร์รายละเอียดที่ไม่ติ๊กไว้แล้ว
  var extra = {};
  try { extra = row[15] ? JSON.parse(row[15]) : {}; } catch (e) { extra = {}; }
  var chk = extra.chk || {};
  function ck_(on) { return on ? '(✓)' : '(    )'; }

  // คีย์ = โค้ดใน template (ปีกกาเดี่ยว {CODE})
  var map = {
    REF: row[10] || '', JOB: row[5], WBS: bud.wbs,
    DD: dp.day, MM: dp.month, YY: dp.year,
    USR: row[6], POS: row[7],
    APV: extra.apv || '', // อนุมัติที่ (กรอกในแอป) — APD ตั้งด้านล่าง (format วันที่ไทย)
    DPT: bud.dept, CAT: bud.category, NET: bud.network, ACT: bud.act,
    YB: alloc.baht, YS: alloc.sat,
    JB: paid.baht, JS: paid.sat,
    KB: top.baht, KS: top.sat,
    CB: now.baht, CS: now.sat,
    LB: bottom.baht, LS: bottom.sat,
    // 8 checkbox หน้างาน + รายละเอียดของช่องที่ติ๊ก
    CHK_VEH: ck_(chk.VEH), CHK_TRV: ck_(chk.TRV), CHK_CRN: ck_(chk.CRN), CHK_CRT: ck_(chk.CRT),
    CHK_DLY: ck_(chk.DLY), CHK_CON: ck_(chk.CON), CHK_OIL: ck_(chk.OIL), CHK_OTH: ck_(chk.OTH),
    CRN_NAME: extra.crnName || '', CRT_NAME: extra.crtName || '',
    DLY_TEAM: extra.dlyTeam || '',
    CON_NO: row[9] || '', CON_DATE: thaiDateShort_(row[14]), // สัญญาจ้างที่ + ลว. (ไทย)
    APD: thaiDateShort_(extra.apd), // อนุมัติ ลว. (ไทย) — override APV/APD ด้านบน
    NODE: extractNode_(bud.wbs), OPER: bud.oper || '', // โหนด (ข้อ 4) + ผู้ดำเนินการ (ข้อ 5)
    FCODE: bud.fileCode || '', // รหัสแฟ้ม KCE## บนหัวใบตัด (ข้อ 1)
    // ช่วงวันที่ค่าแรง 2 ช่อง (ข้อ 2) — from-to วันที่ไทยสั้น
    CRN_FROM: thaiDateShort_(extra.crnFrom), CRN_TO: thaiDateShort_(extra.crnTo),
    CRT_FROM: thaiDateShort_(extra.crtFrom), CRT_TO: thaiDateShort_(extra.crtTo),
    DLY_FROM: thaiDateShort_(extra.dlyFrom), DLY_TO: thaiDateShort_(extra.dlyTo),
  };

  var tmplId = PROP.getProperty('TEMPLATE_DOC_ID');
  if (!tmplId) throw new Error('ยังไม่ได้ตั้งค่า TEMPLATE_DOC_ID (Script Property) — อัปโหลด template เป็น Google Doc แล้วใส่ ID');

  var copy = DriveApp.getFileById(tmplId).makeCopy('ใบตัดงบ ' + slipNo);
  var doc = DocumentApp.openById(copy.getId());
  var body = doc.getBody();
  Object.keys(map).forEach(function (k) {
    body.replaceText('\\{' + k + '\\}', String(map[k])); // {} เป็น regex metachar ต้อง escape
  });
  // อื่นๆ: ถ้ากรอกข้อความ → แทนจุดไข่ปลาหลัง "อื่นๆ" (template ไม่มี token ตรงนี้ ใช้ replace จุดแทน)
  if (extra.othText) body.replaceText('อื่นๆ\\s*\\.{3,}', 'อื่นๆ  ' + extra.othText);
  doc.saveAndClose();

  var period = periodMap_(led.values, String(key).split('|')[0])[slipNo] || slipNo;
  var blob = copy.getAs('application/pdf');
  copy.setTrashed(true); // ทิ้ง Doc ชั่วคราว — ไม่เก็บ PDF ใน Drive ส่ง bytes ให้เครื่องโหลด
  return {
    filename: 'ใบตัดงบ_งวด' + period + '_' + key.replace(/\|/g, '-') + '.pdf',
    b64: Utilities.base64Encode(blob.getBytes()),
  };
}

// เลขโหนดท้าย WBS เช่น .02.2 → "02.2" ('' ถ้าไม่มี) — ข้อ 4
function extractNode_(wbs) {
  var m = String(wbs || '').match(/\.(\d{2}\.\d)$/);
  return m ? m[1] : '';
}

// แยกจำนวนเงินเป็น { baht: "12,345", sat: "60" }
function splitMoney_(x) {
  var n = round2(x), neg = n < 0; n = Math.abs(n);
  var baht = Math.floor(n + 1e-9);
  var sat = Math.round((n - baht) * 100);
  if (sat === 100) { baht += 1; sat = 0; }
  return {
    baht: (neg ? '-' : '') + String(baht).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    sat: (sat < 10 ? '0' : '') + sat,
  };
}

// วันที่ไทยแยกส่วน { day, month(ชื่อเต็ม), year(พ.ศ.) }
function thaiDateParts_(v) {
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) d = new Date();
  var M = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
           'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  return { day: String(d.getDate()), month: M[d.getMonth()], year: String(d.getFullYear() + 543) };
}

// วันที่ไทยแบบสั้น "8 ก.ค. 2569" สำหรับบรรทัด ลว. — รับได้ทั้ง Date (เซลล์ชีต auto-parse) และ "YYYY-MM-DD" (JSON) และค่าว่าง
function thaiDateShort_(v) {
  if (!v) return '';
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  var M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return d.getDate() + ' ' + M[d.getMonth()] + ' ' + (d.getFullYear() + 543);
}

// วันที่แบบสั้น d/m/พ.ศ. สำหรับหน้าสรุป
function fmtDate_(v) {
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.getDate() + '/' + (d.getMonth() + 1) + '/' + (d.getFullYear() + 543);
}
