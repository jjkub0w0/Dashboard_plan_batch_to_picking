import { Router } from 'express';
import fsp from 'fs/promises';
import path from 'path';
import { DataLoaderService } from '../services/data-loader.service.js';
import { CalculationService } from '../services/calculation.service.js';
import { DashboardController } from '../controllers/dashboard.controller.js';
import { syncService } from '../services/sync.service.js';
import { schedulerService } from '../services/scheduler.service.js';
import { eventsService } from '../services/events.service.js';
import { config } from '../config/config.js';
import { tryNormalizeDate, getTodayDateStr, getBangkokIsoString } from '../utils/date.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('routes');

/**
 * Middleware ตรวจ query param แบบ "date" / "loading_datetime" ให ้เปน YYYY-MM-DD
 * (กันคค่าแปลกปลอมหลดเขา SQL/SAP filter/filesystem)
 * ถาไม ใส ่มา (undefined) ผานผาน — handler จะใช ้ fallback เอง
 */
function validateDateQuery(queryKeys: string[]) {
  return (req: any, res: any, next: any) => {
    for (const key of queryKeys) {
      const raw = req.query?.[key];
      if (raw !== undefined && typeof raw !== 'string') {
        return res.status(400).json({ success: false, error: `query "${key}" ตองเปน string` });
      }
      if (typeof raw === 'string' && tryNormalizeDate(raw) === null) {
        log.warn(`reject request ${req.method} ${req.originalUrl} — date "${raw}" รูปแบบไมถูกตอง`);
        return res.status(400).json({
          success: false,
          error: 'รูปแบบวันท่ไี ม่ถกูต้อง (ต้องเป็น YYYY-MM-DD หรอ YYYY-MM-DDTHH:mm:ss)',
        });
      }
    }
    next();
  };
}

const dataLoader = new DataLoaderService();
const calculator = new CalculationService();
const dashboardController = new DashboardController(dataLoader, calculator);

// CACHE-SYNC: a fresh snapshot from /sync OR the 30-min scheduler must invalidate the
// controller's DataLoaderService cache, otherwise /dashboard keeps stale pre-sync rows.
syncService.afterSnapshotWrite = (date) => dataLoader.clearCache(date);

const router = Router();

// Health check — เพิ่ม process metrics (uptime, memory, event-loop lag)
// ให้ monitor/healthcheck ภายนอกใช้ตัดสินว่า "process ยังทำงานดีจริง" ไม่ใช่แค่ TCP เปิด
let lastHealthTick = Date.now();
let eventLoopLagMs = 0;
setInterval(() => {
  const now = Date.now();
  eventLoopLagMs = Math.max(0, now - lastHealthTick - 1000);
  lastHealthTick = now;
}, 1000).unref();

router.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    service: 'Plan Batch to Picking Backend',
    timestamp: getBangkokIsoString(),
    uptimeSec: Math.round(process.uptime()),
    memoryMB: {
      rss: Math.round(mem.rss / 1048576),
      heapUsed: Math.round(mem.heapUsed / 1048576),
    },
    eventLoopLagMs,
    inflightSyncDates: syncService.inflightSize,
    scheduler: schedulerService.getStatus(),
  });
});

// Scheduler status & trigger
router.get('/scheduler/status', (req, res) => {
  res.json({
    success: true,
    scheduler: schedulerService.getStatus(),
  });
});

router.post('/scheduler/trigger', async (req, res) => {
  try {
    schedulerService.triggerAutoSync();
    res.json({
      success: true,
      message: 'คำสั่งดึงข้อมูลอัตโนมัติ (Trigger Auto-Sync) เริ่มทำงานในพื้นหลังแล้ว',
      scheduler: schedulerService.getStatus(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Server-Sent Events (SSE) สำหรับแจ้งเตือนแบบ Real-time เมื่อมีข้อมูลอัปเดตใหม่
router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');

  eventsService.addClient(res);

  req.on('close', () => {
    eventsService.removeClient(res);
  });
});

// ตรวจสอบเวอร์ชันและเวลาอัปเดตล่าสุดของไฟล์ snapshot (ใช้สำหรับ Polling ตรวจสอบการเปลี่ยนแปลง)
router.get('/sync/version', validateDateQuery(['date', 'loading_datetime']), async (req, res) => {
  const dateParam = (req.query.date as string) || (req.query.loading_datetime as string) || getTodayDateStr();
  const cleanDate = tryNormalizeDate(dateParam) || getTodayDateStr();
  const snapshotPath = path.join(config.snapshotsDir, `${cleanDate}.json`);

  let fileMtime = 0;
  let fileSize = 0;
  try {
    // async stat: data/ may sit on a slow network share (project rule, see data-loader)
    const stat = await fsp.stat(snapshotPath);
    fileMtime = Math.round(stat.mtimeMs);
    fileSize = stat.size;
  } catch { /* no snapshot for this date yet */ }

  res.json({
    success: true,
    date: cleanDate,
    fileMtime,
    fileSize,
    scheduler: schedulerService.getStatus(),
  });
});

// FIX (security): every handler below reads `date` OR `loading_datetime`, so both
// keys must be validated. Only `date` used to be checked on /dashboard, /out-dhl,
// /batches and /mismatched, which left `?loading_datetime=<arbitrary path>` as an
// unvalidated path into the snapshot filename / SQL date filter.
const dateGuard = validateDateQuery(['date', 'loading_datetime']);

// Sync & Connect all 3 sources (MS SQL / S3 / SAP Fiori) by date
router.get('/sync', dateGuard, dashboardController.syncDataByDate);
router.get('/sync/date', dateGuard, dashboardController.syncDataByDate);

// Dashboard metrics & overview
router.get('/dashboard', dateGuard, dashboardController.getDashboardData);

// Batch picking trends & multi-day statistics
router.get('/trends', dashboardController.getTrendsData);

// Non-TMS metrics & overview (ข้อมูลนอกเหนือจากระบบ TMS)
router.get('/out-dhl', dateGuard, dashboardController.getOutDhlData);
router.get('/non-tms', dateGuard, dashboardController.getOutDhlData);

// Planning data from MS SQL (tms_dhl_planning)
router.get('/planning', dateGuard, dashboardController.getPlanningData);

// Batch overview list
router.get('/batches', dateGuard, dashboardController.getBatches);

// Mismatched items list
router.get('/mismatched', dateGuard, dashboardController.getMismatched);

// Export Excel dashboard report generated by Python
router.get('/export/excel', dateGuard, dashboardController.exportExcel);
router.get('/export/excel/out-dhl', dateGuard, dashboardController.exportOutDhlExcel);
router.get('/export/excel/non-tms', dateGuard, dashboardController.exportOutDhlExcel);

export default router;
