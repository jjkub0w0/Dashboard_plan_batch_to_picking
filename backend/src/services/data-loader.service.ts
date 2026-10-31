import ExcelJS from 'exceljs';
import fsp from 'fs/promises';
import path from 'path';
import { RawPickingItem } from '../types/backend.types.js';
import { config } from '../config/config.js';
import { databaseService, TmsPlanningItem } from './database.service.js';
import { getTodayDateStr, tryNormalizeDate } from '../utils/date.js';
import { createLogger } from '../utils/logger.js';
import { NO_PLAN_BATCH, NO_PLAN_BATCH_LEGACY, isPlannedBatchCode } from '../utils/batch-labels.js';

const log = createLogger('data-loader');

/**
 * จำกัดจำนวนวันในแคช (กัน memory leak เมื่อรัน server ระยะยาว
 * แล้วผู้ใช้เลื่อนปฏิทินย้อนหลังหลายสิบวัน — แต่ละวันเก็บ array หลาย MB)
 * ใช้ eviction แบบ oldest-insertion (Map รักษาลำดับการ insert)
 */
const MAX_CACHED_DATES = 14;

function setCacheBounded<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHED_DATES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Async replacement for fs.existsSync on request-path code.
 *
 * STAB-FIX: fs.existsSync/readdirSync block the event loop on every call. On a
 * healthy local disk that is invisible, but `data/` also lives on network shares
 * here - one slow stat then stalls EVERY other in-flight request (including
 * /api/health, which a process manager watches). These helpers keep the loop free.
 */
async function existsAsync(target: string): Promise<boolean> {
  if (!target) return false;
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function getCellValue(cell: any): any {
  const val = cell?.value;
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') {
    if ('result' in val) return (val as any).result;
    if ('text' in val) return (val as any).text;
    if ('richText' in val) return (val as any).richText.map((t: any) => t.text).join('');
  }
  return val;
}

function cleanString(val: any): string {
  if (val === null || val === undefined) return '';
  const str = String(val).trim();
  if (str === 'nan' || str === 'NaN' || str === 'undefined' || str === 'null') return '';
  return str.replace(/\.0$/, '');
}

function parseQty(val: any): number {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (!val) return 0;
  const num = parseFloat(String(val).replace(/,/g, ''));
  return isNaN(num) ? 0 : num;
}

function parseBool(val: any): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val === 1;
  const s = String(val).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1' || s === 'y' || s === 'match';
}

export class DataLoaderService {
  private cacheByDate = new Map<string, RawPickingItem[]>();
  private outDhlCacheByDate = new Map<string, RawPickingItem[]>();
  /** STAB-FIX: concurrent loads of the same date are collapsed into one read (see dedupe()). */
  private loadInflight = new Map<string, Promise<RawPickingItem[]>>();
  private outDhlInflight = new Map<string, Promise<RawPickingItem[]>>();

  public clearCache(dateStr?: string): void {
    if (dateStr) {
      const clean = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr.trim();
      this.cacheByDate.delete(clean);
      this.outDhlCacheByDate.delete(clean);
    } else {
      this.cacheByDate.clear();
      this.outDhlCacheByDate.clear();
    }
  }

  /**
   * Collapse concurrent loads of the SAME date into one actual read.
   *
   * Why: one dashboard refresh fires /api/dashboard, /api/batches, /api/so-batches
   * ... within the same second, and each call used to re-read and JSON.parse the
   * same multi-MB snapshot (or re-query MS SQL). Under a few simultaneous users
   * that turned into duplicated CPU work, duplicated arrays in memory and slow
   * responses. Behaviour is unchanged - the callers simply share one result.
   *
   * The map entry is removed in `finally`, so a failing load can never leave a
   * "zombie" promise that every later request would await forever.
   */
  private dedupe(
    map: Map<string, Promise<RawPickingItem[]>>,
    key: string,
    factory: () => Promise<RawPickingItem[]>
  ): Promise<RawPickingItem[]> {
    const running = map.get(key);
    if (running) return running;
    const run = factory().finally(() => {
      if (map.get(key) === run) map.delete(key);
    });
    map.set(key, run);
    return run;
  }

  /**
   * Date key used for in-flight de-duplication, or '' when the input is not a
   * plain date (an uploaded Buffer or an explicit file path must NOT be shared).
   */
  private dedupeKey(sourceOrDate?: string | Buffer): string {
    if (Buffer.isBuffer(sourceOrDate)) return '';
    const input = typeof sourceOrDate === 'string' ? sourceOrDate.trim() : '';
    if (!input) return getTodayDateStr();
    return tryNormalizeDate(input) || '';
  }

  /**
   * ดึงข้อมูลจริงจากไฟล์ Excel ตามวันที่ หรือ Buffer หรือ File Path
   * หากไม่มีไฟล์จริงในระบบสำหรับวันนั้น จะคืนค่า [] (ไม่มีการจำลองข้อมูลใดๆ ทั้งสิ้น)
   */
  async loadPickingData(sourceOrDate?: string | Buffer): Promise<RawPickingItem[]> {
    const key = this.dedupeKey(sourceOrDate);
    if (!key) return this.doLoadPickingData(sourceOrDate);
    return this.dedupe(this.loadInflight, key, () => this.doLoadPickingData(sourceOrDate));
  }

  /**
   * ดึงข้อมูลนอกเหนือจากระบบ TMS จาก Snapshot ประจำวัน
   */
  async loadOutDhlData(sourceOrDate?: string): Promise<RawPickingItem[]> {
    const key = this.dedupeKey(sourceOrDate);
    if (!key) return this.doLoadOutDhlData(sourceOrDate);
    return this.dedupe(this.outDhlInflight, key, () => this.doLoadOutDhlData(sourceOrDate));
  }

  private async doLoadPickingData(sourceOrDate?: string | Buffer): Promise<RawPickingItem[]> {
    const workbook = new ExcelJS.Workbook();

    // 1. กรณีเป็น Buffer จากการอัปโหลดไฟล์
    if (Buffer.isBuffer(sourceOrDate)) {
      // cast: @types ของ exceljs เก่ากว่า Node 26 Buffer generic (Buffer<ArrayBufferLike>)
      await workbook.xlsx.load(sourceOrDate as unknown as Parameters<typeof workbook.xlsx.load>[0]);
      return this.extractRows(workbook);
    }

    const input = (typeof sourceOrDate === 'string' ? sourceOrDate.trim() : '');
    // SEC: only a real calendar date may be interpolated into a snapshot filename
    // or the SQL date filter. The old `input.split('T')[0]` let a caller-supplied
    // ?loading_datetime=../../… reach path.join(snapshotsDir, …). Anything that is
    // not a valid date falls back to today.
    const datePrefix = tryNormalizeDate(input) || getTodayDateStr();

    // An operator may also point `?date=` at a workbook inside a managed dir
    // (data/raw | uploads | processed). That has to be resolved BEFORE the snapshot
    // lookup: since the guard above turns a path into "today", a request naming a
    // file would otherwise silently get today's snapshot instead of that file.
    // SEC-FIX (earlier pass): the path must stay inside a managed dir, otherwise
    // ?date= could read any file on the machine.
    if (input && !tryNormalizeDate(input)) {
      const resolved = path.resolve(input);
      const withinManagedDirs = [config.rawDir, config.uploadsDir, config.processedDir]
        .some((dir) => resolved.startsWith(path.resolve(dir) + path.sep));
      if (withinManagedDirs && await existsAsync(resolved)) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(resolved);
        const rows = this.extractRows(wb);
        log.info(`โหลดข้อมูลจริง ${rows.length} แถวจากไฟล์ที่ชี้ตรง (${path.basename(resolved)})`);
        // not cached: the key would be a file path, not a date
        return rows;
      }
    }

    // ถ้าเคยโหลดวันที่นี้แล้ว ให้ดึงจากแคช
    if (datePrefix && this.cacheByDate.has(datePrefix)) {
      return this.cacheByDate.get(datePrefix)!;
    }

    // 2. ตรวจสอบไฟล์ JSON Snapshot ใน backend/data/snapshots/ (เช่น 2026-09-12.json)
    if (datePrefix) {
      const jsonSnapshotPath = path.join(config.snapshotsDir, `${datePrefix}.json`);
      if (await existsAsync(jsonSnapshotPath)) {
        try {
          // async read กอน JSON.parse ใหญ ๆ จะไม block event loop
          const content = await fsp.readFile(jsonSnapshotPath, 'utf8');
          const parsed = JSON.parse(content);
          let rawList: any[] = [];
          if (Array.isArray(parsed)) {
            if (parsed.length > 0 && Array.isArray(parsed[0])) {
              // 2D Array: index 0 is DHL (data_snapshot)
              rawList = parsed[0];
            } else {
              rawList = parsed;
            }
          } else if (parsed && typeof parsed === 'object') {
            rawList = parsed.data || parsed.dhl || parsed.items || [];
          }
          const normalized = this.normalizeJsonItems(rawList);
          if (normalized.length > 0) {
            log.info(`โหลด JSON Snapshot DHL ${normalized.length} แถวจาก ${path.basename(jsonSnapshotPath)}`);
            setCacheBounded(this.cacheByDate, datePrefix, normalized);
            return normalized;
          } else {
            log.warn(`ไฟล์ JSON Snapshot DHL (${path.basename(jsonSnapshotPath)}) ไม่มีข้อมูล (0 แถว) -> ดึงข้อมูลจากระบบหลัก (MS SQL)`);
          }
        } catch (err) {
          log.error(`ไม่สามารถแปลงไฟล์ JSON Snapshot (${path.basename(jsonSnapshotPath)}):`, err);
        }
      }
    }

    // 3. ค้นหาไฟล์ Excel จริงตามวันที่ใน data/raw/ หรือ defaultExcelPath
    let targetFilePath: string | null = null;

    if (datePrefix && await existsAsync(config.rawDir)) {
      // readdir (async) instead of readdirSync: this runs on every request that
      // misses the snapshot cache, and a large data/raw/ on a slow share used to
      // block the whole event loop while it was listed.
      const files = await fsp.readdir(config.rawDir);
      const [year, month, day] = datePrefix.split('-');
      const ddmmyyyy = `${day}.${month}.${year}`;
      const matched = files.find(f => 
        (f.includes(datePrefix) || f.includes(ddmmyyyy)) && 
        (f.endsWith('.xlsx') || f.endsWith('.csv'))
      );
      if (matched) {
        targetFilePath = path.join(config.rawDir, matched);
      }
    }

    // FALLBACK-FIX: DATA_EXCEL_PATH used to apply only on the hardcoded demo day
    // 2026-08-01 (unreachable in production); now it is the general default workbook
    // the config promises - used when no date-named file exists in data/raw/.
    if (!targetFilePath && config.defaultExcelPath && await existsAsync(config.defaultExcelPath)) {
      targetFilePath = config.defaultExcelPath;
    }

    // 4. หากไมพบไฟลในเครือง ใหตรวจสอบและดึงจาก MS SQL Server (tms_dhl_planning)
    //
    // dbQueryFailed: จำไวววา DB พลาดชั่้วคราว (net/DB ลง) เพื่ออ "ไม cache คาาวาาง"
    // เดิม: DB ลม 1 ครั้้ง -> cache [] ถาวร ทำให dashboard แสดง 0 เรื่้อยไปจน restart
    // ทั้้งที้ DB กลับมาแลวว (ผิิดพลาดแบบถาวรจะ cache คาาวาางตาม behavior เดิม)
    let dbQueryFailed = false;
    // ORDER-FIX: the step-4 comment always promised "query MS SQL when no file was
    // found", but the code queried SQL FIRST and returned its rows whenever SQL had
    // >=1 row - an operator-dropped workbook in data/raw/ was silently ignored.
    // The file now wins when present; SQL remains the fallback.
    const operatorWorkbook = targetFilePath && await existsAsync(targetFilePath) ? targetFilePath : null;
    if (!operatorWorkbook && datePrefix) {
      try {
        const tmsRows = await databaseService.getTmsPlanningByDate(datePrefix);
        if (tmsRows && tmsRows.length > 0) {
          log.info(`โหลดขอมูลจริง ${tmsRows.length} แถวจาก MS SQL (tms_dhl_planning) ประจำวนนท่ี ${datePrefix}`);
          const mappedRows = this.mapTmsToRawItems(tmsRows);
          setCacheBounded(this.cacheByDate, datePrefix, mappedRows);
          return mappedRows;
        }
      } catch (dbErr: any) {
        dbQueryFailed = true;
        log.warn(`ไมสามารถดึงขอมูลจาก MS SQL สำหรรับว นนท่ี "${datePrefix}":`, dbErr.message);
      }
    }

    // หากไมพบไฟลจริงและไมมข้อมูลใน MS SQL สำหรบวันทเี่ลือก ใหคืนค่าเปนครายการวาง (ไมมการจำลองข้อมูล)
    if (!operatorWorkbook) {
      log.info(`ไมมีไฟลขอ้มูลจริงหรอข้อมูลใน DB สำหรบว นนท่ี "${datePrefix || input}" -> คืนคา 0 รายการ${dbQueryFailed ? ' (DB error ชั่้วคราว: จะไม cache ผลวาง)' : ''}`);
      // cache เฉพาะกรณี "ไมมีของมูลจริง" เทานั้้น — กรณี DB fail ชั่้วคราวให retry ครั้้งถัดไป
      if (datePrefix && !dbQueryFailed) setCacheBounded(this.cacheByDate, datePrefix, []);
      return [];
    }

    await workbook.xlsx.readFile(operatorWorkbook);
    const rows = this.extractRows(workbook);
    log.info(`โหลดขอมูลจริง ${rows.length} แถวจาก ${path.basename(operatorWorkbook)}`);
    if (datePrefix) setCacheBounded(this.cacheByDate, datePrefix, rows);
    return rows;
  }

  private async doLoadOutDhlData(sourceOrDate?: string): Promise<RawPickingItem[]> {
    const input = (typeof sourceOrDate === 'string' ? sourceOrDate.trim() : '');
    // SEC: same date guard as doLoadPickingData — never let raw input name a file.
    const datePrefix = tryNormalizeDate(input) || getTodayDateStr();

    if (datePrefix && this.outDhlCacheByDate.has(datePrefix)) {
      return this.outDhlCacheByDate.get(datePrefix)!;
    }

    if (datePrefix) {
      const jsonSnapshotPath = path.join(config.snapshotsDir, `${datePrefix}.json`);
      if (await existsAsync(jsonSnapshotPath)) {
        try {
          const content = await fsp.readFile(jsonSnapshotPath, 'utf8');
          const parsed = JSON.parse(content);
          let outDhlRawList: any[] = [];

          if (Array.isArray(parsed)) {
            if (parsed.length > 1 && Array.isArray(parsed[1])) {
              // 2D Array: index 1 is ข้อมูลนอกเหนือจากระบบ TMS
              outDhlRawList = parsed[1];
            } else {
              outDhlRawList = [];
            }
          } else if (parsed && typeof parsed === 'object') {
            outDhlRawList = parsed.out_dhl || parsed.outDhl || parsed.OUT_DHL || parsed.non_tms || [];
          }

          const normalized = this.normalizeJsonItems(outDhlRawList);
          if (normalized.length > 0) {
            log.info(`โหลด JSON Snapshot ข้อมูลนอกเหนือจากระบบ TMS ${normalized.length} แถวจาก ${path.basename(jsonSnapshotPath)}`);
            setCacheBounded(this.outDhlCacheByDate, datePrefix, normalized);
            return normalized;
          }
        } catch (err) {
          log.error(`ไม่สามารถแปลงไฟล์ JSON Snapshot ข้อมูลนอกเหนือจากระบบ TMS (${path.basename(jsonSnapshotPath)}):`, err);
        }
      }
    }

    return [];
  }

  private mapTmsToRawItems(items: TmsPlanningItem[]): RawPickingItem[] {
    return items.map((r) => ({
      route: cleanString(r.trip_number || r.province || ''),
      orderType: 'SO',
      orderNum: cleanString(r.sales_order),
      do: cleanString(r.order_no),
      customer: cleanString(r.province),
      itemCode: cleanString(r.sku),
      stdDesc: cleanString(r.sku_descriptions),
      batchPlan: cleanString(r.TripHeader),
      vrfyBatch: '',
      qty: parseQty(r.qty),
      match: true,
    }));
  }

  private normalizeJsonItems(items: any[]): RawPickingItem[] {
    return items.map(r => {
      const route = cleanString(r.route || r.trip_number || r['สายส่ง'] || '');
      const soVal = cleanString(r.SO || r.so || r.orderNum || r.order_num || r.sales_order || r.order_no || r['เลขที่คำสั่งซื้อ'] || '');
      const doVal = cleanString(r.DO || r.do || r.do_num || r.order_no || r.Vbeln || r['เลขที่ do'] || '');
      const itemVal = cleanString(r.ITEM || r.item || r.ReferenceSDDocumentItem || '');
      const orderType = cleanString(
        r.orderType || r.order_type || r['ประเภท'] ||
        (soVal.startsWith('42') || doVal.startsWith('80') ? 'POSTO' : 'SO')
      );
      const customer = cleanString(r.customer || r.customer_name || r.province || r['ชื่อลูกค้า'] || '');
      const itemCode = cleanString(r.Material || r.sapMaterial || r.itemCode || r.item_code || r.sku || r['รหัสสินค้า'] || '');
      const stdDesc = cleanString(r.DeliveryDocumentItemText || r.sku_descriptions || r.stdDesc || r.std_desc || r.product_name || r['ชื่อรายการสินค้า'] || '');
      const firstBatch = Array.isArray(r.FirstBatch) ? r.FirstBatch : (r.firstBatch || []);
      const isFirstBatchAllEmpty = firstBatch.length > 0 && firstBatch.every((fb: any) => !fb.Batch || cleanString(fb.Batch) === '' || cleanString(fb.Batch) === NO_PLAN_BATCH_LEGACY);
      const firstPlannedFb = firstBatch.find((fb: any) => {
        const b = cleanString(fb.Batch);
        return isPlannedBatchCode(b);
      });
      const firstPlannedBatchCode = cleanString(firstPlannedFb?.Batch);
      const rawBatchPlan = firstPlannedBatchCode || cleanString(r.batchPlan || r.batch_plan || r['batch ตามแผน'] || '');
      const isNoPlan = (firstBatch.length > 0 && isFirstBatchAllEmpty) || (firstBatch.length === 0 && (rawBatchPlan === NO_PLAN_BATCH || rawBatchPlan === NO_PLAN_BATCH_LEGACY || !rawBatchPlan));

      // FIX (latent crash): `qty` used to be declared ~20 lines BELOW this block, so the
      // no-plan branch further down (which falls back to `qty` whenever a FirstBatch
      // entry carries no QTY) touched it inside its temporal dead zone -> ReferenceError,
      // swallowed by the caller's catch and logged as "convert JSON snapshot failed",
      // silently dropping the whole snapshot and falling back to MS SQL.
      // Verified A/B against the pre-cleanup copy (commit 74ce4b9): a row whose
      // FirstBatch is [{Batch:'', QTY:undefined}] throws "Cannot access 'qty' before
      // initialization" on the old code and normalises to the row QTY here. Existing
      // snapshots always carry fb.QTY, so all 23 of them load identically either way -
      // this removes a latent crash, it does not change today's numbers.
      const vrfyBatch = cleanString(r.vrfyBatch || r.vrfy_batch || r.Batch || r['verified batch (ล็อตจริง)'] || '');
      const qty = (r.ActualDeliveryQuantity !== undefined && r.ActualDeliveryQuantity !== null && String(r.ActualDeliveryQuantity).trim() !== '')
        ? parseQty(r.ActualDeliveryQuantity)
        : parseQty(r.qty || r.quantity || r['จำนวนรวม (ลัง)'] || 0);
      const qtyRaw = cleanString(r.qtyRaw || r.qty_raw || '');
      const deliveryQuantityUnit = cleanString(r.DeliveryQuantityUnit || r.deliveryQuantityUnit || r.unit || 'CAR').toUpperCase() || 'CAR';
      const shipToParty = cleanString(r.shipToParty || r.ShipToParty || '');
      const shipToFullName = cleanString(r.shipToFullName || r.ShipToFullName || '');
      const storageLocation = cleanString(r.storageLocation || r.StorageLocation || '');

      let batchPlan: string;
      let match: boolean;
      let firstBatchStr: string;

      if (isNoPlan) {
        batchPlan = NO_PLAN_BATCH;
        match = true;
        firstBatchStr = firstBatch.length > 0
          ? firstBatch.map((fb: any) => {
              const bName = cleanString(fb.Batch) || NO_PLAN_BATCH.trim();
              const q = fb.QTY !== undefined && fb.QTY !== null && String(fb.QTY).trim() !== '' ? parseQty(fb.QTY) : (isNoPlan ? qty : 0);
              return `${bName} (${q} ลัง)`;
            }).join(', ')
          : NO_PLAN_BATCH;
      } else {
        const matchedFb = firstBatch.find((fb: any) => cleanString(fb.Batch) === vrfyBatch);
        batchPlan = matchedFb ? cleanString(matchedFb.Batch) : (firstPlannedBatchCode || rawBatchPlan || cleanString(r.TripHeader || ''));
        match = parseBool(r.match !== undefined ? r.match : (r['ตรงตามแผน'] !== undefined ? r['ตรงตามแผน'] : (firstBatch.length > 0 ? Boolean(matchedFb) : (batchPlan && vrfyBatch ? batchPlan === vrfyBatch : false))));
        firstBatchStr = firstBatch.length > 0
          ? firstBatch.map((fb: any) => {
              const bName = cleanString(fb.Batch) || NO_PLAN_BATCH.trim();
              return `${bName} (${cleanString(fb.QTY || 0)} ลัง)`;
            }).join(', ')
          : (batchPlan || '-');
      }

      const normalizedFirstBatch = firstBatch.map((fb: any) => ({
        Batch: cleanString(fb.Batch) || NO_PLAN_BATCH,
        QTY: fb.QTY !== undefined && fb.QTY !== null && String(fb.QTY).trim() !== '' ? parseQty(fb.QTY) : (isNoPlan ? qty : 0),
      }));

      return {
        route,
        orderType,
        orderNum: soVal,
        do: doVal,
        customer,
        itemCode,
        stdDesc,
        batchPlan,
        vrfyBatch,
        sapBatch: cleanString(r.Batch || vrfyBatch),
        qty,
        deliveryQuantityUnit,
        match,
        qtyRaw,
        shipToParty,
        shipToFullName,
        storageLocation,
        firstBatch: normalizedFirstBatch.length > 0 ? normalizedFirstBatch : (isNoPlan ? [{ Batch: NO_PLAN_BATCH, QTY: qty }] : []),
        firstBatchStr,
        item: itemVal,
      };
    });
  }

  private extractRows(workbook: ExcelJS.Workbook): RawPickingItem[] {
    const sheet = workbook.getWorksheet('Raw_Items_649') || 
                  workbook.getWorksheet('ข้อมูลดิบใบหยิบ_649แถว') || 
                  workbook.worksheets[0];
    if (!sheet) return [];

    let headerRowIdx = 1;
    for (let r = 1; r <= 10; r++) {
      // cast: ExcelJS ปะ type ของ row.values เป็น union กว้างเกิน (รวม function)
      const vals = sheet.getRow(r).values as unknown as any[];
      if (Array.isArray(vals) && vals.some((v: any) => {
        const s = String(v).toLowerCase();
        return s.includes('route') || s.includes('สายส่ง') || s.includes('order_num') || s.includes('เลขที่คำสั่งซื้อ');
      })) {
        headerRowIdx = r;
        break;
      }
    }

    const headerMap: { [col: number]: string } = {};
    sheet.getRow(headerRowIdx).eachCell((cell, colNumber) => {
      headerMap[colNumber] = String(getCellValue(cell)).trim().toLowerCase();
    });

    const rows: RawPickingItem[] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowIdx) return;

      const rowObj: any = {};
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const h = headerMap[colNumber];
        if (h) rowObj[h] = getCellValue(cell);
      });

      const route = cleanString(rowObj['route'] || rowObj['สายส่ง']);
      const orderType = cleanString(rowObj['order_type'] || rowObj['ประเภท']);
      const orderNum = cleanString(rowObj['order_num'] || rowObj['order_no'] || rowObj['เลขที่คำสั่งซื้อ']);

      if (!route && !orderNum) return;

      const doVal = cleanString(rowObj['do'] || rowObj['เลขที่ do']);
      const customer = cleanString(rowObj['customer'] || rowObj['ชื่อลูกค้า']);
      const itemCode = cleanString(rowObj['item_code'] || rowObj['sku'] || rowObj['รหัสสินค้า']);
      const stdDesc = cleanString(rowObj['std_desc'] || rowObj['product_name'] || rowObj['ชื่อรายการสินค้า']);
      const batchPlan = cleanString(rowObj['batch_plan'] || rowObj['batch ตามแผน']);
      const vrfyBatch = cleanString(rowObj['vrfy_batch'] || rowObj['verified batch (ล็อตจริง)']);
      const qty = parseQty(rowObj['qty'] || rowObj['quantity'] || rowObj['จำนวนรวม (ลัง)']);
      const match = parseBool(rowObj['match'] !== undefined ? rowObj['match'] : (rowObj['ตรงตามแผน'] !== undefined ? rowObj['ตรงตามแผน'] : (batchPlan && vrfyBatch ? batchPlan === vrfyBatch : false)));
      const qtyRaw = cleanString(rowObj['qty_raw'] || '');

      rows.push({
        route,
        orderType,
        orderNum,
        do: doVal,
        customer,
        itemCode,
        stdDesc,
        batchPlan,
        vrfyBatch,
        qty,
        match,
        qtyRaw,
      });
    });

    return rows;
  }
}
