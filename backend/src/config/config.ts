import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const log = createLogger('config');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..', '..');

// โหลดค่าจาก .env ใน backend/ เท่านั้น (ไม่ใช้ข้างนอก)
const backendEnvPath = path.resolve(backendRoot, '.env');
if (fs.existsSync(backendEnvPath)) {
  dotenv.config({ path: backendEnvPath });
} else {
  dotenv.config();
}

function cleanEnv(val: any, fallback: string = ''): string {
  if (!val) return fallback;
  return String(val).replace(/^["']|["']$/g, '').trim();
}

/**
 * Read a numeric env var with a safe fallback (never returns NaN).
 *
 * STAB-FIX: the old code did parseInt(cleanEnv(process.env.X), 10) inline
 * everywhere. One typo in .env (PORT=1726a, CONCURRENCY=2x, ...) produced NaN,
 * and app.listen(NaN) throws ERR_INVALID_ARG_VALUE at startup - the whole
 * server silently refused to boot. Bad/missing values now fall back to the
 * documented default and the service still starts.
 */
function envInt(val: any, fallback: number, min = 1): number {
  const n = parseInt(cleanEnv(val), 10);
  if (Number.isFinite(n) && n >= min) return n;
  return fallback;
}

/**
 * ฟังก์ชันดึง IP เครื่องอัตโนมัติ (IPv4)
 * เช่น หากอยู่บน server 192.168.88.151 ก็จะได้ค่านั้นออกมาทันที
 */
function getLocalIpAddress(): string {
  const envIp = cleanEnv(process.env.SERVER_IP);
  if (envIp) {
    return envIp;
  }
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254')) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const dataDir = path.resolve(backendRoot, 'data');
const snapshotsDir = path.resolve(dataDir, 'snapshots');
const rawDir = path.resolve(dataDir, 'raw');
const uploadsDir = path.resolve(dataDir, 'uploads');
const processedDir = path.resolve(dataDir, 'processed');
const exportsDir = path.resolve(dataDir, 'exports');

// สร้างโฟลเดอร์อัตโนมัติหากยังไม่มี
[dataDir, snapshotsDir, rawDir, uploadsDir, processedDir, exportsDir].forEach(d => {
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
  }
});

const frontendPort = envInt(process.env.FRONTEND_PORT, 1727);
const backendPort = envInt(process.env.PORT || process.env.BACKEND_PORT, 1726);
const host = cleanEnv(process.env.HOST, '0.0.0.0');

// จัดการ DB_SERVER และ DB_PORT ในกรณีที่มีพอร์ตต่อท้าย เช่น "18.141.200.88,1433"
const rawDbServer = cleanEnv(process.env.DB_SERVER, '127.0.0.1');
const [dbHost, dbPortSuffix] = rawDbServer.includes(',') ? rawDbServer.split(',') : [rawDbServer, ''];
const dbPort = dbPortSuffix
  ? envInt(dbPortSuffix, 1433)
  : envInt(process.env.DB_PORT, 1433);

export const config = {
  host,
  port: backendPort,
  frontendPort,
  serverIp: getLocalIpAddress(),
  backendRoot,
  snapshotsDir,
  exportsDir,
  rawDir,
  uploadsDir,
  processedDir,
  defaultExcelPath: cleanEnv(process.env.DATA_EXCEL_PATH),
  db: {
    server: dbHost.trim(),
    port: dbPort,
    user: cleanEnv(process.env.DB_USER, 'sa'),
    password: cleanEnv(process.env.DB_PASSWORD, ''),
    database: cleanEnv(process.env.DB_NAME, 'wms_picking'),
    options: {
      encrypt: cleanEnv(process.env.DB_ENCRYPT) === 'true',
      trustServerCertificate: cleanEnv(process.env.DB_TRUST_SERVER_CERTIFICATE) !== 'false',
      connectTimeout: envInt(process.env.DB_TIMEOUT, 15000),
    },
    pool: {
      max: envInt(process.env.DB_POOL_MAX, 10),
      // min=0 is a valid setting (drop all connections when idle), so allow >= 0
      min: envInt(process.env.DB_POOL_MIN, 0, 0),
      idleTimeoutMillis: envInt(process.env.DB_POOL_IDLE_MS, 30000),
    },
  },
  sap: {
    baseUrl: cleanEnv(process.env.SAP_BASE_URL, 'https://fiori.ampolfood.com/sap/opu/odata/sap/ZGWS_SD_ODATA19_SRV'),
    entitySet: cleanEnv(process.env.SAP_ENTITY_SET, 'ZI_PICKANDLOAD06A'),
    // NOTE (security): เดิมมี hardcoded password (redacted — see backend/.env rotation note) เป็น fallback ใน source code
    // ตัดออกแล้ว — credentials ต้องมาผ่าน .env เท่านั้ น เพื่อกันรหัสผาน git/history
    username: cleanEnv(process.env.FIORI_USERNAME || process.env.SAP_USER),
    password: cleanEnv(process.env.FIORI_PASSWORD || process.env.SAP_PASSWORD),
    /** parallel SAP workers used by the sync pipeline (overridable via CONCURRENCY) */
    concurrency: envInt(process.env.CONCURRENCY, 2),
    timeout: envInt(process.env.SAP_TIMEOUT, 30000),
  },
  s3: {
    batchDoBaseUrl: cleanEnv(
      process.env.S3_BATCH_DO_URL,
      'https://apf-dashboard.s3.ap-southeast-1.amazonaws.com/BatchDO/prod'
    ),
    // timeout ต่อ 1 request (ms) เดิม fetch() ไม่มี timeout ทีกาหนด -> ค้างนิรันดร์ได้
    timeout: envInt(process.env.S3_TIMEOUT, 30000),
  },
  /** standard SQL request timeout (ms) — a hung query must not pin a pool worker */
  dbRequestTimeout: envInt(process.env.DB_REQUEST_TIMEOUT, 60000),
  /**
   * Hard ceiling for ONE full 5-step sync pipeline (ms).
   *
   * STAB-FIX (the core of "server maintain"): the pipeline had no end-to-end
   * timeout, only a 30s timeout per individual fetch (x3 retries each, over
   * hundreds of SAP DOs). When S3/SQL/SAP degraded, the run could stall for
   * far longer than any client was willing to wait — and because the promise
   * stayed in `SyncService.inflight`, every later request for that date
   * JOINED the zombie instead of starting fresh: the dashboard froze until the
   * process was restarted. With this ceiling the run always settles, the
   * in-flight entry is always released, and the caller gets an explicit error.
   */
  syncTimeoutMs: envInt(process.env.SYNC_TIMEOUT_MS, 15 * 60 * 1000),
  /** timeout for the Python Excel generator (ms) — was hardcoded 120000 */
  pythonTimeoutMs: envInt(process.env.PYTHON_TIMEOUT_MS, 120_000),
  /**
   * allowed CORS origins (comma-separated จาก env CORS_ORIGINS)
   * ค่าเดิมคง '*' ไว้ ตาม behavior เดิม (ใช้งานใน LAN)
   */
  corsOriginsList: cleanEnv(process.env.CORS_ORIGINS)
    ? cleanEnv(process.env.CORS_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean)
    : ['*'],
};

// เตือนตอน startup ถ้าไม่มี SAP credentials (จะแค่ log ไม่ crash)
if (!config.sap.username || !config.sap.password) {
  log.warn('ไม่พบ FIORI_USERNAME/FIORI_PASSWORD ใน .env — การดึงข้อมูล SAP จะล้มเหลว (ตรวจสอบ backend/.env)');
}
