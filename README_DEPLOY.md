# คู่มือ Deploy — ใบตัดงบ กฟส.คำชะอี (Phase 2)

แอปแยก 2 ฝั่ง: **หน้าเว็บ** (โฟลเดอร์นี้) คุยกับ **GAS web app** ที่เก็บข้อมูลใน Google Sheet

## ส่วนที่ 1 — ตั้ง GAS (ทำครั้งเดียว)

1. เปิด https://script.google.com → **New project**
2. สร้างไฟล์ 2 ไฟล์ในโปรเจก แล้ววางโค้ด:
   - `Code.gs` ← เนื้อจากไฟล์ `Code.gs` ในโฟลเดอร์นี้
   - `logic.gs` ← เนื้อจากไฟล์ `logic.gs` (เมนู **+ > Script** ตั้งชื่อ `logic`)
3. เลือกฟังก์ชัน **`setup`** จาก dropdown ด้านบน → กด **Run**
   - อนุญาต scope ที่ขอ (Spreadsheet + Drive)
   - ดู **Execution log** จะมี URL สเปรดชีตที่สร้างให้ (4 แท็บ: งบ / บันทึกการตัด / ประวัติแก้งบ / ตั้งค่า)
4. **Deploy > New deployment > ⚙ > Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy → copy **Web app URL** (ลงท้าย `/exec`)

## ส่วนที่ 2 — ต่อหน้าเว็บ

- เปิด `config.js` → วาง URL ที่ได้ลงใน `GAS_URL`
- เปิดแอป: รัน `node _serve.mjs` แล้วเข้า http://localhost:8123
  (เปิด `index.html` ตรงๆ ไม่ได้ เพราะ ES module ต้องผ่าน http)

## ส่วนที่ 3 — ใส่ข้อมูล master (dropdown พขร.)

เปิดสเปรดชีต แท็บ **ตั้งค่า** → ใส่แถว `พขร. | ชื่อคนขับ` (คอลัมน์ A=ประเภท, B=ค่า) เพิ่มได้เรื่อยๆ

## ⚠️ Checklist ตอนแก้โค้ด GAS แล้ว redeploy (สำคัญ — เคยพลาดบ่อย)

- แก้ `Code.gs`/`logic.gs` แล้ว **ต้อง Deploy > Manage deployments > (ดินสอ) > Version: New version > Deploy**
- **URL /exec เดิมใช้ต่อได้** ถ้า redeploy ทับ deployment เดิม (ไม่ต้องแก้ config.js)
- ถ้า **New deployment** ใหม่ = ได้ URL ใหม่ ต้องอัปเดต `config.js`
- ทดสอบเร็ว: เปิด URL `/exec` ในเบราว์เซอร์ (GET) ต้องได้ JSON `{"ok":true,...}`

## ทดสอบ business logic (ไม่ต้อง deploy)

```
node test_parser.mjs   # parser ตรง Test case A/B
node test_logic.mjs    # คงเหลือ / กันเบิกเกิน / re-import / เบิกหลายรอบ
```
