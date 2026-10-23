// กำหนด Timezone ประเทศไทยเป็นค่าเริ่มต้นให้ระบบ
process.env.TZ = process.env.TZ || 'Asia/Bangkok';

import app from './app.js';
import apiRouter from './routes/api.routes.js';
import { config } from './config/config.js';
import path from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import { databaseService } from './services/database.service.js';
import { schedulerService } from './services/scheduler.service.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('server');

const PORT = config.port;
const HOST = config.host;
const SERVER_IP = config.serverIp;

// ตั้งชื่อหน้าต่าง CMD ให้เป็นชื่องาน
if (process.platform === 'win32') {
  process.title = 'Plan Batch to Picking';
  if (process.stdout && process.stdout.isTTY) {
    process.stdout.write('\x1b]0;Plan Batch to Picking\x07');
  }
}

// =============================================================================
// Process-level safety nets — หัวใจของ "server maintain"
// จุดประสงค:์ ไมมี uncaught event ใดทำให process ล่มหลังจากประมวลผลงานเสร็จ
// (โดยเฉพาะหลัง job ดึงข้อมูล S3/MSSQL/SAP ที่ listener ค้างอยู่ใน event loop)
// =============================================================================

// Rejection ที่ไม่มี .catch() — log ไว้ แต่ไม่ kill process
// (pipeline ที่ await แล้วมัก reject จาก path ที่ UI ยังดู result ได้ปกติ)
process.on('unhandledRejection', (reason: any) => {
  log.error('UNHANDLED REJECTION (process ยังทำงานต่อ):', reason instanceof Error ? reason : String(reason));
});

// Exception ที่ไม่มี try/catch ครอบ — state หลัง crash ไม่แน่นอน:
// log ซ้ำ ปิด resource เท่าที่ปิดได้ แล้ว exit code 1 ให้ process manager (PM2/run.bat) restart
let fatalErrorSeen = false;
process.on('uncaughtException', (err: Error) => {
  log.error('UNCAUGHT EXCEPTION — กำลังปิด server อย่างปลอดภัย:', err);
  if (fatalErrorSeen) {
    log.error('พบ fatal ซ้ำซ้อน — exit ทันที');
    process.exit(1);
  }
  fatalErrorSeen = true;
  shutdown('uncaughtException', 1);
});

// =============================================================================
// Graceful shutdown: SIGINT/SIGTERM (Ctrl+C, PM2 restart, Windows shutdown)
// -> หยุดรับ request ใหม่ -> ปิด DB pool -> ค่อย exit (ภายใน 10s ถ้าไม่เสร็จ)
// =============================================================================
const servers: import('http').Server[] = [];
let shuttingDown = false;

function shutdown(signal: string, exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`ไดรับ signal (${signal}) — กำลังปิด server อย่างเรียบร้อย...`);

  // Watchdog: never leave a half-shut-down process behind (e.g. a DB close that
  // hangs because the SQL server is already gone). Deliberately NOT unref'd:
  // an unref'd timer lets Node exit with code 0 on its own, which would hide
  // the exit code a process manager (PM2 / server.js runner) needs to see.
  const forceTimer = setTimeout(() => {
    log.warn('graceful shutdown exceeded 10s - force exit, dropping remaining sockets');
    for (const srv of servers) {
      try { (srv as any).closeAllConnections?.(); } catch { /* ignore */ }
    }
    process.exit(exitCode);
  }, 10_000);

  for (const srv of servers) {
    try {
      srv.close();
      // Stop() alone cannot finish while keep-alive browsers hold sockets open
      // (the Angular UI polls, so it always does) - release the idle ones now
      // so close() can actually resolve instead of waiting out the watchdog.
      (srv as any).closeIdleConnections?.();
    } catch { /* ignore */ }
  }

  schedulerService.stop();

  databaseService.close()
    .catch(() => undefined)
    .finally(() => {
      log.info('ปิด server เรียบร้อย — bye');
      clearTimeout(forceTimer);
      process.exit(exitCode);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// เตือน (ไม่จบ process) เมื่อ event loop หน่วงนานผิดปกติ — สัญญาณ leak/งาน blocking
const LAG_INTERVAL = 1000;
let lagMark = performance.now();
setInterval(() => {
  const lag = performance.now() - lagMark - LAG_INTERVAL;
  if (lag > 5_000) log.warn(`Event loop หน่วง ${Math.round(lag)}ms — อาจมีงาน blocking/calculation ใหญ่`);
  lagMark = performance.now();
}, LAG_INTERVAL).unref();

// ---- API server (port ตาม .env, default 1726) ----------------------------
const apiServer = app.listen(PORT, HOST, () => {
  log.info('=====================================================');
  log.info(`Plan Batch Backend Server running!`);
  log.info(`  Local:    http://127.0.0.1:${PORT}/api`);
  log.info(`  Network:  http://${SERVER_IP}:${PORT}/api`);
  log.info(`  Health:   http://${SERVER_IP}:${PORT}/api/health`);
  log.info(`  Dashboard http://${SERVER_IP}:${PORT}/api/dashboard`);
  log.info(`  Batches   http://${SERVER_IP}:${PORT}/api/batches`);
  log.info(`  Sync      http://${SERVER_IP}:${PORT}/api/sync?date=YYYY-MM-DD`);
  log.info('=====================================================');
});
// FIX: เดิม listen() ไม่มี error handler -> EADDRINUSE กลายเป็น uncaught exception
// ทำให้ process crash ทั้งที่ frontend ยังเสิร์ฟได้ (แยกจากกันไม่ขาด)
apiServer.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`พอร์ต ${PORT} ถูกใช้งานอยู่แล้ว — Backend API ไม่สามารถเริ่มได้ (ปิดโปรแกรมเก่าแล้วเปิดใหม่ หรือแก้ PORT ใน .env)`);
    // ZOMBIE-FIX: logging and staying alive made a process that owns NO port yet
    // still looks "healthy" to the runner supervisor (child "alive" forever, /api
    // down, no restart) - and every extra start.bat launch added another zombie.
    // Exit non-zero: the runner notices, and its restart/backoff + [Reclaim]
    // startup logic take over.
    shutdown('API port busy (EADDRINUSE)', 1);
  } else {
    log.error('API server error:', err);
  }
});
servers.push(apiServer);

// เริ่มต้นระบบ Loop ดึงข้อมูลอัตโนมัติทุกๆ 30 นาที บน Backend
schedulerService.start();

// ---- Static frontend (port 1727) ถ้ามีไฟล์ build และไม่ได้รันผ่าน runner (server.js) ----
const frontendDistPath = path.resolve(config.backendRoot, '..', 'dist', 'plan-batch-to-picking', 'browser');
if (!process.env.SERVED_BY_RUNNER && fs.existsSync(frontendDistPath)) {
  const FRONTEND_PORT = config.frontendPort;
  const frontendApp = express();
  frontendApp.use(cors({ origin: config.corsOriginsList as any }));
  frontendApp.use(express.json({ limit: '2mb' }));
  frontendApp.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // UX/API: รองรับ /api บนพอร์ต Frontend (1727) โดยตรง เพื่อให้ Frontend เรียก /api ได้ทันที
  // โดยไม่ต้องกังวลเรื่อง CORS หรือพอร์ต 1726 ถูกบล็อกบนระบบเครือข่าย/ไฟร์วอลล์
  frontendApp.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  }, apiRouter);

  // UX/STAB: index.html ต้อง no-store เสมอ — hashed chunk cache ได้นาน (ชื่อเปลี่ยนทุก build)
  // แต่ html ถ้า browser เก็บไวจะทำให้ผู้ใช้รัน JS เก่า (บั๊กที่แก้ไปแล้วจะ "ค้าง" ในสายตาท่าน)
  frontendApp.use((req, res, next) => {
    if (req.path === '/' || req.path === '/index.html' || req.path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });
  frontendApp.use(express.static(frontendDistPath));
  frontendApp.use((req, res) => {
    // SPA fallback ก็คือ index.html เดิม — ต้อง no-store เช่นกกัน
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });

  const frontendServer = frontendApp.listen(FRONTEND_PORT, HOST, () => {
    log.info('Frontend Web App running!');
    log.info(`  Local:    http://127.0.0.1:${FRONTEND_PORT}`);
    log.info(`  Network:  http://${SERVER_IP}:${FRONTEND_PORT}`);
    log.info('=====================================================');
  });
  frontendServer.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      // ไม่ใช่เรื่องคอขาดบาดตาย — backend ยังทำงานต่อได้ (graceful degradation)
      log.warn(`Frontend port ${FRONTEND_PORT} ถูกใช้แล้ว — ข้ามการเสิร์ฟ frontend (backend ยังทำงานปกติ)`);
    } else {
      log.error('Frontend server error:', err);
    }
  });
  servers.push(frontendServer);
}
