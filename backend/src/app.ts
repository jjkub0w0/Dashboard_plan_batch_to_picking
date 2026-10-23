import express from 'express';
import cors from 'cors';
import apiRouter from './routes/api.routes.js';
import { config } from './config/config.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('http');

const app = express();

// CORS: อ่านจาก config (env CORS_ORIGINS) — ค่าเดิมคง '*' ตาม behavior เดิม (LAN)
app.use(cors({
  origin: config.corsOriginsList as any,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// จำกัดขนาด JSON body (ค่า default 100kb ของ express ถือว่าดีอยู่แล้ว
// แต่ระบุชัด ๆ กันคนส่ง payload ใหญ่เข้ามากิน memory ตอน parse)
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ---- Request log + measurement -------------------------------------------
// log เฉพาะ request ผิดปกติ/ช้าอัตโนมัติ (>= 400 หรือ > 10s) ส่วน request ธรรมดา
// ไว้ที่ debug level เพื่อไม่ถล่ม log ตอนโดน polling ถี่ ๆ
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`;
    if (res.statusCode >= 500 || ms > 10_000) log.warn(`SLOW/ERR ${line}`);
    else if (res.statusCode >= 400) log.warn(line);
    else log.debug(line);
  });
  next();
});

// UX/CACHE: API responses must never be cached across date changes or polling
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Mount API routes under /api
app.use('/api', apiRouter);

// Base Route
app.get('/', (req, res) => {
  res.json({
    name: 'Plan Batch to Picking - Backend Service',
    description: 'หลังบ้านสำหรับดึงข้อมูลและคำนวณ SO, DO, QTY, SKU, Batch (ตรงตามแผน / ไม่ตรงตามแผน)',
    endpoints: {
      health: 'GET /api/health',
      dashboard: 'GET /api/dashboard?date=2026-08-01T00:00:00',
      batches: 'GET /api/batches?type=SO',
      mismatched: 'GET /api/mismatched'
    }
  });
});

// 404 JSON สำหรับ route ที่ไม่มีจริง (เดิม express ส่ง HTML 404 ทำให้ frontend
// ที่ parse JSON เจอ "Unexpected token <" และ debug ยาก)
app.use((req, res) => {
  res.status(404).json({ success: false, error: `ไม่พบ endpoint: ${req.method} ${req.path}` });
});

// ---- Central error handler ----------------------------------------------
// ต้องอยู่ท้ายสุดเสมอ — รวม error ที่หลุดจาก middleware/router
// ให้ตอบ JSON มาตรฐานแทน HTML และ log stack ไว้ debug
app.use((err: any, req: any, res: any, next: any) => {
  // JSON body ผิดรูป
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'JSON body ผิดรูปแบบ' });
  }
  log.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: err?.message || 'Internal server error' });
});

export default app;
