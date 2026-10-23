import { config } from '../config/config.js';
import { fetchWithTimeout } from '../utils/http.js';
import { createLogger } from '../utils/logger.js';
import { tryNormalizeDate } from '../utils/date.js';

const log = createLogger('s3');

export class S3ApiService {
  /**
   * สร้าง Full URL สำหรบั ดึงไฟล JSON ตามวันท่ี
   * เช น: https://apf-dashboard.s3.ap-southeast-1.amazonaws.com/BatchDO/prod/2026-09-12.json
   * SEC: validate date กอนประกอบ URL กัน path traversal (เช น ../../)
   */
  public getSnapshotUrl(dateStr: string): string {
    const cleanDate = tryNormalizeDate(dateStr) ?? String(dateStr).trim().replace(/[\\/:*?"<>|]/g, '');
    const fileName = cleanDate.endsWith('.json') ? cleanDate : `${cleanDate}.json`;
    const baseUrl = config.s3.batchDoBaseUrl.replace(/\/$/, '');
    return `${baseUrl}/${fileName}`;
  }

  /**
   * ดึงขอมูล JSON จาก S3 ตามวันท่ี
   * STAB-FIX: ใช fetchWithTimeout (timeout 30s + retry 2 ครัง) — เดิม fetch() โลงๆ
   * ทาให request คางถาวรไดถา S3/เน็ต ไมตอบ
   * @param dateStr ว นนทีในรูแบบ YYYY-MM-DD เช น '2026-09-12'
   */
  public async fetchSnapshotJson(dateStr: string): Promise<any> {
    const targetUrl = this.getSnapshotUrl(dateStr);
    log.info(`กาลังดึงขอมูลจาก S3: ${targetUrl}`);

    const startTime = Date.now();
    const response = await fetchWithTimeout(
      targetUrl,
      { method: 'GET', headers: { 'Accept': 'application/json' } },
      { timeoutMs: config.s3.timeout, retries: 2 }
    );

    if (!response.ok) {
      throw new Error(`S3 Error [HTTP ${response.status}]: ไมสามารถดึงไฟลจาก ${targetUrl} ได (${response.statusText})`);
    }

    // อ่านเป น text กอน แลว parse เอง — ทาใหได error ทชัดเจนถา S3 คืน HTML/XML
    // (เช น S3 403/5xx page) แทน "Unexpected token < ..." ทงงน
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`S3 ตอบกลับไมเปน JSON ทถกูตอง (HTTP ${response.status}, ${text.slice(0, 120)})`);
    }

    const duration = Date.now() - startTime;
    const items = Array.isArray(json) ? json : (json.data || json.items || []);
    log.info(`ดึงข้อมูลสำเร็จ: ${items.length} รายการ (ใช้เวลา ${duration} ms)`);

    return json;
  }
}

export const s3ApiService = new S3ApiService();
