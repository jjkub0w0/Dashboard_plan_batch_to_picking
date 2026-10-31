import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { databaseService, TmsPlanningItem } from './database.service.js';
import { s3ApiService } from './s3-api.service.js';
import { fetchSapDataByVbeln, SapItem } from './sap-api.service.js';
import { CalculationService } from './calculation.service.js';
import { RawPickingItem } from '../types/backend.types.js';
import { config } from '../config/config.js';
import { trendService } from './trend.service.js';
import { eventsService } from './events.service.js';
import { createLogger } from '../utils/logger.js';
import { normalizeDateParam } from '../utils/date.js';
import { withTimeout } from '../utils/promise.js';
import { NO_PLAN_BATCH, NO_PLAN_BATCH_LEGACY, isPlannedBatchCode } from '../utils/batch-labels.js';

const log = createLogger('sync');

function cleanString(val: any): string {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function isItemEqual(itemA: any, itemB: any): boolean {
  const a = cleanString(itemA);
  const b = cleanString(itemB);
  if (!a || !b) return true; // หากไม่มีข้อมูล ITEM จากฝั่งใดฝั่งหนึ่ง (เช่น มาจาก MSSQL) ให้ถือว่าตรงตาม DO + Material
  if (a === b) return true;
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  return !isNaN(na) && !isNaN(nb) && na === nb;
}

function parseQty(val: any): number {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (!val) return 0;
  const num = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(num) ? 0 : num;
}

/**
 * Decide the "Plan Batch" label and the match verdict for ONE picked SAP row.
 *
 * MAINT-FIX: this was duplicated verbatim in step 5.1 (DHL) and step 5.2
 * (OUT_DHL) - ~20 lines each, with three subtle differences that made the two
 * copies drift-prone (see `treatAsNoPlan` / `planWhenUnmatched` below). The
 * rules themselves are unchanged:
 *
 *  1. Nothing was planned                      -> label "no plan",  match = true
 *  2. The picked batch IS one of the planned   -> label = picked batch
 *     ...but only "matched" if EVERY planned batch was actually picked
 *     (plan says A+C, warehouse picked only A  -> สลัลบั ล็อต / mismatch)
 *  3. The picked batch is NOT in the plan      -> label = the planned one,
 *                                                  match = false (swap OUT of plan)
 *
 * @param firstBatchList     planned batches from S3 (may be empty)
 * @param matchedSapList     all SAP rows that matched this line (used for the
 *                           "every planned batch was picked" check)
 * @param vrfyBatch          the batch actually picked (SAP Batch, already cleaned)
 * @param planWhenUnmatched  label to show when the picked batch is not planned
 * @param treatAsNoPlan      when true the line is "not planned" (match forced)
 */
export function resolveBatchPlan(params: {
  firstBatchList: any[];
  matchedSapList: any[];
  vrfyBatch: string;
  planWhenUnmatched: string;
  treatAsNoPlan: boolean;
}): { planBatch: string; isMatched: boolean; batchStatus: 'MATCH' | 'QTY_MISMATCH' | 'MISMATCH' | 'PENDING' } {
  const { firstBatchList, matchedSapList, vrfyBatch, planWhenUnmatched, treatAsNoPlan } = params;

  if (treatAsNoPlan) return { planBatch: NO_PLAN_BATCH, isMatched: true, batchStatus: 'MATCH' };
  if (!vrfyBatch && matchedSapList.length === 0) return { planBatch: planWhenUnmatched || NO_PLAN_BATCH, isMatched: false, batchStatus: 'PENDING' };

  const matchedFb = firstBatchList.find((fb: any) => cleanString(fb?.Batch) === vrfyBatch);
  const planBatch = matchedFb ? cleanString(matchedFb?.Batch) : planWhenUnmatched;

  const plannedBatches = firstBatchList
    .map((fb: any) => cleanString(fb?.Batch))
    .filter((b: string) => isPlannedBatchCode(b));
  const sapBatches = matchedSapList
    .map((s: any) => cleanString(s?.Batch))
    .filter(Boolean);

  const allPlannedInSap = plannedBatches.length === 0 || plannedBatches.every((pb) => sapBatches.includes(pb));
  const allSapInPlan = sapBatches.length === 0 || sapBatches.every((sb) => plannedBatches.includes(sb));
  const singleMatch = firstBatchList.length > 0
    ? Boolean(matchedFb)
    : (planBatch ? (planBatch === vrfyBatch) : true);

  const isCodeMatch = singleMatch && allPlannedInSap && allSapInPlan;
  if (!isCodeMatch) {
    return { planBatch, isMatched: false, batchStatus: 'MISMATCH' };
  }

  // Batch codes match; check if per-batch QTY matches
  let isAllQtyMatch = true;
  if (firstBatchList.length > 0 && matchedSapList.length > 0) {
    for (const fb of firstBatchList) {
      const b = cleanString(fb.Batch);
      if (!isPlannedBatchCode(b)) continue;
      const planQty = parseQty(fb.QTY);
      const sapQty = matchedSapList
        .filter((s: any) => cleanString(s.Batch) === b)
        .reduce((sum: number, s: any) => sum + parseQty(s.ActualDeliveryQuantity), 0);
      if (planQty !== sapQty) {
        isAllQtyMatch = false;
        break;
      }
    }
  }

  // เคสพิเศษ: มี plan batch > 1 และมี plan batch == null อย่างน้อย 1 ตัว
  // โดย batch ที่ดึงมาจาก fiori ตรงกับตัวอื่นในนั้นจนครบ และ qty ของแต่ละ batch ไม่น้อยกว่าที่ First batch กำหนด
  const hasNoPlanEntry = firstBatchList.some((fb: any) => {
    const b = cleanString(fb?.Batch);
    return !b || b === '-' || !isPlannedBatchCode(b);
  });
  const totalPlanQty = firstBatchList.reduce((sum: number, fb: any) => sum + parseQty(fb.QTY), 0);
  const totalSapQty = matchedSapList.reduce((sum: number, s: any) => sum + parseQty(s.ActualDeliveryQuantity), 0);
  const isTotalQtyMatch = totalPlanQty > 0 ? totalPlanQty === totalSapQty : true;

  const isSpecialNoPlanQtyMatch = hasNoPlanEntry &&
    firstBatchList.length > 1 &&
    plannedBatches.length > 0 &&
    isTotalQtyMatch &&
    plannedBatches.every((b: string) => {
      const planQty = firstBatchList
        .filter((fb: any) => cleanString(fb?.Batch) === b)
        .reduce((sum: number, fb: any) => sum + parseQty(fb.QTY), 0);
      const sapQty = matchedSapList
        .filter((s: any) => cleanString(s.Batch) === b)
        .reduce((sum: number, s: any) => sum + parseQty(s.ActualDeliveryQuantity), 0);
      return sapQty >= planQty;
    });

  if (isAllQtyMatch || isSpecialNoPlanQtyMatch) {
    return { planBatch, isMatched: true, batchStatus: 'MATCH' };
  } else {
    return { planBatch, isMatched: false, batchStatus: 'QTY_MISMATCH' };
  }
}

export interface DataFillDBItem {
  DO: string;
  SO: string;
  ITEM: string;
  Material: string;
  FirstBatch: Array<{ Batch: string; QTY: string | number }>;
  province: string;
  trip_number: string;
  sku_descriptions: string;
  TripHeader: string | number;
  qty: number;
  LatestBatch?: any[];
}

export interface PlanOutDhlItem {
  DO: string;
  SO: string;
  ITEM: string;
  Material: string;
  FirstBatch: Array<{ Batch: string; QTY: string | number }>;
  sku_descriptions?: string;
  LatestBatch?: any[];
}

export interface DataSnapshotItem {
  DO: string;
  SO: string;
  ITEM: string;
  Material: string;
  FirstBatch: Array<{ Batch: string; QTY: string | number }>;
  province: string;
  trip_number: string;
  sku_descriptions: string;
  TripHeader: string | number;
  qty: number;
  Vbeln: string;
  ReferenceSDDocument: string;
  DistributionChannel: string;
  ActualDeliveryQuantity: string | number;
  DeliveryQuantityUnit?: string;
  RegionName: string;
  sapMaterial: string;
  ReferenceSDDocumentItem: string;
  Batch: string;
  batchPlan: string;
  vrfyBatch: string;
  match: boolean;
  batchStatus?: 'MATCH' | 'QTY_MISMATCH' | 'MISMATCH' | 'PENDING';
  ShipToFullName?: string;
  ShipToParty?: string;
  StorageLocation?: string;
  DeliveryDocumentItemText?: string;
}

export interface SyncProcessResult {
  success: boolean;
  date: string;
  fromCache?: boolean;
  isDataChanged?: boolean;
  message?: string;
  steps?: {
    step1_s3: {
      success: boolean;
      totalItems: number;
      variableName: 'plan_batch';
      error?: string;
    };
    step2_mssql: {
      success: boolean;
      totalRows: number;
      variableName: 'mssql_data';
      error?: string;
    };
    step3_filter: {
      success: boolean;
      variableName: 'data_fillDB';
      totalMatched: number;
      uniqueDOsCount: number;
      uniqueDOs: string[];
    };
    step3_5_out_dhl: {
      success: boolean;
      variableName: string;
      totalOutDhlItems: number;
      uniqueDOsCount: number;
    };
    step4_sap: {
      success: boolean;
      variableName: 'sapdata';
      queriedDOsCount: number;
      totalRawItems: number;
      totalDeduplicatedItems: number;
      error?: string;
    };
    step5_snapshot: {
      success: boolean;
      variableName: 'data_snapshot';
      totalSnapshotItems: number;
      savedPath: string;
      fileSizeBytes: number;
      error?: string;
    };
    step5_out_dhl: {
      totalOutDhlSnapshot: number;
      variableName: string;
    };
  };
  sources: {
    mssql: { connected: boolean; totalRows: number; uniqueDOs: number; uniqueSOs: number; totalQty: number };
    s3: { connected: boolean; totalItems: number; url: string };
    sap: { connected: boolean; totalItems: number; concurrency: number };
  };
  /** สรุปข้อมูลนอกเหนือจากระบบ TMS — เพิ่มให้ครบตาม shape ที่ return จริง */
  outDhl?: {
    totalSnapshotItems: number;
    uniqueDOs: number;
    uniqueSOs: number;
    totalQty: number;
  };
  dashboard: any;
}

export class SyncService {
  public afterSnapshotWrite?: (date: string) => void;
  private calculator = new CalculationService();

  /**
   * Request ที่กำลังประมวลผลอยู่ ต่ อวันท่ี (per-date in-flight dedup)
   * STAB-FIX: เดิมถ้า user กด "ดึงข้อมูลใหม้" ซ้ำ (หรืือ 2 คนกดพร้อมกัน)
   * จะรัน pipeline หนกั (S3+SQL+SAP หลายร้อย request) ซ้ำบนไฟล snapshot เดียวกัน
   = เขียนแข่งกัน + ดึง SAP ซ้ำ 2 เท่า -- ตอนนี้คำขอถัดไป join ผลลัพธ์คำขอแรก
   */
  private inflight = new Map<string, Promise<SyncProcessResult>>();

  /** Cache สำหรับวันที่ตรวจสอบแล้วว่าไม่มีข้อมูล (0 รายการ) เพื่อไม่ให้ต้องเชื่อมต่อ S3/MSSQL/SAP ซ้ำๆ ทุกครั้งที่กดเปลี่ยนแท็บ (TTL 3 นาที) */
  private emptyDateCache = new Map<string, { timestamp: number; result: SyncProcessResult }>();

  public clearEmptyDateCache(dateStr?: string): void {
    if (dateStr) {
      this.emptyDateCache.delete(normalizeDateParam(dateStr));
    } else {
      this.emptyDateCache.clear();
    }
  }

  /** สำหรับ /api/health: จำนวน pipeline ที่กำลังรันอยู่ (สังเกต backlog/คอขวด) */
  public get inflightSize(): number {
    return this.inflight.size;
  }

  public async syncAllByDate(dateStr: string, sapLimit?: number, force: boolean = false): Promise<SyncProcessResult> {
    // validate/format กอน -- ปองกัน path traversal ผาน dateStr (เชน ../../x) ลงใน snapshot path
    const cleanDate = normalizeDateParam(dateStr);

    if (force) {
      this.clearEmptyDateCache(cleanDate);
    }

    const existing = this.inflight.get(cleanDate);
    if (existing) {
      log.info(`คำขอ sync วนนท่ี ${cleanDate} เข้ามารอคำขอที่กำลงรันอยู่ (join, ไมรันซ้ำ)`);
      return existing;
    }

    // STAB-FIX: the whole run is now bounded by config.syncTimeoutMs (default 15 min).
    // `finally` deletes the in-flight entry ONLY when the promise settles, so an
    // unbounded stall used to keep every future request for this date joined to a
    // zombie promise - the dashboard looked "loading" forever until a restart.
    // The race guarantees a settle, so the map always gets cleaned up.
    const run = withTimeout(this.runSyncPipeline(cleanDate, sapLimit, force), config.syncTimeoutMs, {
      label: `sync pipeline ${cleanDate}`,
    }).finally(() => this.inflight.delete(cleanDate));
    this.inflight.set(cleanDate, run);
    return run;
  }

  /**
   * กระบวนการทำงาน 5 ขั้นตอนตามคำสั่ง:
   * 1. ดึงข้อมูล api s3 ตามวันที่เลือกในหน้าปฎิทิน -> เก็บในตัวแปร plan_batch
   * 2. ดึงข้อมูล mssql ตามที่ set ไว้ -> เก็บในตัวแปร mssql_data
   * 3. นำ plan_batch ไป filter ข้อมูลใน mssql_data:
   *    ถ้า SO(s3) == sales_order(mssql) && DO(s3) == order_no(mssql)
   *    ให้สร้างตัวแปรตัวใหม่ data_fillDB เก็บ DO SO ITEM Material FirstBatch(Batch,QTY) province trip_number
   * 4. เชื่อมต่อ sap api โดยดึงข้อมูลตามวันที่ในปฎิทินที่เลือก และ Vbeln = DO(data_fillDB (loop))
   *    แล้วจัดเก็บในตัวแปร sapdata โดยตัดข้อมูลที่ซ้ำออก
   * 5. if data_fillDB.DO == sapdata.Vbeln ให้จัดเก็บข้อมูลทั้งหมดที่ตรงกันลงใน data_snapshot
   *    แล้วเก็บเป็น json ที่จัดเตรียมไว้
   */
  private async runSyncPipeline(cleanDate: string, sapLimit?: number, force: boolean = false): Promise<SyncProcessResult> {
    const snapshotPath = path.join(config.snapshotsDir, `${cleanDate}.json`);

    // -------------------------------------------------------------------------
    // ตรวจสอบ Memory Cache สำหรับวันที่ว่างเปล่า (0 รายการ): ป้องกันการรัน pipeline หนักซ้ำๆ
    // -------------------------------------------------------------------------
    if (!force) {
      const emptyCached = this.emptyDateCache.get(cleanDate);
      if (emptyCached && Date.now() - emptyCached.timestamp < 3 * 60 * 1000) {
        log.info(`[EMPTY CACHE HIT] วันที่ ${cleanDate} ตรวจสอบแล้วไม่มีข้อมูล (ส่งคืนผลลัพธ์ว่างเปล่าทันทีจาก Memory Cache)`);
        return {
          ...emptyCached.result,
          fromCache: true,
          message: `ไม่พบข้อมูลคำสั่งซื้อสำหรับวันที่ ${cleanDate} (ดึงข้อมูลล่าสุดแล้ว)`,
        };
      }
    } else {
      this.clearEmptyDateCache(cleanDate);
    }

    // -------------------------------------------------------------------------
    // ตรวจสอบไฟล์ .json แคช: ถ้ามีไฟล์ของวันที่ดึงแล้ว และไม่ได้ระบุ force=true ให้ใช้ข้อมูลในไฟล์ทันที ไม่ต้องดึงใหม่
    // -------------------------------------------------------------------------
    if (!force && fs.existsSync(snapshotPath)) {
      try {
        const fileContent = await fsp.readFile(snapshotPath, 'utf8');
        const parsed = JSON.parse(fileContent);
        let data_snapshot: DataSnapshotItem[] = [];
        let out_dhl_snapshot: DataSnapshotItem[] = [];

        if (Array.isArray(parsed)) {
          if (parsed.length > 0 && Array.isArray(parsed[0])) {
            // โครงสร้าง Array 2 มิติ: [ data_snapshot, OUT_DHL ]
            data_snapshot = parsed[0];
            out_dhl_snapshot = parsed[1] || [];
          } else {
            // โครงสร้างเดิม: Array 1 มิติ
            data_snapshot = parsed;
            out_dhl_snapshot = [];
          }
        } else if (parsed && typeof parsed === 'object') {
          data_snapshot = parsed.data || parsed.dhl || parsed.items || [];
          out_dhl_snapshot = parsed.out_dhl || parsed.outDhl || parsed.OUT_DHL || [];
        }

        // ตรวจสอบว่าไฟล์แคชมีข้อมูลจริงหรือไม่ หากเป็นไฟล์ว่างเปล่า (0 รายการ) ให้ลบทิ้งและเข้าสู่กระบวนการดึงข้อมูลใหม่
        if (data_snapshot.length === 0 && out_dhl_snapshot.length === 0) {
          log.warn(`[CACHE INVALID] ไฟล์แคช ${snapshotPath} เป็นไฟล์ว่างเปล่า (0 รายการ) -> ลบแคชและดึงข้อมูลใหม่จากภายนอก`);
          try { await fsp.unlink(snapshotPath); } catch {}
        } else {
          log.info(`[CACHE HIT] ตรวจพบไฟล์ .json ประจำวันที่: "${cleanDate}" (${path.basename(snapshotPath)}) — ใช้งานข้อมูลจากไฟล์แคชทันที`);

          const rawItems = this.snapshotToRawItems(data_snapshot);

          const dashboardResult = this.calculator.calculateDashboard(rawItems, `${cleanDate}T00:00:00`);
          const uniqueDOs = Array.from(new Set(data_snapshot.map(d => d.DO).filter(Boolean)));
          const uniqueSOs = Array.from(new Set(data_snapshot.map(d => d.SO).filter(Boolean)));
          const totalQty = rawItems.reduce((sum, r) => sum + (r.qty || 0), 0);

          return {
            success: true,
            date: cleanDate,
            fromCache: true,
            message: `ใช้งานข้อมูลจากไฟล์ .json ที่บันทึกไว้แล้ว (${path.basename(snapshotPath)}) ทั้งหมด TMS: ${data_snapshot.length} รายการ, ข้อมูลนอกเหนือจากระบบ TMS: ${out_dhl_snapshot.length} รายการ`,
            sources: {
              mssql: {
                connected: true,
                totalRows: data_snapshot.length,
                uniqueDOs: uniqueDOs.length,
                uniqueSOs: uniqueSOs.length,
                totalQty,
              },
              s3: {
                connected: true,
                totalItems: data_snapshot.length + out_dhl_snapshot.length,
                url: s3ApiService.getSnapshotUrl(cleanDate),
              },
              sap: {
                connected: true,
                totalItems: data_snapshot.length + out_dhl_snapshot.length,
                concurrency: 0,
              },
            },
            outDhl: {
              totalSnapshotItems: out_dhl_snapshot.length,
              uniqueDOs: new Set(out_dhl_snapshot.map(d => d.DO).filter(Boolean)).size,
              uniqueSOs: new Set(out_dhl_snapshot.map(d => d.SO).filter(Boolean)).size,
              totalQty: out_dhl_snapshot.reduce((sum, d) => sum + parseQty(d.ActualDeliveryQuantity || d.qty || 0), 0),
            },
            dashboard: dashboardResult,
          };
        }
      } catch (err: any) {
        log.warn(`[CACHE READ ERROR] อ่านไฟล์แคช ${snapshotPath} ล้มเหลว (${err.message}) -> กำลังดึงข้อมูลใหม่...`);
      }
    }

    log.info(`[DATA PIPELINE 5 STEPS] เริ่มกระบวนการดึงและประมวลผลข้อมูลใหม่ประจำวันที่: "${cleanDate}" (force=${force})`);

    // -------------------------------------------------------------------------
    // 1. ดึงข้อมูล API S3 ตามวันที่เลือกในหน้าปฎิทิน -> เก็บในตัวแปร plan_batch (In-Memory เท่านั้น ไม่บันทึกเป็นไฟล์)
    // -------------------------------------------------------------------------
    log.info(`[ขั้นตอนที่ 1] ดึงข้อมูล AWS S3 (BatchDO) ตามวันที่เลือก: ${cleanDate}`);
    log.info(`   รูปแบบการจัดเก็บ: จัดเก็บในตัวแปร plan_batch (ใน RAM) ไม่มีการบันทึกไฟล์ .json ในขั้นตอนนี้`);
    const s3Url = s3ApiService.getSnapshotUrl(cleanDate);
    log.info(`   - S3 URL: ${s3Url}`);

    let plan_batch: any[] = [];
    let s3Success = false;
    let s3Error: string | undefined;

    try {
      const s3Raw = await s3ApiService.fetchSnapshotJson(cleanDate);
      plan_batch = Array.isArray(s3Raw) ? s3Raw : (s3Raw.data || s3Raw.items || []);
      s3Success = true;
      log.info(`   [OK] plan_batch: จัดเก็บในตัวแปรสำเร็จ ${plan_batch.length} รายการ (In-Memory Only ไม่มีการเขียนไฟล์)`);
    } catch (err: any) {
      s3Error = err.message;
      log.warn(`   plan_batch: ไม่สามารถดึงข้อมูล S3 ได้ (${err.message})`);
    }

    // -------------------------------------------------------------------------
    // 2. ดึงข้อมูล MS SQL ตามที่ set ไว้ -> เก็บใน mssql_data
    // -------------------------------------------------------------------------
    log.info(`[ขั้นตอนที่ 2] ดึงข้อมูล MS SQL Server (tms_dhl_planning) ประจำวันที่: ${cleanDate}`);
    // log.info(`   - Query: SELECT order_no,sales_order,sku,sku_descriptions,loading_datetime,province,qty,TripHeader,trip_number FROM tms_dhl_planning WHERE loading_datetime = '${cleanDate}' AND delivery_type = 'Delivery'`);

    let mssql_data: TmsPlanningItem[] = [];
    let mssqlSuccess = false;
    let mssqlError: string | undefined;

    try {
      mssql_data = await databaseService.getTmsPlanningByDate(cleanDate);
      mssqlSuccess = true;
      log.info(`   [OK] mssql_data: จัดเก็บข้อมูลสำเร็จ ${mssql_data.length} แถว`);
    } catch (err: any) {
      mssqlError = err.message;
      log.error(`   [ERROR] mssql_data: ดึงข้อมูล MS SQL ล้มเหลว (${err.message})`);
    }

    // -------------------------------------------------------------------------
    // 3. นำ plan_batch ไป filter ข้อมูลใน mssql_data
    //    เงื่อนไข: SO(s3) == sales_order(mssql) && DO(s3) == order_no(mssql) && Material(s3) == sku(mssql)
    //    สร้างตัวแปรใหม่ ชื่อ data_fillDB เก็บ DO SO ITEM Material FirstBatch(Batch,QTY) province trip_number
    // -------------------------------------------------------------------------
    log.info(`[ขั้นตอนที่ 3] ตรวจสอบเงื่อนไข: SO(s3) == sales_order(mssql) && DO(s3) == order_no(mssql) && Material(s3) == sku(mssql)`);
    // SQL-BLIP-GUARD: when MS SQL failed but S3 HAS rows, every S3 row falls into
    // plan_out_DHL below (sqlIndex is empty) - saving that as the day snapshot would
    // permanently misclassify all TMS orders as Non-TMS (cache-hit serves it forever).
    // Pipeline still returns a provisional in-memory result, but the write is skipped.
    const sqlBlipPoisoned = !mssqlSuccess && plan_batch.length > 0;

    const data_fillDB: DataFillDBItem[] = [];
    const plan_out_DHL: PlanOutDhlItem[] = [];

    // PERF-FIX: build a lookup index ONCE instead of `mssql_data.find(...)` per
    // S3 row. The old nested scan was O(plan_batch x mssql_data) and ran
    // synchronously inside the request: 2k x 2k rows = ~4M cleanString()/trim()
    // calls in a single event-loop turn, which froze /api/health and every other
    // user for the whole scan (the "event loop หน่วง" warning in server.ts).
    //
    // Behaviour is identical to Array#find: the FIRST row that matches a key wins,
    // because we only insert a key when it is not already present.
    // NUL (\u0000) separates the fields: it cannot appear in SO/DO/SKU text, so
    // two different (SO, DO, SKU) triples can never collide into one key.
    const sqlIndex = new Map<string, TmsPlanningItem[]>();
    for (const sql of mssql_data) {
      const key = `${cleanString(sql.sales_order)}\u0000${cleanString(sql.order_no)}\u0000${cleanString(sql.sku).toUpperCase()}`;
      if (!sqlIndex.has(key)) sqlIndex.set(key, []);
      sqlIndex.get(key)!.push(sql);
    }

    if (plan_batch.length > 0) {
      for (const s3 of plan_batch) {
        const s3So = cleanString(s3.SO);
        const s3Do = cleanString(s3.DO);
        const s3Mat = cleanString(s3.Material);

        // ค้นหารายการใน mssql_data ที่ตรงกัน: SO == sales_order && DO == order_no && Material == sku
        const key = `${s3So}\u0000${s3Do}\u0000${s3Mat.toUpperCase()}`;
        const sqlList = sqlIndex.get(key);

        if (sqlList && sqlList.length > 0) {
          // หากมีหลายแถวที่ SKU เดียวกัน ให้จับคู่กับแถวใน MS SQL ที่มี qty ตรงกับผลรวม FirstBatch ของ S3 item นี้
          const s3FbList = Array.isArray(s3.FirstBatch) ? s3.FirstBatch : [];
          const s3FbQty = s3FbList.reduce((sum: number, fb: any) => sum + (Number(fb?.QTY) || 0), 0);

          let matchIdx = -1;
          if (s3FbQty > 0) {
            matchIdx = sqlList.findIndex(sql => Number(sql.qty) === s3FbQty);
          }
          if (matchIdx === -1) {
            matchIdx = 0; // fallback ลำดับแรก (FIFO)
          }

          const [sqlMatch] = sqlList.splice(matchIdx, 1);

          data_fillDB.push({
            DO: s3Do,
            SO: s3So,
            ITEM: cleanString(s3.Item || s3.ITEM),
            Material: s3Mat || cleanString(sqlMatch.sku),
            FirstBatch: s3.FirstBatch || [],
            province: cleanString(sqlMatch.province),
            trip_number: cleanString(sqlMatch.trip_number),
            sku_descriptions: cleanString(sqlMatch.sku_descriptions),
            TripHeader: sqlMatch.TripHeader,
            qty: Number(sqlMatch.qty) || 0,
            LatestBatch: s3.LatestBatch || [],
          });
        } else {
          // ขั้นตอนที่ 3.5: หากดึง DB แล้วไม่พบ ให้แยกจัดเก็บอีกตัวแปรชื่อ plan_out_DHL
          plan_out_DHL.push({
            DO: s3Do,
            SO: s3So,
            ITEM: cleanString(s3.Item || s3.ITEM),
            Material: s3Mat,
            FirstBatch: s3.FirstBatch || [],
            LatestBatch: s3.LatestBatch || [],
          });
        }
      }
    } else if (mssql_data.length > 0) {
      // กรณี S3 ไม่มีไฟล์หรือไม่สามารถเข้าถึงได้ ให้ใช้ข้อมูลจาก MS SQL เป็นฐานหลักสำหรับ DHL
      log.info(`[FALLBACK TO MSSQL] S3 ไม่มีข้อมูลประจำวันที่ ${cleanDate} -> ดำเนินการใช้ข้อมูลจาก MS SQL (${mssql_data.length} แถว) เป็นฐาน`);
      for (const sql of mssql_data) {
        const sqlDo = cleanString(sql.order_no);
        const sqlSo = cleanString(sql.sales_order);
        const sqlSku = cleanString(sql.sku);
        const sqlTripHeader = cleanString(sql.TripHeader);
        const sqlQty = Number(sql.qty) || 0;

        data_fillDB.push({
          DO: sqlDo,
          SO: sqlSo,
          ITEM: '',
          Material: sqlSku,
          FirstBatch: sqlTripHeader ? [{ Batch: sqlTripHeader, QTY: sqlQty }] : [],
          province: cleanString(sql.province),
          trip_number: cleanString(sql.trip_number),
          sku_descriptions: cleanString(sql.sku_descriptions),
          TripHeader: sql.TripHeader,
          qty: sqlQty,
          LatestBatch: [],
        });
      }
    }

    const uniqueDOs = Array.from(new Set(data_fillDB.map(d => d.DO).filter(Boolean)));
    const uniqueOutDhlDOs = Array.from(new Set(plan_out_DHL.map(d => d.DO).filter(Boolean)));

    log.info(`[OK] data_fillDB (DHL): กรองและสร้างตัวแปรสำเร็จ ${data_fillDB.length} รายการ (พบ ${uniqueDOs.length} DOs ที่ตรงกัน)`);
    log.info(`plan_out_DHL (ขั้นตอนที่ 3.5): ไม่พบใน TMS DB ${plan_out_DHL.length} รายการ (พบ ${uniqueOutDhlDOs.length} DOs ข้อมูลนอกเหนือจากระบบ TMS)`);
    if (uniqueOutDhlDOs.length > 0) {
      log.info(`   • ตัวอย่าง OUT_DHL DOs: ${uniqueOutDhlDOs.slice(0, 5).join(', ')}`);
    }

    // -------------------------------------------------------------------------
    // 4. เชื่อมต่อ SAP Fiori OData ตาม Vbeln = DO (ทั้งจาก data_fillDB และ plan_out_DHL)
    // -------------------------------------------------------------------------
    const allUniqueDOs = Array.from(new Set([...uniqueDOs, ...uniqueOutDhlDOs]));
    log.info(`[ขั้นตอนที่ 4] เชื่อมต่อ SAP Fiori OData ตาม Vbeln = DO (รวม ${allUniqueDOs.length} DOs: TMS ${uniqueDOs.length} + Non-TMS ${uniqueOutDhlDOs.length})`);
    let sapdata: SapItem[] = [];
    let sapSuccess = false;
    let sapError: string | undefined;

    const targetDOs = sapLimit && sapLimit > 0 ? allUniqueDOs.slice(0, sapLimit) : allUniqueDOs;

    if (targetDOs.length > 0) {
      try {
        sapdata = await fetchSapDataByVbeln(targetDOs, cleanDate, 2);
        sapSuccess = true;
        log.info(`[OK] sapdata: จัดเก็บข้อมูลที่ตัดซ้ำแล้วสำเร็จ ${sapdata.length} รายการ (จาก ${targetDOs.length} DOs)`);
      } catch (err: any) {
        sapError = err.message;
        log.error(`[ERROR] sapdata: เกิดข้อผิดพลาดในการดึง SAP Fiori: ${err.message}`);
      }
    } else {
      log.info(`sapdata: ไม่มีรายการ DO จาก data_fillDB หรือ plan_out_DHL จึงข้ามการดึง SAP`);
    }

    // -------------------------------------------------------------------------
    // 5. ตรวจสอบเงื่อนไข: DO == Vbeln && Material == sapdata.Material && ITEM == ReferenceSDDocumentItem
    //    สร้าง data_snapshot (TMS) และ OUT_DHL (ข้อมูลนอกเหนือจากระบบ TMS)
    // -------------------------------------------------------------------------
    log.info(`[ขั้นตอนที่ 5] ตรวจสอบเงื่อนไข -> สร้าง data_snapshot (TMS) และ OUT_DHL (ข้อมูลนอกเหนือจากระบบ TMS)`);
    let data_snapshot: DataSnapshotItem[] = [];
    let OUT_DHL: DataSnapshotItem[] = [];

    // 5.1 สร้าง data_snapshot สำหรับ DHL
    for (const fill of data_fillDB) {
      const matchedSapList = sapdata.filter(
        s => cleanString(s.Vbeln) === fill.DO &&
             cleanString(s.Material).toUpperCase() === fill.Material.toUpperCase() &&
             isItemEqual(fill.ITEM, s.ReferenceSDDocumentItem)
      );

      if (matchedSapList.length > 0) {
        for (const sap of matchedSapList) {
          const firstBatchList = Array.isArray(fill.FirstBatch) ? fill.FirstBatch : [];
          const isFirstBatchEmpty = firstBatchList.length > 0 && firstBatchList.every((fb: any) => !fb.Batch || cleanString(fb.Batch) === '');
          const hasNoFirstBatch = firstBatchList.length === 0;
          const vrfyBatch = cleanString(sap.Batch);

          // DHL rule: an empty FirstBatch still counts as "planned" when the trip
          // header carries a batch code - that code is the fallback label.
          const treatAsNoPlan = isFirstBatchEmpty || (hasNoFirstBatch && !fill.TripHeader);
          const firstPlannedFb = firstBatchList.find((fb: any) => isPlannedBatchCode(cleanString(fb?.Batch)));
          const planWhenUnmatched = cleanString(firstPlannedFb?.Batch) || cleanString(fill.TripHeader);

          const { planBatch, isMatched, batchStatus } = resolveBatchPlan({
            firstBatchList,
            matchedSapList,
            vrfyBatch,
            planWhenUnmatched,
            treatAsNoPlan,
          });

          data_snapshot.push({
            DO: fill.DO,
            SO: fill.SO,
            ITEM: fill.ITEM,
            Material: fill.Material,
            FirstBatch: fill.FirstBatch,
            province: fill.province,
            trip_number: fill.trip_number,
            sku_descriptions: cleanString(sap.DeliveryDocumentItemText) || fill.sku_descriptions,
            TripHeader: fill.TripHeader,
            qty: (sap.ActualDeliveryQuantity !== undefined && sap.ActualDeliveryQuantity !== null && String(sap.ActualDeliveryQuantity).trim() !== '')
              ? parseQty(sap.ActualDeliveryQuantity)
              : fill.qty,

            Vbeln: cleanString(sap.Vbeln),
            ReferenceSDDocument: cleanString(sap.ReferenceSDDocument),
            DistributionChannel: cleanString(sap.DistributionChannel),
            ActualDeliveryQuantity: sap.ActualDeliveryQuantity,
            DeliveryQuantityUnit: cleanString(sap.DeliveryQuantityUnit || 'CAR').toUpperCase() || 'CAR',
            RegionName: cleanString(sap.RegionName),
            sapMaterial: cleanString(sap.Material),
            ReferenceSDDocumentItem: cleanString(sap.ReferenceSDDocumentItem),
            Batch: vrfyBatch,

            batchPlan: planBatch,
            vrfyBatch,
            match: isMatched,
            batchStatus,
            ShipToFullName: cleanString(sap.ShipToFullName),
            ShipToParty: cleanString(sap.ShipToParty),
            StorageLocation: cleanString(sap.StorageLocation),
            DeliveryDocumentItemText: cleanString(sap.DeliveryDocumentItemText),
          });
        }
      } else {
        // หากไม่มีข้อมูลใน SAP (เช่น เป็นวันที่ล่วงหน้า/วันพรุ่งนี้ หรือ SAP ยังไม่ได้บันทึกยอดหยิบ)
        // ให้นำข้อมูลแผนจัดส่งจาก fill ใส่ไว้ใน data_snapshot โดยระบุ vrfyBatch ว่าง เพื่อแสดงสถานะ "รอข้อมูล SAP"
        const firstBatchList = Array.isArray(fill.FirstBatch) ? fill.FirstBatch : [];
        const firstPlannedFb = firstBatchList.find((fb: any) => {
          const b = cleanString(fb.Batch);
          return isPlannedBatchCode(b);
        });
        const planBatch = cleanString(firstPlannedFb?.Batch) || cleanString(fill.TripHeader) || NO_PLAN_BATCH;
        data_snapshot.push({
          DO: fill.DO,
          SO: fill.SO,
          ITEM: fill.ITEM,
          Material: fill.Material,
          FirstBatch: fill.FirstBatch,
          province: fill.province,
          trip_number: fill.trip_number,
          sku_descriptions: fill.sku_descriptions,
          TripHeader: fill.TripHeader,
          qty: fill.qty,

          Vbeln: fill.DO,
          ReferenceSDDocument: fill.SO,
          DistributionChannel: '',
          ActualDeliveryQuantity: String(fill.qty),
          DeliveryQuantityUnit: 'CAR',
          RegionName: fill.province,
          sapMaterial: fill.Material,
          ReferenceSDDocumentItem: fill.ITEM,
          Batch: '',

          batchPlan: planBatch,
          vrfyBatch: '',
          match: false,
          batchStatus: 'PENDING',
          ShipToFullName: '',
          ShipToParty: '',
          StorageLocation: '',
          DeliveryDocumentItemText: '',
        });
      }
    }

    // 5.2 สร้าง OUT_DHL (ถ้า นำ DO ไปดึงใน SAP แล้วพบว่ามีข้อมูล ให้จัดเก็บที่ตัวแปรชื่อ OUT_DHL)
    for (const outItem of plan_out_DHL) {
      const matchedSapList = sapdata.filter(
        s => cleanString(s.Vbeln) === outItem.DO &&
             cleanString(s.Material).toUpperCase() === outItem.Material.toUpperCase() &&
             isItemEqual(outItem.ITEM, s.ReferenceSDDocumentItem)
      );

      if (matchedSapList.length > 0) {
        for (const sap of matchedSapList) {
          const firstBatchList = Array.isArray(outItem.FirstBatch) ? outItem.FirstBatch : [];
          const isFirstBatchEmpty = firstBatchList.length > 0 && firstBatchList.every((fb: any) => !fb.Batch || cleanString(fb.Batch) === '');
          const hasNoFirstBatch = firstBatchList.length === 0;
          const vrfyBatch = cleanString(sap.Batch);

          // OUT_DHL rule (differs from 5.1 on purpose): no TripHeader fallback, and
          // the fallback label is literally entry [0] - even when that entry is the
          // "no batch planned" sentinel. Those differences are why this is a
          // parameter of the shared helper rather than a merged rule.
          const treatAsNoPlan = isFirstBatchEmpty || hasNoFirstBatch;
          const planWhenUnmatched = cleanString(firstBatchList[0]?.Batch) || NO_PLAN_BATCH;

          const { planBatch, isMatched, batchStatus } = resolveBatchPlan({
            firstBatchList,
            matchedSapList,
            vrfyBatch,
            planWhenUnmatched,
            treatAsNoPlan,
          });

          const sapRegion = cleanString(sap.RegionName) || 'ข้อมูลนอกเหนือจากระบบ TMS';
          const sapDesc = cleanString(sap.DeliveryDocumentItemText) || cleanString(sap.MaterialDesc) || cleanString(outItem.sku_descriptions) || cleanString(sap.Material) || '';

          OUT_DHL.push({
            DO: outItem.DO,
            SO: outItem.SO,
            ITEM: cleanString(sap.ReferenceSDDocumentItem || outItem.ITEM),
            Material: outItem.Material,
            FirstBatch: outItem.FirstBatch,
            province: sapRegion,
            trip_number: 'NON_TMS',
            sku_descriptions: sapDesc,
            TripHeader: '',
            qty: (sap.ActualDeliveryQuantity !== undefined && sap.ActualDeliveryQuantity !== null && String(sap.ActualDeliveryQuantity).trim() !== '')
              ? parseQty(sap.ActualDeliveryQuantity)
              : 0,

            Vbeln: cleanString(sap.Vbeln),
            ReferenceSDDocument: cleanString(sap.ReferenceSDDocument),
            DistributionChannel: cleanString(sap.DistributionChannel),
            ActualDeliveryQuantity: sap.ActualDeliveryQuantity,
            DeliveryQuantityUnit: cleanString(sap.DeliveryQuantityUnit || 'CAR').toUpperCase() || 'CAR',
            RegionName: sapRegion,
            sapMaterial: cleanString(sap.Material),
            ReferenceSDDocumentItem: cleanString(sap.ReferenceSDDocumentItem),
            Batch: vrfyBatch,

            batchPlan: planBatch,
            vrfyBatch,
            match: isMatched,
            batchStatus,
            ShipToFullName: cleanString(sap.ShipToFullName),
            ShipToParty: cleanString(sap.ShipToParty),
            StorageLocation: cleanString(sap.StorageLocation),
            DeliveryDocumentItemText: cleanString(sap.DeliveryDocumentItemText),
          });
        }
      }
    }

    // จัดเก็บเป็นไฟล์ JSON ในโฟลเดอร์ snapshots/ รูปแบบ Array 2 มิติ [ data_snapshot, OUT_DHL ]
    // สำคัญ: บันทึกไฟล์ก็ต่อเมื่อมีข้อมูลอย่างน้อย 1 รายการ (ไม่บันทึกไฟล์ว่าง [[], []] เพื่อป้องกันแคชเสียหาย)
    let fileSize = 0;
    let snapshotSaveError: string | undefined;
    let isDataChanged = true;

    if (sqlBlipPoisoned) {
      isDataChanged = false;
      log.warn(`[SKIP WRITE] MS SQL down while S3 had ${plan_batch.length} rows - snapshot NOT saved (would misclassify TMS rows as Non-TMS)`);
    } else if (data_snapshot.length > 0 || OUT_DHL.length > 0) {
      const snapshotData = [data_snapshot, OUT_DHL];
      const newJson = JSON.stringify(snapshotData, null, 2);

      try {
        if (fs.existsSync(snapshotPath)) {
          const oldJson = await fsp.readFile(snapshotPath, 'utf8');
          if (oldJson === newJson) {
            isDataChanged = false;
          }
        }

        if (isDataChanged) {
          // ATOMIC-WRITE: tmp+rename is atomic on one volume: readers only ever see complete files.
          const tmpPath = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
          await fsp.writeFile(tmpPath, newJson, 'utf8');
          try {
            await fsp.rename(tmpPath, snapshotPath);
          } catch (renameErr) {
            await fsp.unlink(tmpPath).catch(() => undefined);
            throw renameErr;
          }
          fileSize = (await fsp.stat(snapshotPath)).size;
          try { this.afterSnapshotWrite?.(cleanDate); } catch { /* hook must never break the pipeline */ }
          log.info(`[SAVE] จัดเก็บไฟล์ JSON เรียบร้อย (ข้อมูลเปลี่ยนแปลง): ${snapshotPath} (${(fileSize / 1024).toFixed(1)} KB)`);
          trendService.clearCache();
        } else {
          fileSize = (await fsp.stat(snapshotPath)).size;
          log.info(`[UNCHANGED] ข้อมูลเหมือนเดิม ไม่มีการเปลี่ยนแปลง ข้ามการเขียนไฟล์ (${snapshotPath})`);
        }
      } catch (writeErr: any) {
        snapshotSaveError = writeErr.message;
        log.error(`Failed to save snapshot ${snapshotPath}: ${writeErr.message} (result still returned in-memory)`);
      }
    } else {
      isDataChanged = false;
      log.info(`ไม่มีข้อมูลสำหรับบันทึกไฟล์ snapshot (ข้ามการเขียนไฟล์ เพื่อไม่ให้เกิดแคชว่างเปล่า)`);
    }

    // บรอดแคสต์แจ้งเตือน Client ก็ต่อเมื่อมีข้อมูลและข้อมูลมีการเปลี่ยนแปลงจริงเท่านั้น
    if (isDataChanged && (data_snapshot.length > 0 || OUT_DHL.length > 0)) {
      eventsService.broadcastDataUpdate(cleanDate, isDataChanged);
    }

    log.info(`[สรุปผลการทำงานครบทุกขั้นตอน ประจำวันที่ ${cleanDate}]:`);
    log.info(`   1. plan_batch      (S3)      : ${plan_batch.length} รายการ`);
    log.info(`   2. mssql_data      (MSSQL)   : ${mssql_data.length} แถว`);
    log.info(`   3. data_fillDB     (DHL)     : ${data_fillDB.length} รายการ (${uniqueDOs.length} unique DOs)`);
    log.info(`   3.5 plan_out_DHL   (Non-TMS)  : ${plan_out_DHL.length} รายการ (${uniqueOutDhlDOs.length} unique DOs)`);
    log.info(`   4. sapdata         (SAP)      : ${sapdata.length} รายการ (ตัดซ้ำแล้ว)`);
    log.info(`   5.1 data_snapshot  (Index 0)  : ${data_snapshot.length} รายการ (TMS)`);
    log.info(`   5.2 OUT_DHL        (Index 1)  : ${OUT_DHL.length} รายการ (ข้อมูลนอกเหนือจากระบบ TMS)`);

    // -------------------------------------------------------------------------
    // คำนวณ Dashboard Metrics สำหรับส่งให้ Frontend แสดงผลแบบ Real-time
    // -------------------------------------------------------------------------
    const rawItems: RawPickingItem[] = data_snapshot.length > 0
      ? this.snapshotToRawItems(data_snapshot)
      : mssql_data.map(r => ({
          route: cleanString(r.trip_number || r.province || ''),
          orderType: (cleanString(r.sales_order).startsWith('42') || cleanString(r.order_no).startsWith('80')) ? 'POSTO' : 'SO',
          orderNum: cleanString(r.sales_order),
          do: cleanString(r.order_no),
          customer: cleanString(r.province),
          itemCode: cleanString(r.sku),
          stdDesc: cleanString(r.sku_descriptions),
          batchPlan: cleanString(r.TripHeader),
          vrfyBatch: '',
          sapBatch: '',
          qty: Number(r.qty) || 0,
          deliveryQuantityUnit: 'CAR',
          match: true,
          firstBatch: [],
          firstBatchStr: cleanString(r.TripHeader) || '-',
        }));

    const dashboardResult = this.calculator.calculateDashboard(rawItems, `${cleanDate}T00:00:00`);

    const resultMessage = sqlBlipPoisoned
      ? 'MS SQL down during sync - provisional in-memory result only, snapshot NOT saved. Retry in a few minutes (it self-heals).'
      : (data_snapshot.length > 0 || OUT_DHL.length > 0)
      ? (`ดึงและประมวลผลข้อมูลใหม่จาก 3 ระบบ (S3, MSSQL, SAP) สำเร็จ และบันทึกไฟล์ ${path.basename(snapshotPath)} เรียบร้อย` + (snapshotSaveError ? ` [snapshot save warning: ${snapshotSaveError}]` : ''))
      : `ไม่พบข้อมูลคำสั่งซื้อสำหรับวันที่ ${cleanDate} จากระบบ S3, MSSQL และ SAP`;
    const result: SyncProcessResult = {
      success: true,
      date: cleanDate,
      fromCache: false,
      isDataChanged,
      message: resultMessage,
      steps: {
        step1_s3: {
          success: s3Success,
          totalItems: plan_batch.length,
          variableName: 'plan_batch',
          error: s3Error,
        },
        step2_mssql: {
          success: mssqlSuccess,
          totalRows: mssql_data.length,
          variableName: 'mssql_data',
          error: mssqlError,
        },
        step3_filter: {
          success: true,
          variableName: 'data_fillDB',
          totalMatched: data_fillDB.length,
          uniqueDOsCount: uniqueDOs.length,
          uniqueDOs,
        },
        step3_5_out_dhl: {
          success: true,
          variableName: 'plan_out_DHL',
          totalOutDhlItems: plan_out_DHL.length,
          uniqueDOsCount: uniqueOutDhlDOs.length,
        },
        step4_sap: {
          success: sapSuccess,
          variableName: 'sapdata',
          queriedDOsCount: targetDOs.length,
          totalRawItems: sapdata.length,
          totalDeduplicatedItems: sapdata.length,
          error: sapError,
        },
        step5_snapshot: {
          success: true,
          variableName: 'data_snapshot',
          totalSnapshotItems: data_snapshot.length,
          savedPath: snapshotPath,
          fileSizeBytes: fileSize,
          error: snapshotSaveError,
        },
        step5_out_dhl: {
          totalOutDhlSnapshot: OUT_DHL.length,
          variableName: 'OUT_DHL',
        },
      },
      sources: {
        mssql: {
          connected: mssqlSuccess,
          totalRows: mssql_data.length,
          uniqueDOs: new Set(mssql_data.map(m => m.order_no)).size,
          uniqueSOs: new Set(mssql_data.map(m => m.sales_order)).size,
          totalQty: mssql_data.reduce((sum, r) => sum + (Number(r.qty) || 0), 0),
        },
        s3: {
          connected: s3Success,
          totalItems: plan_batch.length,
          url: s3Url,
        },
        sap: {
          connected: sapSuccess,
          totalItems: sapdata.length,
          concurrency: 2,
        },
      },
      outDhl: {
        totalSnapshotItems: OUT_DHL.length,
        uniqueDOs: new Set(OUT_DHL.map(d => d.DO).filter(Boolean)).size,
        uniqueSOs: new Set(OUT_DHL.map(d => d.SO).filter(Boolean)).size,
        totalQty: OUT_DHL.reduce((sum, d) => sum + parseQty(d.ActualDeliveryQuantity || d.qty || 0), 0),
      },
      dashboard: dashboardResult,
    };

    if (data_snapshot.length === 0 && OUT_DHL.length === 0 && s3Success && mssqlSuccess && sapSuccess) {
      // only cache "no orders" when every source answered OK - a transient SQL/SAP
      // outage must not pin an empty result for 3 min against user retries
      this.emptyDateCache.set(cleanDate, { timestamp: Date.now(), result });
    }

    return result;
  }

  /**
   * Tranlate DataSnapshotItem[] -> RawPickingItem[] for dashboard calculation.
   * (DEDUPE-FIX: this mapper was copy-pasted in 2 places: cache branch and
   *  fresh pipeline branch. Kept byte-identical to the original logic.)
   */
  private snapshotToRawItems(snapshot: DataSnapshotItem[]): RawPickingItem[] {
    return snapshot.map(s => {

          const firstBatch = Array.isArray(s.FirstBatch) ? s.FirstBatch : [];
          const isFirstBatchAllEmpty = firstBatch.length > 0 && firstBatch.every((fb: any) => !fb.Batch || cleanString(fb.Batch) === '' || cleanString(fb.Batch) === NO_PLAN_BATCH_LEGACY);
          const firstPlannedFb = firstBatch.find((fb: any) => {
            const b = cleanString(fb.Batch);
            return isPlannedBatchCode(b);
          });
          const firstPlannedBatchCode = cleanString(firstPlannedFb?.Batch);
          const rawBatchPlan = firstPlannedBatchCode || cleanString(s.batchPlan || '');
          const isNoPlan = (firstBatch.length > 0 && isFirstBatchAllEmpty) || (firstBatch.length === 0 && (rawBatchPlan === NO_PLAN_BATCH || rawBatchPlan === NO_PLAN_BATCH_LEGACY || !rawBatchPlan));

          const planBatch = isNoPlan ? NO_PLAN_BATCH : (firstPlannedBatchCode || s.batchPlan || '-');
          const itemQty = (s.ActualDeliveryQuantity !== undefined && s.ActualDeliveryQuantity !== null && String(s.ActualDeliveryQuantity).trim() !== '')
            ? parseQty(s.ActualDeliveryQuantity)
            : parseQty(s.qty || 0);

          const normalizedFirstBatch = firstBatch.map((fb: any) => ({
            Batch: cleanString(fb.Batch) || NO_PLAN_BATCH,
            QTY: fb.QTY !== undefined && fb.QTY !== null && String(fb.QTY).trim() !== '' ? parseQty(fb.QTY) : (isNoPlan ? itemQty : 0),
          }));

          const planTotalQty = normalizedFirstBatch.reduce((sum: number, fb: any) => sum + (Number(fb.QTY) || 0), 0);
          const firstBatchStr = normalizedFirstBatch.length > 0
            ? normalizedFirstBatch.map((fb: any) => {
                const bName = cleanString(fb.Batch) || NO_PLAN_BATCH.trim();
                return `${bName} (${cleanString(fb.QTY || 0)} ลัง)`;
              }).join(', ')
            : (isNoPlan ? (planTotalQty > 0 ? `${NO_PLAN_BATCH.trim()} (${planTotalQty} ลัง)` : NO_PLAN_BATCH) : (s.batchPlan || '-'));

          const sapBatchStr = cleanString(s.Batch || s.vrfyBatch);
          const hasSap = Boolean(sapBatchStr);
          let batchStatus: 'MATCH' | 'QTY_MISMATCH' | 'MISMATCH' | 'PENDING';
          if (!hasSap) {
            batchStatus = 'PENDING';
          } else if (isNoPlan) {
            const isQtyMatch = planTotalQty > 0 ? planTotalQty === itemQty : true;
            batchStatus = isQtyMatch ? 'MATCH' : 'QTY_MISMATCH';
          } else {
            batchStatus = s.batchStatus || (s.match ? 'MATCH' : 'MISMATCH');
          }
          const isMatched = batchStatus === 'MATCH';

          return {
            route: s.trip_number || s.province || 'UNKNOWN',
            orderType: (cleanString(s.SO).startsWith('42') || cleanString(s.DO).startsWith('80')) ? 'POSTO' : 'SO',
            orderNum: s.SO,
            do: s.DO,
            customer: s.province,
            itemCode: s.Material,
            stdDesc: cleanString((s as any).DeliveryDocumentItemText) || cleanString(s.sku_descriptions) || '',
            batchPlan: planBatch,
            vrfyBatch: s.vrfyBatch,
            sapBatch: sapBatchStr,
            qty: itemQty,
            deliveryQuantityUnit: cleanString(s.DeliveryQuantityUnit || 'CAR').toUpperCase() || 'CAR',
            match: isMatched,
            batchStatus,
            firstBatch: normalizedFirstBatch.length > 0 ? normalizedFirstBatch : (isNoPlan ? [{ Batch: NO_PLAN_BATCH, QTY: itemQty }] : []),
            firstBatchStr,
            item: cleanString(s.ReferenceSDDocumentItem || s.ITEM || ''),
            shipToFullName: cleanString(s.ShipToFullName),
            shipToParty: cleanString(s.ShipToParty),
            storageLocation: cleanString(s.StorageLocation || (s as any).storageLocation),
          };
    });
  }
}

export const syncService = new SyncService();
