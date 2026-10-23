import cron, { ScheduledTask } from 'node-cron';
import { syncService } from './sync.service.js';
import { DataLoaderService } from './data-loader.service.js';
import { getTodayDateStr } from '../utils/date.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('scheduler');

export class SchedulerService {
  private cronJob: ScheduledTask | null = null;
  private isRunning = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly dataLoader: DataLoaderService;
  private lastRunTime: string | null = null;

  constructor(dataLoader?: DataLoaderService) {
    this.dataLoader = dataLoader || new DataLoaderService();
  }

  /**
   * คำนวณเวลาที่จะรันรอบถัดไป (นาทีที่ 00 หรือ 30) เวลาประเทศไทย (Asia/Bangkok, UTC+7)
   */
  public getNextRunTime(): string {
    const now = new Date();
    const bkkNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const next = new Date(bkkNow);
    const m = bkkNow.getUTCMinutes();
    if (m < 30) {
      next.setUTCMinutes(30, 0, 0);
    } else {
      next.setUTCHours(bkkNow.getUTCHours() + 1, 0, 0, 0);
    }
    const h = String(next.getUTCHours()).padStart(2, '0');
    const min = String(next.getUTCMinutes()).padStart(2, '0');
    const s = String(next.getUTCSeconds()).padStart(2, '0');
    return `${h}:${min}:${s}`;
  }

  /**
   * เริ่มต้น Cron Job บน Backend ให้ทำงานอัตโนมัติทุกๆ 30 นาที
   * กำหนดการ: ทำงานทุกนาทีที่ 0 และ 30 ของแต่ละชั่วโมง เช่น 10:00, 10:30, 11:00...
   */
  public start(): void {
    if (this.cronJob) {
      log.warn('Scheduler กำลังทำงานอยู่แล้ว ข้ามการสั่ง start ซ้ำ');
      return;
    }

    const nextRun = this.getNextRunTime();
    log.info('================================================================');
    log.info('[AUTO-SYNC SCHEDULER] เริ่มต้นระบบตั้งเวลาดึงข้อมูลอัตโนมัติทุก 30 นาที');
    log.info(`  • รูปแบบการทำงาน: ทุกๆ ครึ่งชั่วโมง (นาทีที่ :00 และ :30)`);
    log.info(`  • รอบถัดไปจะเริ่มทำงานเวลา: ${nextRun}`);
    log.info(`  • ฟังก์ชัน: ดึงข้อมูลสดจาก 3 ระบบ (S3, MS SQL, SAP) สำหรับวันปัจจุบัน`);
    log.info('================================================================');

    // ตั้ง Cron ทุกๆ 30 นาที (at minute 0 and 30) ใน Timezone ประเทศไทย
    this.cronJob = cron.schedule('*/30 * * * *', async () => {
      await this.triggerAutoSync();
    }, {
      timezone: 'Asia/Bangkok',
    });

    // ส่ง Heartbeat แจ้งเตือนสถานะใน Log ทุกๆ 10 นาที เพื่อให้ผู้ใช้มั่นใจว่าระบบนับเวลายังทำงานอยู่
    this.heartbeatTimer = setInterval(() => {
      if (!this.isRunning) {
        log.info(`[AutoSync Heartbeat] ตัวนับเวลายังทำงานปกติ (รอบดึงข้อมูลถัดไปเวลา: ${this.getNextRunTime()})`);
      }
    }, 10 * 60 * 1000).unref();
  }

  /**
   * ดึงข้อมูลใหม่จาก 3 ระบบ (S3, MS SQL, SAP) สำหรับวันปัจจุบัน
   * เป็นการทำงานเดียวกับปุ่มดึงข้อมูล (/api/sync?force=true)
   */
  public async triggerAutoSync(): Promise<void> {
    if (this.isRunning) {
      log.warn('[AutoSync] มีงานดึงข้อมูลเดิมกำลังประมวลผลอยู่ ข้ามรอบการดึงซ้ำ');
      return;
    }

    const todayDate = getTodayDateStr();
    this.isRunning = true;
    const startTime = Date.now();
    log.info(`[AutoSync] ⏰ ครบกำหนด 30 นาที! เริ่มดึงและประมวลผลข้อมูลใหม่จาก 3 ระบบ (S3, MS SQL, SAP) วันที่ ${todayDate}...`);

    try {
      // 1. เคลียร์ memory cache ก่อนเพื่อดึงข้อมูลสดใหม่
      this.dataLoader.clearCache(todayDate);

      // 2. เรียกใช้ฟังก์ชัน sync หลักของระบบ (Force Re-sync)
      const result = await syncService.syncAllByDate(todayDate, undefined, true);

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
      const bkkNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const h = String(bkkNow.getUTCHours()).padStart(2, '0');
      const min = String(bkkNow.getUTCMinutes()).padStart(2, '0');
      const s = String(bkkNow.getUTCSeconds()).padStart(2, '0');
      this.lastRunTime = `${h}:${min}:${s}`;

      if (result.isDataChanged) {
        log.info(
          `[AutoSync] 🔄 ✅ ดึงข้อมูลวันที่ ${todayDate} สำเร็จ (ตรวจพบข้อมูลเปลี่ยนแปลง, ใช้เวลา ${durationSec} วินาที): ` +
          `S3=${result.steps?.step1_s3?.totalItems || 0}, ` +
          `MSSQL=${result.steps?.step2_mssql?.totalRows || 0}, ` +
          `SAP=${result.steps?.step4_sap?.totalRawItems || 0}`
        );
      } else {
        log.info(
          `[AutoSync] ℹ️ ✅ ดึงข้อมูลวันที่ ${todayDate} สำเร็จ (ข้อมูลเดิมไม่มีการเปลี่ยนแปลง, ใช้เวลา ${durationSec} วินาที): ` +
          `S3=${result.steps?.step1_s3?.totalItems || 0}, ` +
          `MSSQL=${result.steps?.step2_mssql?.totalRows || 0}, ` +
          `SAP=${result.steps?.step4_sap?.totalRawItems || 0}`
        );
      }
      log.info(`[AutoSync] รอบถัดไปจะเริ่มเวลา: ${this.getNextRunTime()}`);
    } catch (err: any) {
      log.error(`[AutoSync] ❌ เกิดข้อผิดพลาดในการดึงข้อมูลอัตโนมัติสำหรับวันที่ ${todayDate}:`, err?.message || err);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * หยุดการทำงานของ Cron Job เมื่อปิดเซิร์ฟเวอร์
   */
  public stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      log.info('[AutoSync] Scheduler หยุดการทำงานเรียบร้อย');
    }
  }

  public getStatus() {
    return {
      active: !!this.cronJob,
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      nextRunTime: this.cronJob ? this.getNextRunTime() : null,
      interval: 'every 30 minutes (cron: */30 * * * *)',
    };
  }
}

export const schedulerService = new SchedulerService();
