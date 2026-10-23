/**
 * ตัวช่วย HTTP fetch พร้อม timeout + retry
 *
 * ปัญหาเดิม: fetch() ของ Node ไม่กำหนด timeout -> ถ้า S3/SAP ตอบช้าหรือ
 * ค้าง (TCP เปิดแต่ไม่มี response) request จะค้างนิรันดร์, ค้าง listener/socket
 * และสะสมเป็น memory leak หลังประมวลผลงานแต่ละรอบ
 *
 * ใช้งาน: fetchWithTimeout(url, { timeoutMs, retries })
 */
import { createLogger } from './logger.js';

const log = createLogger('http');

export interface FetchWithRetryOptions {
  /** เวลาสุงสดต่อ 1 attempt (ms) — เกินกว่านี้จะ abort ด้วย AbortSignal */
  timeoutMs?: number;
  /** จำนวนครั้ง retry เพิ่มจาก attempt แรก (default 2 = รวมมากสุด 3 ครั้ง) */
  retries?: number;
  /** ฐานหน่วงเวลาระหว่าง retry (ms) — เพิ่มขึ้นแบบ exponential (base, base*2, ...) */
  retryBaseDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/**
 * fetch พร้อม timeout ต่อ attempt และ retry อัตโนมัติเมื่อ
 * - network error / timeout (AbortError)
 * - HTTP 5xx หรือ 429 (server-side transient)
 * HTTP 4xx อื่น (403/404) ถือว่าถาวร — ไม่ retry (ไม่กดดัน endpoint ไร้ประโยชน์)
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, opts: FetchWithRetryOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 2;
  const baseDelay = opts.retryBaseDelayMs ?? 500;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout หลัง ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      // 5xx/429 เป็นสถานะชั่วคราว -> retry ได้
      const retryableStatus = res.status >= 500 || res.status === 429;
      if (retryableStatus && attempt < retries) {
        log.warn(`fetch ได้ HTTP ${res.status} (attempt ${attempt + 1}/${retries + 1}) จะลองใหม่: ${url.slice(0, 120)}`);
        await res.text().catch(() => undefined); // drain body ทิ้งกัน leak
        await sleep(baseDelay * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err;
      const reason = err?.name === 'AbortError' || String(err?.message || '').includes('timeout') ? 'timeout' : err?.message;
      if (attempt < retries) {
        log.warn(`fetch ล้มเหลว (${reason}) attempt ${attempt + 1}/${retries + 1} จะลองใหม่: ${url.slice(0, 120)}`);
        await sleep(baseDelay * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
