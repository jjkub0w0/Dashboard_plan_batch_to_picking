import fsp from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config/config.js';
import { DataLoaderService } from './data-loader.service.js';
import { CalculationService } from './calculation.service.js';
import { RawPickingItem } from '../types/backend.types.js';
import { createLogger } from '../utils/logger.js';
import { getTodayDateStr, getBangkokIsoString } from '../utils/date.js';

const execFileAsync = promisify(execFile);
const log = createLogger('excel-export');

export interface ExcelExportResult {
  fileName: string;
  filePath: string;
  buffer: Buffer;
  generatedAt: string;
}

function resolveCategory(
  so: string,
  shipToParty?: string,
  storageLocation?: string
): { category: 'IBD' | 'RETURN' | 'OTHER'; label: string } {
  const s = String(so || '').trim();
  const p = String(shipToParty || '').trim();
  const sl = String(storageLocation || '').trim().toUpperCase();

  // 1. IBD: ถ้าเลข SO ขึ้นต้นด้วย 132
  if (s.startsWith('132')) {
    return { category: 'IBD', label: 'IBD' };
  }
  // 2. การส่งคืน (Return): ถ้า ShipToParty == 1200 หรือ StorageLocation ขึ้นต้นด้วย RT
  if (p === '1200' || sl.startsWith('RT')) {
    return { category: 'RETURN', label: 'ส่งคืน' };
  }
  // 3. อื่นๆ
  return { category: 'OTHER', label: 'อื่นๆ' };
}

export class ExcelExportService {
  constructor(
    private dataLoader: DataLoaderService,
    private calculator: CalculationService
  ) {}

  /**
   * Shared date rule for both reports: "YYYY-MM-DD", a datetime (trimmed to its
   * date part) or nothing at all (= today, UTC as before).
   */
  private normalizeDate(dateStr?: string): string {
    return dateStr
      ? (dateStr.includes('T') ? dateStr.split('T')[0] : dateStr.trim())
      : getTodayDateStr();
  }

  /**
   * Row shape the Python generator expects. Both reports used to carry their own
   * copy of this mapping (MAINT-FIX: ~15 duplicated lines that had to be edited twice).
   */
  private toExportRows(items: RawPickingItem[], isNonTms: boolean = false) {
    return items.map(item => {
      const base: Record<string, any> = {
        SO: item.orderNum,
        DO: item.do,
        Route: item.route,
        Customer: item.customer,
        Material: item.itemCode,
        Description: item.stdDesc,
        PlanBatch: item.batchPlan || '-',
        FirstBatch: item.firstBatchStr || '-',
        SapBatch: item.sapBatch || '-',
        Qty: item.qty,
        Unit: item.deliveryQuantityUnit || 'CAR',
      };

      if (isNonTms) {
        const cat = resolveCategory(item.orderNum, item.shipToParty, item.storageLocation);
        base.Status = cat.label;
        base.CheckResult = item.match ? 'ตรงตามแนะนำ' : 'เปลี่ยนล็อต';
      } else {
        base.Status = item.match ? 'ตรงตามแนะนำ' : 'เปลี่ยนล็อต';
      }

      return base;
    });
  }

  /**
   * Run the Python generator once and return the finished workbook.
   *
   * STAB-FIX - three real bugs that existed in BOTH copy-pasted versions:
   *
   * 1. STALE REPORT: the output name was fixed per date and only checked with
   *    existsSync() AFTER Python ran. If the script wrote nothing but an older
   *    report for the same date was still on disk, the check passed and the user
   *    downloaded yesterday numbers while the UI said "success". The output path
   *    is now unique per call, so "the file exists" can only mean "this run made it".
   * 2. RACE: two users downloading the same date wrote the SAME .xlsx and could
   *    read each other half-written file (corrupt download, or a zip that Excel
   *    refuses to open). Unique paths remove the overlap entirely.
   * 3. DISK LEAK: every download left its .xlsx in data/exports/ forever, and the
   *    temp JSON survived any early throw. Both are removed in `finally` now - the
   *    workbook is already in `buffer`, nothing reads these files from disk again.
   *
   * The timeout comes from config.pythonTimeoutMs (was a hardcoded 120s) and a
   * missing interpreter now reports an actionable error instead of bare "ENOENT".
   */
  private async runPythonReport(
    exportData: unknown,
    cleanDate: string,
    fileStem: string
  ): Promise<ExcelExportResult> {
    const stamp = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const tempJsonPath = path.join(config.exportsDir, `temp_${fileStem}_${cleanDate}_${stamp}.json`);
    // Name shown to the user stays clean/stable; only the on-disk file is unique.
    const outputFileName = `${fileStem}_${cleanDate}.xlsx`;
    const outputExcelPath = path.join(config.exportsDir, `${fileStem}_${cleanDate}_${stamp}.xlsx`);

    try {
      await fsp.writeFile(tempJsonPath, JSON.stringify(exportData, null, 2), 'utf8');

      const scriptPath = path.resolve(config.backendRoot, 'scripts', 'generate_excel_dashboard.py');
      const pythonExe = process.platform === 'win32' ? 'python' : 'python3';

      log.info(`generating ${fileStem} report for ${cleanDate} via Python`);

      const scriptArgs = [scriptPath, '--input-json', tempJsonPath, '--output-path', outputExcelPath, '--date', cleanDate];
      let stdout = '';
      let stderr = '';
      try {
        ({ stdout, stderr } = await execFileAsync(pythonExe, scriptArgs, {
          timeout: config.pythonTimeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        }));
      } catch (err: any) {
        // execFile sets killed+signal when the timeout fires; ENOENT means Python
        // is not on PATH (very common after a server rebuild) - say so plainly.
        if (err?.code === 'ENOENT') {
          throw new Error(
            `Python ("${pythonExe}") is not installed or not on PATH on this server - ` +
            `install Python (the Excel report generator needs it) or set PYTHON on PATH.`
          );
        }
        if (err?.killed) {
          throw new Error(
            `Excel generation for ${cleanDate} exceeded the ${Math.round(config.pythonTimeoutMs / 1000)}s ` +
            `timeout (config.pythonTimeoutMs) - the Python process was killed.`
          );
        }
        throw err;
      }

      if (stdout) log.info(`python: ${stdout.trim()}`);
      if (stderr) log.warn(`python stderr: ${stderr.trim()}`);

      let size = -1;
      try {
        size = (await fsp.stat(outputExcelPath)).size;
      } catch {
        throw new Error(`Excel report was not produced for ${cleanDate} - see the python output above.`);
      }
      if (size <= 0) {
        throw new Error(`Excel report for ${cleanDate} was created empty (0 bytes) - refusing to download it.`);
      }

      const buffer = await fsp.readFile(outputExcelPath);

      return {
        fileName: outputFileName,
        filePath: outputExcelPath,
        buffer,
        generatedAt: getBangkokIsoString(),
      };
    } finally {
      // best-effort cleanup - a failed unlink must never mask the real result
      await fsp.unlink(tempJsonPath).catch(() => undefined);
      await fsp.unlink(outputExcelPath).catch(() => undefined);
    }
  }

  /**
   * สร้างไฟล์ Excel แดชบอร์ด (.xlsx) สำหรับวันที่ที่เลือก
   * โดยใช้ข้อมูลในระบบ (READ-ONLY) ส่งให้ Python script สร้างรายงานอย่างสมบูรณ์
   */
  async generateDashboardExcel(dateStr?: string): Promise<ExcelExportResult> {
    const cleanDate = this.normalizeDate(dateStr);

    // Fresh rows only: drop the cached date so the report reflects the latest
    // snapshot + SAP quantities instead of what an earlier request cached.
    this.dataLoader.clearCache(cleanDate);

    // 1. real rows for the selected date
    const rawItems = await this.dataLoader.loadPickingData(cleanDate);

    // 2. dashboard totals
    const dashboardResult = this.calculator.calculateDashboard(rawItems, `${cleanDate}T00:00:00`);

    // 3. payload for the Python generator
    const exportData = {
      date: cleanDate,
      metrics: dashboardResult.metrics,
      batches: dashboardResult.batches,
      soBatchDetails: dashboardResult.soBatchDetails || [],
      rawItems: this.toExportRows(rawItems),
    };

    return this.runPythonReport(exportData, cleanDate, 'Batch_Dashboard_Report');
  }

  /**
   * สร้างไฟล์ Excel สำหรับรายการข้อมูลนอกเหนือจากระบบ TMS
   */
  async generateOutDhlDashboardExcel(dateStr?: string): Promise<ExcelExportResult> {
    const cleanDate = this.normalizeDate(dateStr);

    this.dataLoader.clearCache(cleanDate);

    // 1. real Non-TMS rows for the selected date
    const rawItems = await this.dataLoader.loadOutDhlData(cleanDate);

    // 2. dashboard totals
    const dashboardResult = this.calculator.calculateDashboard(rawItems, `${cleanDate}T00:00:00`);

    // 3. Enrich batches with category info for Non-TMS
    const enrichedBatches = dashboardResult.batches.map(b => {
      const soNum = b.soNumber || b.batchCode || '';
      let cat = resolveCategory(soNum);
      if (cat.category === 'OTHER' && b.batchDetails && b.batchDetails.length > 0) {
        const anyReturn = b.batchDetails.some(d => d.shipToParty === '1200' || String(d.storageLocation || '').trim().toUpperCase().startsWith('RT'));
        if (anyReturn) {
          cat = { category: 'RETURN', label: 'ส่งคืน' };
        }
      }
      return {
        ...b,
        category: cat.category,
        categoryLabel: cat.label,
      };
    });

    // 4. Enrich soBatchDetails with category info for Non-TMS
    const enrichedDetails = (dashboardResult.soBatchDetails || []).map(d => {
      const cat = resolveCategory(d.so, d.shipToParty, d.storageLocation);
      return {
        ...d,
        category: cat.category,
        categoryLabel: cat.label,
      };
    });

    // 5. payload for the Python generator
    const exportData = {
      date: cleanDate,
      isNonTms: true,
      reportTitle: `รายงานข้อมูลนอกเหนือจากระบบ TMS | ประจำวันที่: ${cleanDate}`,
      metrics: dashboardResult.metrics,
      batches: enrichedBatches,
      soBatchDetails: enrichedDetails,
      rawItems: this.toExportRows(rawItems, true),
    };

    return this.runPythonReport(exportData, cleanDate, 'Batch_Dashboard_Report_Non_TMS');
  }
}
