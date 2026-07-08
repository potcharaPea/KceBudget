# -*- coding: utf-8 -*-
# สร้าง ใบตัดงบ_template_v10.docx จาก v9 — เพิ่ม placeholder ช่อง checkbox area (ข้อ 4 + 6)
import zipfile, re, shutil, sys

SRC = 'ใบตัดงบ_template_v9 (2).docx'
DST = 'ใบตัดงบ_template_v10.docx'

z = zipfile.ZipFile(SRC)
xml = z.read('word/document.xml').decode('utf-8')
before = xml

CHK = r'\(\s+\)'  # ช่อง (    ) กี่ช่องไฟก็ได้

# --- บรรทัด 1 กับ 7 ข้อความเหมือนกัน → ตัวแรก=VEH, ตัวที่สอง(typo ซ้ำ)=OIL + แก้ข้อความ ---
dupe = '(    )  ค่ายานพาหนะ / เบี้ยเลี้ยง  พชง'
xml = xml.replace(dupe, '{CHK_VEH}  ค่ายานพาหนะ / เบี้ยเลี้ยง  พชง', 1)
xml = xml.replace(dupe, '{CHK_OIL}  ค่าน้ำมันยานพาหนะ', 1)  # แก้ typo + ใส่ token

# --- ที่เหลือ unique ---
subs = [
    (r'\(\s+\)  ค่าพาหนะ / เบี้ยเลี้ยง  พชร\(บ\)',
     '{CHK_TRV}  ค่าพาหนะ / เบี้ยเลี้ยง  พชร(บ)'),
    (CHK + r'  ค่าแรง พขร\.\(บ\.\) \.{3,} \(เครนสว่านเจาะ\)',
     '{CHK_CRN}  ค่าแรง พขร.(บ.) {CRN_NAME} (เครนสว่านเจาะ)'),
    (CHK + r'  ค่าแรง พขร\.\(บ\.\) \.{3,} \(รถกระเช้า\)',
     '{CHK_CRT}  ค่าแรง พขร.(บ.) {CRT_NAME} (รถกระเช้า)'),
    (CHK + r'  ค่าแรงคนงานรายวัน งวด วันที่ \.{3,}',
     '{CHK_DLY}  ค่าแรงคนงานรายวัน งวด วันที่ {DLY_DATE}'),
    (r'ทีม \.{3,}', 'ทีม {DLY_TEAM}'),
    (CHK + r'  ค่าแรงจ้างเหมา  สัญญาจ้างที่ \.{3,}ลว\. \.{3,}',
     '{CHK_CON}  ค่าแรงจ้างเหมา  สัญญาจ้างที่ {CON_NO} ลว. {CON_DATE}'),
    (CHK + r'  อื่นๆ (\.{3,})',
     r'{CHK_OTH}  อื่นๆ \1'),  # อื่นๆ เก็บจุดไข่ปลาไว้กรอกมือ ใส่แค่ checkbox
]
for pat, rep in subs:
    xml, n = re.subn(pat, rep, xml)
    if n == 0:
        print('!! ไม่พบรูปแบบ:', pat, file=sys.stderr)

# เขียนกลับเป็น v10 (copy entry อื่นทั้งหมด แทนเฉพาะ document.xml)
shutil.copyfile(SRC, DST)
zin = zipfile.ZipFile(SRC, 'r')
zout = zipfile.ZipFile(DST, 'w', zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    data = zin.read(item.filename)
    if item.filename == 'word/document.xml':
        data = xml.encode('utf-8')
    zout.writestr(item, data)
zout.close(); zin.close()

toks = sorted(set(re.findall(r'\{[A-Z_]+\}', xml)))
sys.stdout.buffer.write(('เปลี่ยนแปลง: ' + ('มี' if xml != before else 'ไม่มี') + '\n').encode('utf-8'))
sys.stdout.buffer.write(('token ทั้งหมดใน v10 (' + str(len(toks)) + '):\n' + ' '.join(toks)).encode('utf-8'))
print()
