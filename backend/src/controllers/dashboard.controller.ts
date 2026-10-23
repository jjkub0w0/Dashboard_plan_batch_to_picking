import { Request, Response } from 'express';
import { DataLoaderService } from '../services/data-loader.service.js';
import { CalculationService } from '../services/calculation.service.js';
import { databaseService } from '../services/database.service.js';
import { syncService } from '../services/sync.service.js';
import { trendService } from '../services/trend.service.js';
import { ExcelExportService } from '../services/excel-export.service.js';
import { getTodayDateStr, tryNormalizeDate } from '../utils/date.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('dashboard-api');

/**
 * Date the caller asked for: `date`, else `loading_datetime`, else today.
 * Replaces the identical 3-term expression that was copy-pasted into every handler.
 */
function requestedDate(req: Request): string {
  return (req.query.date as string) || (req.query.loading_datetime as string) || getTodayDateStr();
}

/** Same date reduced to YYYY-MM-DD (the route guard already rejected malformed input). */
function toPlainDate(dateParam: string): string {
  return tryNormalizeDate(dateParam) || getTodayDateStr();
}

export class DashboardController {
  private excelExportService: ExcelExportService;

  constructor(
    private dataLoader: DataLoaderService,
    private calculator: CalculationService,
    excelExportService?: ExcelExportService
  ) {
    this.excelExportService = excelExportService || new ExcelExportService(dataLoader, calculator);
  }

  /**
   * GET /api/dashboard
   * ดึงข้อมูลภาพรวมแดชบอร์ดทั้งหมด (SO, DO, QTY, SKU, Batch, Matched, Mismatched)
   */
  getDashboardData = async (req: Request, res: Response): Promise<void> => {
    try {
      const dateParam = requestedDate(req);
      const rawItems = await this.dataLoader.loadPickingData(dateParam);
      const result = this.calculator.calculateDashboard(rawItems, dateParam);

      res.json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      log.error('Error in getDashboardData:', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  };

  /**
   * GET /api/batches
   * ดึงรายการรอบ Batch ทั้งหมด พร้อมตัวกรองประเภทคำสั่งซื้อ (SO, POSTO)
   */
  getBatches = async (req: Request, res: Response): Promise<void> => {
    try {
      const dateParam = requestedDate(req);
      const typeFilter = req.query.type as string | undefined;

      const rawItems = await this.dataLoader.loadPickingData(dateParam);
      const result = this.calculator.calculateDashboard(rawItems, dateParam);

      let batches = result.batches;
      if (typeFilter && ['SO', 'POSTO'].includes(typeFilter.toUpperCase())) {
        batches = batches.filter(b => b.orderType === typeFilter.toUpperCase());
      }

      res.json({
        success: true,
        total: batches.length,
        batches,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  };

  /**
   * GET /api/mismatched
   * ดึงรายการสินค้าที่มีการหยิบสลับล็อต (Mismatched Batches)
   */
  getMismatched = async (req: Request, res: Response): Promise<void> => {
    try {
      const dateParam = requestedDate(req);
      const rawItems = await this.dataLoader.loadPickingData(dateParam);
      const result = this.calculator.calculateDashboard(rawItems, dateParam);

      res.json({
        success: true,
        total: result.mismatchedLines.length,
        items: result.mismatchedLines,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  };

/**
   * GET /api/planning
   * ดึงข้อมูลแผนการจัดส่งจาก MS SQL Server (tms_dhl_planning) ตามวันที่เลือกในปฏิทิน
   * Query: SELECT order_no,sales_order,sku,sku_descriptions,loading_datetime,province,qty,TripHeader,trip_number FROM tms_dhl_planning WHERE loading_datetime = '{date}' AND delivery_type = 'Delivery'
   */
  getPlanningData = async (req: Request, res: Response): Promise<void> => {
    try {
      const dateParam = requestedDate(req);
      const cleanDate = toPlainDate(dateParam);

      const rows = await databaseService.getTmsPlanningByDate(cleanDate);
      const uniqueSOs = Array.from(new Set(rows.map(r => r.sales_order).filter(Boolean)));
      const totalQty = rows.reduce((sum, r) => sum + (Number(r.qty) || 0), 0);
      const uniqueSkus = new Set(rows.map(r => r.sku).filter(Boolean)).size;

      res.json({
        success: true,
        loadingDate: cleanDate,
        totalRows: rows.length,
        totalQty,
        uniqueSalesOrdersCount: uniqueSOs.length,
        uniqueSkusCount: uniqueSkus,
        uniqueSalesOrders: uniqueSOs,
        data: rows,
      });
    } catch (err: any) {
      log.error('Error in getPlanningData:', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  };

  /**
   * GET /api/sync
   * GET /api/sync/date
   * ดึงและเชื่อมต่อข้อมูล 3 ระบบ (MS SQL / S3 / SAP Fiori) ตามวันที่ที่ระบุ พร้อมแสดง log และคำนวณแดชบอร์ด
   */
  syncDataByDate = async (req: Request, res: Response): Promise<void> => {
    try {
      const dateParam = requestedDate(req);
      const sapLimit = req.query.sapLimit ? parseInt(req.query.sapLimit as string, 10) : undefined;
      const force = req.query.force === 'true' || req.query.refresh === 'true';

      if (force) {
        this.dataLoader.clearCache(dateParam);
      }

      const result = await syncService.syncAllByDate(dateParam, sapLimit, force);
      res.json(result);
    } catch (err: any) {
      log.error('Error in syncDataByDate:', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  };

  /**
   * GET /api/export/excel
   * ส่งออกรายงานแดชบอร์ดในรูปแบบ Excel (.xlsx) ที่คำนวณและจัดรูปแบบด้วย Python
   * โดยดึงข้อมูลตามวันที่ที่เลือกในระบบ (READ-ONLY)
   */
  exportExcel = async (req: Request, res: Response): Promise<void> => {
    try {
      const dateParam = requestedDate(req);
      const cleanDate = toPlainDate(dateParam);

      log.info(`Requesting Excel export for date: ${cleanDate}`);
      const result = await this.excelExportService.generateDashboardExcel(cleanDate);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.setHeader('Content-Length', result.buffer.length);
      res.send(result.buffer);
    } catch (err: any) {
      log.error('Error in exportExcel:', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  };

  /**
   * GET /api/out-dhl
   * ดึงข้อมูลภาพรวมและรายละเอียดข้อมูลนอกเหนือจากระบบ TMS
   */
  getOutDhlData = async (req: Request, res: Response): Promise<void> => {
    try {
      const dateParam = requestedDate(req);
      let rawItems = await this.dataLoader.loadOutDhlData(dateParam);

      // หากยังไม่มีข้อมูล snapshot ในเครื่อง และมีการระบุวันที่ ให้ลองเรียก sync pipeline อัตโนมัติ
      if (rawItems.length === 0 && dateParam) {
        try {
          const syncRes = await syncService.syncAllByDate(dateParam, undefined, false);
          if (syncRes && syncRes.outDhl && syncRes.outDhl.totalSnapshotItems > 0) {
            rawItems = await this.dataLoader.loadOutDhlData(dateParam);
          }
        } catch (syncErr: any) {
          log.warn(`Auto sync for out-dhl (${dateParam}) failed: ${syncErr?.message || syncErr}`);
        }
      }

      const result = this.calculator.calculateDashboard(rawItems, dateParam);

      res.json({
        success: true,
        data: result,
      });
    } catch (err: any) {
      log.error('Error in getOutDhlData:', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  };

  /**
   * GET /api/export/excel/out-dhl
   * ส่งออกรายงาน Excel (.xlsx) สำหรับรายการข้อมูลนอกเหนือจากระบบ TMS
   */
  exportOutDhlExcel = async (req: Request, res: Response): Promise<void> => {
    try {
      const dateParam = requestedDate(req);
      const cleanDate = toPlainDate(dateParam);

      log.info(`Requesting Non-TMS Excel export for date: ${cleanDate}`);
      const result = await this.excelExportService.generateOutDhlDashboardExcel(cleanDate);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
      res.setHeader('Content-Length', result.buffer.length);
      res.send(result.buffer);
    } catch (err: any) {
      log.error('Error in exportOutDhlExcel:', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  };

  /**
   * GET /api/trends
   * ดึงข้อมูลสรุปแนวโน้มความถูกต้องของ Batch รายวันจากไฟล์ JSON Snapshot ทั้งหมด
   */
  getTrendsData = async (req: Request, res: Response): Promise<void> => {
    try {
      const force = req.query.force === 'true' || req.query.force === '1';
      const trends = await trendService.getDailyTrends(force);

      res.json({
        success: true,
        data: trends,
      });
    } catch (err: any) {
      log.error(`Error in getTrendsData: ${err.message}`);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  };
}
