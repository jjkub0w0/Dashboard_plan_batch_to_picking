# 📁 Backend Data Storage Structure

โฟลเดอร์นี้เป็นศูนย์กลางจัดเก็บไฟล์ข้อมูลการทำงานหลังบ้านทั้งหมดของระบบ **Plan Batch to Picking**

> โฟลเดอร์ทั้ง 6 นี้ถูกสร้างอัตโนมัติตอน backend สตาร์ท (ดู `src/config/config.ts`)
> ไม่ต้องสร้างมือ — ไฟล์ `.gitkeep` มีไว้ให้เห็นใน git repo เท่านั้น

---

### โครงสร้างโฟลเดอร์ (Directory Structure)

1. **`snapshots/`** ⭐ (หัวใจของระบบ)
   - ไฟล์ **JSON Snapshot ประจำวัน** เช่น `2026-09-12.json` — เขียนโดย Sync Service หลังดึงข้อมูล S3 + MS SQL + SAP เสร็จ
   - DataLoader และ Trend Service อ่านไฟล์ตามวันที่จากโฟลเดอร์นี้เป็นแหล่งข้อมูลอันดับแรก
   - snapshot ที่เห็นใน repo เป็นข้อมูลตัวอย่าง — ระบบจะเขียนไฟล์ใหม่ทับตามวันที่จริงเอง

2. **`raw/`**
   - ข้อมูลดิบ เช่น Excel (`.xlsx`) / CSV ที่วางรอไว้ — DataLoader หาไฟล์ที่ชื่อมีรูปแบบวันที่ (`YYYY-MM-DD` หรือ `DD.MM.YYYY`) ตรงกับวันที่ร้องขอ

3. **`uploads/` และ `processed/`**
   - โฟลเดอร์ให้ **operator วางไฟล์เอง** — API ไม่มี endpoint อัปโหลดอีกต่อไป (multer ถูกถอดออกแล้ว)
   - ยังเป็น "managed dirs": ถ้าส่ง `?date=<path>` ชี้มาที่ไฟล์ในโฟลเดอร์เหล่านี้ (หรือ `raw/`) ระบบจะโหลดไฟล์นั้นตรง ๆ — ชี้ไปนอก 3 โฟลเดอร์นี้ไม่ได้ (มี path traversal guard)

4. **`exports/`**
   - ผลลัพธ์ที่ระบบสร้าง: ไฟล์ Excel จาก `POST /api/export/excel[...]` และ JSON ชั่วคราวชื่อ `temp_*.json` ที่ใช้ส่งให้ Python generator
