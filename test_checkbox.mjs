// เทส logic checkbox หน้างาน → 14 token (mirror submitSlip gating + apiMakePdf map)
// รัน: node test_checkbox.mjs
import assert from 'node:assert';

// --- ฝั่งแอป (submitSlip): เก็บเฉพาะรายละเอียดของช่องที่ติ๊ก ---
function buildPayload(form) {
  const chk = {};
  ['VEH', 'TRV', 'CRN', 'CRT', 'DLY', 'CON', 'OIL', 'OTH'].forEach((k) => { chk[k] = !!form['chk-' + k]; });
  const extra = {
    chk,
    crnName: chk.CRN ? form.crnName : '',
    crtName: chk.CRT ? form.crtName : '',
    dlyDate: chk.DLY ? form.dlyDate : '',
    dlyTeam: chk.DLY ? form.dlyTeam : '',
  };
  return {
    contract: chk.CON ? form.conNo : '',   // → CON_NO
    conDate: chk.CON ? form.conDate : '',  // → CON_DATE
    extra: JSON.stringify(extra),
  };
}

// --- ฝั่ง GAS (apiMakePdf): row → 14 token ---
function buildTokens(row) {
  const extra = row.extra ? JSON.parse(row.extra) : {};
  const chk = extra.chk || {};
  const ck = (on) => (on ? '(✓)' : '(    )');
  return {
    CHK_VEH: ck(chk.VEH), CHK_TRV: ck(chk.TRV), CHK_CRN: ck(chk.CRN), CHK_CRT: ck(chk.CRT),
    CHK_DLY: ck(chk.DLY), CHK_CON: ck(chk.CON), CHK_OIL: ck(chk.OIL), CHK_OTH: ck(chk.OTH),
    CRN_NAME: extra.crnName || '', CRT_NAME: extra.crtName || '',
    DLY_DATE: extra.dlyDate || '', DLY_TEAM: extra.dlyTeam || '',
    CON_NO: row.contract || '', CON_DATE: row.conDate || '',
  };
}

// เคส 1: ติ๊ก CRN + CON, กรอกครบ → โผล่เฉพาะที่ติ๊ก
{
  const p = buildPayload({ 'chk-CRN': true, crnName: 'สมชาย', crtName: 'ไม่ติ๊กก็ไม่เก็บ',
    'chk-CON': true, conNo: '12/2569', conDate: '2026-07-08', 'chk-VEH': true });
  const t = buildTokens(p);
  assert.equal(t.CHK_VEH, '(✓)');
  assert.equal(t.CHK_CRN, '(✓)');
  assert.equal(t.CHK_CRT, '(    )');
  assert.equal(t.CRN_NAME, 'สมชาย');
  assert.equal(t.CRT_NAME, '');            // ไม่ติ๊ก → ว่าง (ถึงจะเผลอกรอก)
  assert.equal(t.CON_NO, '12/2569');
  assert.equal(t.CON_DATE, '2026-07-08');
}

// เคส 2: ไม่ติ๊กอะไรเลย → checkbox ว่างหมด รายละเอียดว่างหมด
{
  const p = buildPayload({});
  const t = buildTokens(p);
  for (const k of ['CHK_VEH', 'CHK_TRV', 'CHK_CRN', 'CHK_CRT', 'CHK_DLY', 'CHK_CON', 'CHK_OIL', 'CHK_OTH']) {
    assert.equal(t[k], '(    )', k + ' ต้องว่าง');
  }
  assert.equal(t.CON_NO, '');
  assert.equal(t.DLY_DATE, '');
}

// เคส 3: ledger เก่า (ยังไม่มีคอลัมน์ extra) → ไม่ throw, ทุก checkbox ว่าง
{
  const t = buildTokens({ extra: '', contract: '', conDate: '' });
  assert.equal(t.CHK_CON, '(    )');
  assert.equal(t.CRN_NAME, '');
}

console.log('OK — checkbox → 14 token ครบทุกเคส');
