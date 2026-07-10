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
    crnFrom: chk.CRN ? form.crnFrom : '', crnTo: chk.CRN ? form.crnTo : '',
    crtName: chk.CRT ? form.crtName : '',
    crtFrom: chk.CRT ? form.crtFrom : '', crtTo: chk.CRT ? form.crtTo : '',
    dlyFrom: chk.DLY ? form.dlyFrom : '', dlyTo: chk.DLY ? form.dlyTo : '',
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
    CRN_FROM: extra.crnFrom || '', CRN_TO: extra.crnTo || '',
    CRT_FROM: extra.crtFrom || '', CRT_TO: extra.crtTo || '',
    DLY_FROM: extra.dlyFrom || '', DLY_TO: extra.dlyTo || '', DLY_TEAM: extra.dlyTeam || '',
    CON_NO: row.contract || '', CON_DATE: row.conDate || '',
  };
}

// เคส 1: ติ๊ก CRN + CON, กรอกครบ → โผล่เฉพาะที่ติ๊ก (รวมช่วงวันที่ CRN)
{
  const p = buildPayload({ 'chk-CRN': true, crnName: 'สมชาย', crnFrom: '2026-07-01', crnTo: '2026-07-05',
    crtName: 'ไม่ติ๊กก็ไม่เก็บ', crtFrom: '2026-07-02',
    'chk-CON': true, conNo: '12/2569', conDate: '2026-07-08', 'chk-VEH': true });
  const t = buildTokens(p);
  assert.equal(t.CHK_VEH, '(✓)');
  assert.equal(t.CHK_CRN, '(✓)');
  assert.equal(t.CHK_CRT, '(    )');
  assert.equal(t.CRN_NAME, 'สมชาย');
  assert.equal(t.CRN_FROM, '2026-07-01');
  assert.equal(t.CRN_TO, '2026-07-05');
  assert.equal(t.CRT_NAME, '');            // ไม่ติ๊ก → ว่าง (ถึงจะเผลอกรอก)
  assert.equal(t.CRT_FROM, '');            // ไม่ติ๊ก → ช่วงวันที่ก็ว่าง
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
  assert.equal(t.DLY_FROM, '');
  assert.equal(t.DLY_TO, '');
}

// เคส 3: ledger เก่า (ยังไม่มีคอลัมน์ extra) → ไม่ throw, ทุก checkbox ว่าง
{
  const t = buildTokens({ extra: '', contract: '', conDate: '' });
  assert.equal(t.CHK_CON, '(    )');
  assert.equal(t.CRN_NAME, '');
}

console.log('OK — checkbox → 14 token ครบทุกเคส');
