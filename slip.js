// slip.js — วาดใบตัดงบเป็น SVG A4 ตามพิกัดจริงของ template Google Doc เดิม แล้วสั่งพิมพ์
// พิกัดทุกบรรทัด/เส้น ดึงจาก PDF ที่ Docs export (หน่วย pt, y นับจากล่างขึ้นบนแบบ PDF)
// ผู้ใช้กด "บันทึกเป็น PDF" ในหน้าต่างพิมพ์ — ชื่อไฟล์มาจาก document.title
// แก้หน้าตาฟอร์ม = แก้ LINES/RULES ในไฟล์นี้ (push แล้วทุกสำนักงานได้ทันที)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Docs เรนเดอร์ Sarabun เล็กกว่า Chrome — ขนาดนี้วัดให้ความกว้างเท่า PDF เดิม (Docs 14pt/16pt)
const SIZE = { r: 8.99, b: 9.31, t: 9.72 }; // regular / bold / หัว "ใบตัดงบ"
const PITCH = 18.2; // ระยะบรรทัดของ Docs (ใช้ตอนข้อความยาวต้องขึ้นบรรทัดใหม่)
const PAGE_H = 842;

// ข้อความวางตายตัว [x, y(baseline), แบบ r|b|t, ข้อความ, จัดกลาง?]
const FIXED = [
  [297.36, 772.96, 't', 'ใบตัดงบ', 1],
  [297.36, 736.3, 'b', '{OFFICE}', 1],
  [158.98, 717.35, 'b', 'รายละเอียดการตัดงบค่าใช้จ่าย', 1],
  [438.0, 717.35, 'b', 'ประกอบใบสำคัญจ่ายเลขที่ {REF}', 1],
  [438.0, 570.25, 'b', 'การตัดงบค่าใช้จ่ายหน้างาน', 1],
  [391.31, 514.9, 'b', 'งบค่า {CAT}'], // แท็บในบรรทัด "แผนก" ฝั่งขวาล่าง
  // ตารางเงิน: ป้าย | บาท | สตางค์
  ...[['ยอดเงิน', 'YB', 'YS'], ['จ่ายเงินแล้ว', 'JB', 'JS'], ['คงเหลือ', 'KB', 'KS'], ['จ่ายครั้งนี้', 'CB', 'CS'],
    ['คงเหลือ', 'LB', 'LS'], ['พบช.'], ['พชง.']].flatMap(([lab, b, s], i) => [
    [311.61, 440.1 - 27 * i, 'r', lab],
    ...(b ? [[401.61, 439.35 - 27 * i, 'r', `{${b}}`], [523.86, 439.35 - 27 * i, 'r', `{${s}}`]] : []),
  ]),
];

// ช่องที่ข้อความไหลจากบนลงล่าง (ย่อหน้าละบรรทัด, '' = บรรทัดว่าง) — ยาวเกินขอบ → ตัดคำ ดันบรรทัดถัดไปลง แบบ Docs
// [x, y บรรทัดแรก, ขอบขวา, แบบ, ย่อหน้า[]] · พิกัดจากใบที่ GAS ออกจริง (ไม่ใช่ template ที่ token ยาวจนตัดบรรทัด)
const FLOWS = [
  [24.36, 698.4, 292, 'b', ['', 'รหัสแฟ้ม {FCODE}', 'ชื่องาน {JOB}', '', 'หมายเลขงาน {WBS}', 'โหนด {NODE}', 'ดำเนินการโดย {OPER}']],
  [305.61, 698.4, 574, 'b', ['วันที่ {DD} เดือน {MM} พ.ศ {YY}', 'ผู้เบิก {USR}', 'ตำแหน่ง/ที่อยู่ {POS}']],
  [305.61, 643.8, 0, 'r', ['......................................................................']],
  [24.36, 533.1, 292, 'r', [
    '{CHK_VEH} ค่ายานพาหนะ / เบี้ยเลี้ยง พชง', '{CHK_TRV} ค่าพาหนะ / เบี้ยเลี้ยง พชร(บ)',
    '{CHK_CRN} ค่าแรง พขร.(บ.) {CRN_NAME} {CRN_FROM}-{CRN_TO}',
    '{CHK_DLY} ค่าแรงคนงานรายวัน งวด วันที่ {DLY_FROM}-{DLY_TO}', 'ทีม {DLY_TEAM}', '',
    '{CHK_CON} ค่าแรงจ้างเหมา สัญญาจ้างที่ {CON_NO} ลว. {CON_DATE}', '',
    '{CHK_OIL} ค่าน้ำมันยานพาหนะ', 'ทะเบียน {OIL_PLATE}', '', '{CHK_OTH} อื่นๆ {OTH}']],
  [305.61, 551.3, 574, 'b', ['อนุมัติที่ {APV} ลว. {APD}', 'หมายเลขงาน {WBS}', 'แผนก {DPT}', 'หมายเลขโครงข่าย {NET}', 'เลขที่กิจกรรม {ACT}']],
];

// เส้น [x1, y1, x2, y2] หนา 1pt — เส้นคั่นเต็มแถบ 6 เส้น + ตารางเงิน
const RULES = [
  ...[751.5, 733.5, 714.5, 585.5, 566.5, 151.5].map((y) => [18.0, y, 576.0, y]),
  ...[395.5, 517.5, 557.5].map((x) => [x, 457.0, x, 268.0]),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [395.0, 457.5 - 27 * i, 558.0, 457.5 - 27 * i]),
];

const FONT = "'Sarabun', 'TH Sarabun New', Tahoma, sans-serif";
let ctx;
const width = (s, w) => {
  ctx ||= document.createElement('canvas').getContext('2d');
  ctx.font = `${w === 'r' ? 400 : 700} ${SIZE[w]}px ${FONT}`; // viewBox 1 หน่วย = 1pt → วัดเป็น px ได้ตรง
  return ctx.measureText(s).width;
};
// ตัดบรรทัดตามคำไทย (Intl.Segmenter) เมื่อยาวเกินคอลัมน์ — แบบเดียวกับ Docs ตัดคำในเซลล์
function wrap(text, x, maxX, w) {
  if (!maxX || width(text, w) <= maxX - x) return [text];
  const seg = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter('th', { granularity: 'word' }).segment(text)].map((s) => s.segment) : text.split(/(?<= )/);
  const out = [];
  let cur = '';
  for (const p of seg) {
    if (cur && width(cur + p, w) > maxX - x) { out.push(cur); cur = p.trimStart(); } else cur += p;
  }
  return cur ? out.concat(cur) : out;
}

export function slipSvg({ map, othText }) {
  const m = { ...map, OTH: othText || '...............................' };
  // '(    )' — SVG ยุบช่องว่างติดกัน → ใช้ nbsp (กว้างเท่าช่องว่าง) ให้กล่องติ๊กกว้างเท่า Docs
  for (const k in m) if (k.startsWith('CHK_')) m[k] = String(m[k]).replace(/ /g, '\u00a0');
  const fill = (t) => t.replace(/\{([A-Z_]+)\}/g, (_, k) => m[k] ?? '');
  // ✓ — Docs วาดด้วย MS PGothic (Sarabun ไม่มีตัวนี้) ใหญ่/หนากว่าตัวอักษรรอบข้าง
  const tick = `<tspan font-family="'MS PGothic','Segoe UI Symbol',sans-serif" font-size="${SIZE.r * 1.45}" font-weight="700">✓</tspan>`;
  const text = (x, top, w, s, center) => `<text x="${x}" y="${top}" font-size="${SIZE[w]}" font-weight="${w === 'r' ? 400 : 700}"${center ? ' text-anchor="middle"' : ''}>${esc(s).replace(/✓/g, tick)}</text>`;
  let body = RULES.map(([x1, y1, x2, y2]) =>
    `<line x1="${x1}" y1="${PAGE_H - y1}" x2="${x2}" y2="${PAGE_H - y2}" stroke="#000" stroke-width="1"/>`).join('');
  for (const [x, y, w, t, center] of FIXED) body += text(x, PAGE_H - y, w, fill(t), center);
  for (const [x, y, maxX, w, paras] of FLOWS) {
    let top = PAGE_H - y;
    for (const p of paras) {
      for (const s of p ? wrap(fill(p), x, maxX, w) : ['']) { if (s) body += text(x, top, w, s); top += PITCH; }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 596 842" width="210mm" height="297mm"
    style="font-family:${FONT.replace(/"/g, '')}" fill="#000">${body}</svg>`;
}

const CSS = `
@page { size: A4; margin: 0; }
#printSlip { display: none; }
@media print {
  body > *:not(#printSlip) { display: none !important; }
  #printSlip { display: block !important; }
  html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
  #printSlip svg { display: block; }
}`;

// ใส่ฟอนต์ + CSS ครั้งเดียว — Sarabun จาก Google Fonts (ออฟไลน์ถอยไป Tahoma)
function ensureStyle() {
  if (document.getElementById('slipStyle')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap';
  document.head.appendChild(link);
  const st = document.createElement('style');
  st.id = 'slipStyle'; st.textContent = CSS;
  document.head.appendChild(st);
}

// เตรียมใบตัดในหน้า + รอฟอนต์ (async) — เรียกก่อน printSlip
export async function prepareSlip(doc) {
  ensureStyle();
  // รอฟอนต์ก่อนวัดความกว้าง/พิมพ์ ไม่งั้นตัดบรรทัดผิดและพิมพ์ออกเป็นฟอนต์สำรอง
  await Promise.all([document.fonts.load('400 10px Sarabun'), document.fonts.load('700 10px Sarabun')]).catch(() => {});
  let el = document.getElementById('printSlip');
  if (!el) { el = document.createElement('div'); el.id = 'printSlip'; document.body.appendChild(el); }
  el.innerHTML = slipSvg(doc);
}

// สั่งพิมพ์ (sync) — มือถือต้องเรียกตรงจากการกดปุ่ม ห้ามมี await คั่น (iOS บล็อก print หลัง await)
export function printSlip(doc) {
  const title = document.title;
  document.title = doc.filename; // = ชื่อไฟล์ตอน "บันทึกเป็น PDF"
  addEventListener('afterprint', () => { document.title = title; }, { once: true });
  window.print();
}
