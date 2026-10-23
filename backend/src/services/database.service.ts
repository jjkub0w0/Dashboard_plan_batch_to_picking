import sql from 'mssql';
import { config } from '../config/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mssql');

/**
 * Pool/connection errors ที่ถือเป็นการขัดข้องชั่วคราว (retry ได้ 1 ครั้งด้วย pool ใหม่)
 * มักเกิดจาก network หลุด หรือ DB server restart
 */
const TRANSIENT_DB_ERRORS = [
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTCONNECTED', 'ESOCKET',
  'ECONNREFUSED', 'read ECONNRESET', 'Connection is closed',
  'Failed to connect', 'Login timeout',
];

function isTransientDbError(err: any): boolean {
  const msg = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
  return TRANSIENT_DB_ERRORS.some((t) => msg.includes(t.toLowerCase()));
}

export class DatabaseService {
  private static instance: DatabaseService;
  private pool: sql.ConnectionPool | null = null;
  private connectingPromise: Promise<sql.ConnectionPool> | null = null;

  private constructor() {}

  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  /**
   * สร้าง ConnectionPool พร้อม attach listener ของ event 'error'
   *
   * สำคัญ: mssql ConnectionPool จะ emit 'error' เมื่อ connection ใน pool ขาด
   * (network flap / DB restart) — ถ้าไม่มี listener Node จะโยน uncaught
   * exception และ process ล่มทันที แม้จะประมวลผลงานก่อนหน้าเสร็จแล้วก็ตาม
   * จึงต้องมี listener นี้เสมอ โดยจะ mark pool ว่าใช้ไม่ได้เพื่อ reconnect ครั้งถัดไป
   */
  private createPool(): sql.ConnectionPool {
    const dbConfig: sql.config = {
      server: config.db.server,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      options: {
        encrypt: config.db.options.encrypt,
        trustServerCertificate: config.db.options.trustServerCertificate,
        connectTimeout: config.db.options.connectTimeout,
      },
      pool: {
        max: config.db.pool.max,
        min: config.db.pool.min,
        idleTimeoutMillis: config.db.pool.idleTimeoutMillis,
      },
    };

    const pool = new sql.ConnectionPool(dbConfig);

    // กัน uncaught exception จาก pool-level error ที่เกิดหลัง job จบ
    pool.on('error', (poolErr: any) => {
      log.error(`Pool error (${poolErr?.code || ''} ${poolErr?.message || poolErr}) — mark pool เสีย จะ reconnect ในการเรียกถัดไป`);
      this.pool = null;
      pool.close().catch(() => undefined); // best-effort close ของ pool เก่า
    });

    return pool;
  }

  /**
   * ได้ ConnectionPool ของ SQL Server (Singleton + กัน reconnect ซ้ำซ้อน)
   * ค่าเชื่อมต่อทั้งหมดอ่านจาก .env ผ่าน config.db
   */
  public async getPool(): Promise<sql.ConnectionPool> {
    if (this.pool && this.pool.connected) {
      return this.pool;
    }

    // ถ้ามีคนกำลัง connect อยู่ ใช้ promise เดียวกัน (กัน dogpile ตอน DB ฟื้น)
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    const pool = this.createPool();
    this.connectingPromise = pool
      .connect()
      .then(() => {
        log.info(`เชื่อมต่อสำเร็จ: ${config.db.server}:${config.db.port} / DB: ${config.db.database}`);
        this.pool = pool;
        this.connectingPromise = null;
        return pool;
      })
      .catch((err) => {
        this.connectingPromise = null;
        log.error(`เชื่อมต่อล้มเหลว (${config.db.server}:${config.db.port}):`, err.message);
        pool.close().catch(() => undefined); // ปิด pool ที่ connect ไม่สำเร็จ กัน resource ค้าง
        throw err;
      });

    return this.connectingPromise;
  }

  /**
   * รัน SQL query ทั่วไป (parameterized)
   * - กำหนด requestTimeout ทุกคำสั่ง กันคำสั่งค้างยาม DB โหลดสูง/network หลุด
   * - retry 1 ครั้งเมื่อเจอ transient connection error (ด้วย pool ใหม่)
   */
  public async query<T = any>(queryText: string, params?: { [key: string]: any }): Promise<sql.IResult<T>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const pool = await this.getPool();
        const req = pool.request();
        // @types/mssql v12 ไม่ได้ expose .timeout บน Request แต่มีตวจริง (ms)
        (req as unknown as { timeout: number }).timeout = config.dbRequestTimeout;
        if (params) {
          for (const [key, value] of Object.entries(params)) {
            req.input(key, value);
          }
        }
        return await req.query<T>(queryText);
      } catch (err: any) {
        // attempt แรก + error แบบชั่วคราว → ทิ้ง pool เก่าแล้วลองใหม่ 1 ครั้ง
        if (attempt === 0 && isTransientDbError(err)) {
          log.warn(`Query เจอ transient error (${err.message}) — กำลัง reconnect แล้วลองใหม่...`);
          const old = this.pool;
          this.pool = null;
          old?.close().catch(() => undefined);
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unexpected: query retry loop exited without result');
  }

  /**
   * ดึงข้อมูลแผนจัดส่งสินค้าจากตาราง tms_dhl_planning ตามวันที่เลือกในปฏิทิน
   *
   * SEC-FIX: เดิมประกอบ SQL ด้วย string interpolation ('${cleanDate}')
   * เสี่ยง SQL injection จาก query parameter ของ API
   * ปัจจุบันใช้ parameterized query (@loadingDate) แล้ว
   */
  public async getTmsPlanningByDate(loadingDate: string): Promise<TmsPlanningItem[]> {
    const cleanDate = loadingDate.includes('T') ? loadingDate.split('T')[0] : loadingDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
      throw new Error(`รูปแบบวันที่ไม่ถูกต้องสำหรับ query (ต้องเป็น YYYY-MM-DD): "${cleanDate}"`);
    }

    const query = `SELECT order_no,sales_order,sku,sku_descriptions,loading_datetime,province,qty,TripHeader,trip_number FROM tms_dhl_planning WHERE loading_datetime = @loadingDate AND delivery_type = 'Delivery'`;

    log.info(`รันคำสั่งดึงแผนการจัดส่งสำหรับวันที่: ${cleanDate}`);
    const result = await this.query<TmsPlanningItem>(query, { loadingDate: cleanDate });
    log.info(`ได้รับข้อมูล tms_dhl_planning จำนวน: ${result.recordset?.length ?? 0} แถว`);
    return result.recordset ?? [];
  }

  /**
   * ปิดการเชื่อมต่อ SQL Server (เรียกจาก graceful shutdown)
   */
  public async close(): Promise<void> {
    if (this.pool) {
      const pool = this.pool;
      this.pool = null;
      try {
        await pool.close();
        log.info('ปิด Connection Pool เรียบร้อย');
      } catch (err: any) {
        log.warn(`ปิด Connection Pool ไม่เรียบร้อย (อาจถูกปิดไปแล้ว): ${err.message}`);
      }
    }
  }
}

export interface TmsPlanningItem {
  order_no: string;
  sales_order: string;
  sku: string;
  sku_descriptions: string;
  loading_datetime: Date | string;
  province: string;
  qty: number;
  TripHeader: string | number;
  trip_number: string;
}

export const databaseService = DatabaseService.getInstance();
