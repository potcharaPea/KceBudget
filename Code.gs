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

  ensureTab_(ss, TABS.budget, ['คีย์งบ', 'WBS', 'หมายเลขโครงข่าย', 'แผนก', 'ชื่อหมวดงบ', 'เลขกิจกรรม', 'ยอดจัดสรร', 'วันที่ import', 'ไฟล์ต้นทาง']);
  ensureTab_(ss, TABS.ledger, ['เลขที่ใบ', 'คีย์งบ', 'วันที่ตัด', 'จ่ายครั้งนี้', 'คงเหลือหลังตัด', 'ชื่องาน', 'ผู้เบิก', 'ตำแหน่ง', 'ชื่อ พขร.', 'สัญญาจ้าง', 'ลิงก์ PDF', 'ผู้ทำรายการ', 'timestamp']);
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

// นำเข้างบ + จัดการ re-import (4.5)
// data = { fileName, budgets:[{key,wbs,network,dept,category,act,allocation}], confirmKeys:[] }
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

    // เพิ่มคีย์ใหม่
    cls.toAdd.forEach(function (b) {
      // นำหน้า act ด้วย ' บังคับ Sheet เก็บเป็น text ไม่ตัด leading zero (คอลัมน์เลขกิจกรรมโชว์ 0020)
      bTab.sh.appendRow([b.key, b.wbs, b.network, b.dept, b.category, "'" + b.act, b.allocation, now, data.fileName || '']);
    });

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
// data = { key, payNow, workName, requester, position, driver, contract, slipDate }
function apiCreateSlip_(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var budgets = apiGetBudgets_();
    var bud = null;
    for (var i = 0; i < budgets.length; i++) if (budgets[i].key === data.key) { bud = budgets[i]; break; }
    if (!bud) throw new Error('ไม่พบก้อนงบ: ' + data.key);

    var v = validateSlip(bud.balance, data.payNow); // กันเบิกเกิน (4.4) ฝั่ง server
    if (!v.ok) throw new Error(v.reason);

    var payNow = Number(data.payNow);
    var newBalance = round2(bud.balance - payNow);
    var ledSh = ss_().getSheetByName(TABS.ledger);
    var slipNo = ledSh.getLastRow(); // header=row1 → ใบแรก=1

    ledSh.appendRow([
      slipNo, data.key, data.slipDate || new Date(), payNow, newBalance,
      data.workName || '', data.requester || '', data.position || '',
      data.driver || '', data.contract || '', '', // ลิงก์ PDF ว่างไว้ (Phase 3)
      Session.getActiveUser().getEmail(), new Date(),
    ]);
    return { slipNo: slipNo, paid: round2(bud.paid + payNow), balance: newBalance };
  } finally {
    lock.releaseLock();
  }
}

// ---------- Phase 3: สรุปงวด + ออกใบตัดงบ PDF ----------

// ทุกงวด (ใบตัด) ของคีย์งบเดียว — สำหรับหน้าสรุป + ปุ่มออก PDF
function apiGetSlips_(key) {
  return rows_(TABS.ledger).values
    .filter(function (r) { return r[1] === key; })
    .map(function (r) {
      return { slipNo: r[0], date: fmtDate_(r[2]), payNow: Number(r[3]), balance: Number(r[4]),
               workName: r[5], requester: r[6], pdf: r[10] };
    });
}

// ออกใบตัดงบ PDF จาก template Google Doc → เก็บ Drive → เขียนลิงก์กลับ ledger
function apiMakePdf_(slipNo) {
  var led = rows_(TABS.ledger);
  var rowIdx = -1, row = null;
  for (var i = 0; i < led.values.length; i++) {
    if (String(led.values[i][0]) === String(slipNo)) { rowIdx = i; row = led.values[i]; break; }
  }
  if (!row) throw new Error('ไม่พบใบตัดเลขที่ ' + slipNo);
  if (row[10]) return { url: row[10] }; // มี PDF อยู่แล้ว → ไม่สร้างซ้ำ

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

  var map = {
    'เลขใบสำคัญจ่าย': '', 'ชื่องาน': row[5], 'WBS': bud.wbs,
    'วันที่': dp.day, 'เดือน': dp.month, 'ปี': dp.year,
    'ผู้เบิก': row[6], 'ตำแหน่ง': row[7],
    'อนุมัติที่': '', 'อนุมัติลว': '',
    'แผนก': bud.dept, 'หมวดงบ': bud.category, 'โครงข่าย': bud.network, 'เลขกิจกรรม': bud.act,
    'ยอดเงิน_บาท': alloc.baht, 'ยอดเงิน_สต': alloc.sat,
    'จ่ายแล้ว_บาท': paid.baht, 'จ่ายแล้ว_สต': paid.sat,
    'คงเหลือบน_บาท': top.baht, 'คงเหลือบน_สต': top.sat,
    'จ่ายครั้งนี้_บาท': now.baht, 'จ่ายครั้งนี้_สต': now.sat,
    'คงเหลือล่าง_บาท': bottom.baht, 'คงเหลือล่าง_สต': bottom.sat,
  };

  var tmplId = PROP.getProperty('TEMPLATE_DOC_ID');
  if (!tmplId) throw new Error('ยังไม่ได้ตั้งค่า TEMPLATE_DOC_ID (Script Property) — อัปโหลด template เป็น Google Doc แล้วใส่ ID');

  var copy = DriveApp.getFileById(tmplId).makeCopy('ใบตัดงบ ' + slipNo);
  var doc = DocumentApp.openById(copy.getId());
  var body = doc.getBody();
  Object.keys(map).forEach(function (k) {
    body.replaceText('\\{\\{' + k + '\\}\\}', String(map[k])); // {} เป็น regex metachar ต้อง escape
  });
  doc.saveAndClose();

  var pdf = pdfFolder_().createFile(copy.getAs('application/pdf'))
    .setName('ใบตัดงบ_' + slipNo + '_' + key.replace(/\|/g, '-') + '.pdf');
  copy.setTrashed(true); // ทิ้ง Doc ชั่วคราว เหลือแต่ PDF
  var url = pdf.getUrl();

  ss_().getSheetByName(TABS.ledger).getRange(rowIdx + 2, 11).setValue(url); // +2: ข้าม header + 0-based
  return { url: url };
}

// โฟลเดอร์เก็บ PDF (สร้างครั้งแรกครั้งเดียว เก็บ ID ใน Script Property)
function pdfFolder_() {
  var id = PROP.getProperty('PDF_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  var folder = DriveApp.createFolder('ใบตัดงบ PDF — กฟส.คำชะอี');
  PROP.setProperty('PDF_FOLDER_ID', folder.getId());
  return folder;
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

// วันที่แบบสั้น d/m/พ.ศ. สำหรับหน้าสรุป
function fmtDate_(v) {
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.getDate() + '/' + (d.getMonth() + 1) + '/' + (d.getFullYear() + 543);
}
