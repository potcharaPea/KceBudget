# -*- coding: utf-8 -*-
# สร้าง ใบตัดงบ_template_v_final2.docx จาก template final — patch 2 (ข้อ 2/4/5)
#  - ข้อ 2: ช่วงวันที่ค่าแรง 2 ช่อง (CRN/CRT/DLY from-to)
#  - ข้อ 4: บรรทัด โหนด {NODE}
#  - ข้อ 5: บรรทัด ดำเนินการโดย {OPER}
import zipfile, re, sys

SRC = 'ใบตัดงบ_template final.docx'
DST = 'ใบตัดงบ_template_v_final2.docx'

xml = zipfile.ZipFile(SRC).read('word/document.xml').decode('utf-8')
before = xml

# --- ข้อ 2: เพิ่มช่วงวันที่ (token ต่อเนื่อง แทนตรงๆ ได้) ---
repls = [
    ('{CRN_NAME}', '{CRN_NAME} {CRN_FROM}-{CRN_TO}'),
    ('{CRT_NAME}', '{CRT_NAME} {CRT_FROM}-{CRT_TO}'),
    ('{DLY_DATE}', '{DLY_FROM}-{DLY_TO}'),
]
for a, b in repls:
    if a not in xml:
        print('!! ไม่พบ token:', a, file=sys.stderr)
    xml = xml.replace(a, b, 1)

# --- ข้อ 4+5: โคลนย่อหน้า {WBS} เป็น โหนด {NODE} + ดำเนินการโดย {OPER} ---
i = xml.find('{WBS}')
p_start = xml.rfind('<w:p ', 0, i)
p_end = xml.find('</w:p>', i) + len('</w:p>')
wbs_para = xml[p_start:p_end]

def clone(src, find_text, label_text):
    c = src.replace(find_text, label_text)          # แทนข้อความในย่อหน้า
    c = re.sub(r'\s+w14:paraId="[0-9A-Fa-f]+"', '', c)  # ลบ paraId กัน id ซ้ำ
    return c

node_para = clone(wbs_para, 'หมายเลขงาน  {WBS}', 'โหนด  {NODE}')
oper_para = clone(wbs_para, 'หมายเลขงาน  {WBS}', 'ดำเนินการโดย  {OPER}')
xml = xml[:p_end] + node_para + oper_para + xml[p_end:]

# --- รหัสแฟ้ม {FCODE}: โคลนย่อหน้า {JOB} แทรกเหนือ ชื่องาน (หัวกระดาษ) ---
j = xml.find('{JOB}')
j_start = xml.rfind('<w:p ', 0, j)
j_end = xml.find('</w:p>', j) + len('</w:p>')
job_para = xml[j_start:j_end]
fcode_para = clone(job_para, 'ชื่องาน {JOB}', 'รหัสแฟ้ม  {FCODE}')
xml = xml[:j_start] + fcode_para + xml[j_start:]

# --- เขียนกลับ (แทนเฉพาะ document.xml, copy entry อื่นทั้งหมด) ---
zin = zipfile.ZipFile(SRC, 'r')
zout = zipfile.ZipFile(DST, 'w', zipfile.ZIP_DEFLATED)
for item in zin.infolist():
    data = zin.read(item.filename)
    if item.filename == 'word/document.xml':
        data = xml.encode('utf-8')
    zout.writestr(item, data)
zout.close(); zin.close()

toks = sorted(set(re.findall(r'\{[A-Z_]+\}', xml)))
out = 'เปลี่ยนแปลง: ' + ('มี' if xml != before else 'ไม่มี') + '\n'
out += 'token ทั้งหมดใน v_final2 (%d):\n%s\n' % (len(toks), ' '.join(toks))
sys.stdout.buffer.write(out.encode('utf-8'))
