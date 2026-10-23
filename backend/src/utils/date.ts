/**
 * Utility กลางสำหรับจัดการวันที่ ให้เป็นรูปแบบ YYYY-MM-DD (date key)
 * เดิมโค้ดกระจาย logic "ตัด T ท้าย / trim" ทั่วไปทั้งโปรเจกต์
 * รวมไว้ที่เดียวเพื่อให้ validation แน่นขึ้นและแก้ที่เดียวจบ
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * แปลงค่าวันที่จาก query/body (เช่น "2026-09-12", "2026-09-12T00:00:00")
 * ให้เหลือเฉพาะ "YYYY-MM-DD" และตรวจว่าเป็นวันที่ถูกต้องจริง
 * (กันค่าแปลกปลอมหลุดเข้า SQL / OData filter / filesystem path)
 * @throws Error เมื่อรูปแบบไม่เป็น YYYY-MM-DD
 */
export function normalizeDateParam(value: unknown): string {
  const raw = String(value ?? '').trim();
  const datePart = raw.includes('T') ? raw.split('T')[0] : raw;
  if (!DATE_RE.test(datePart)) {
    throw new Error(`รูปแบบวันที่ไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD): "${raw}"`);
  }
  // ตรวจว่าเป็นวันที่มีจริงในปฏิทิน (เช่น 2026-02-31 ต้องผิด)
  const [y, m, d] = datePart.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error(`วันที่ไม่มีจริงในปฏิทิน: "${datePart}"`);
  }
  return datePart;
}

/** เวอร์ชันไม่ throw: คืน null แทน (ใช้ใน path ที่ต้องการ fallback) */
export function tryNormalizeDate(value: unknown): string | null {
  try {
    return normalizeDateParam(value);
  } catch {
    return null;
  }
}

/** คืนวันปัจจุบันในรูปแบบ YYYY-MM-DD (ตามเวลาประเทศไทย Asia/Bangkok, UTC+7) */
export function getTodayDateStr(): string {
  const d = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** คืนวันและเวลาปัจจุบันในรูปแบบ ISO ตามเวลาประเทศไทย (Asia/Bangkok, UTC+7 เช่น 2026-10-21T14:15:30.123+07:00) */
export function getBangkokIsoString(d: Date = new Date()): string {
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().replace('Z', '+07:00');
}
