import fsp from 'fs/promises';
import { config } from '../config/config.js';
import { createLogger } from '../utils/logger.js';
import { DataLoaderService } from './data-loader.service.js';
import { CalculationService } from './calculation.service.js';

const log = createLogger('trend-service');

/**
 * fs.existsSync is synchronous: one slow stat (data/ often sits on a network
 * share) would block the event loop for every other in-flight request.
 */
async function existsAsync(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export interface DailyTrendItem {
  date: string;
  totalQty: number;
  matchedQty: number;
  mismatchedQty: number;
  qtyMismatchedQty?: number;
  pendingQty?: number;
  matchedPct: number;
  mismatchedPct: number;
  qtyMismatchedPct?: number;
  pendingPct?: number;
  totalSOs: number;
  matchedSOs: number;
  mismatchedSOs: number;
  soMatchPct: number;
  soMismatchedPct: number;
  totalLines: number;
  matchedLines: number;
  mismatchedLines: number;
  qtyMismatchedLines?: number;
  pendingLines?: number;
  lineMatchPct: number;
  lineMismatchedPct: number;
}

export interface TrendsSummary {
  totalDays: number;
  startDate: string;
  endDate: string;
  totalQtyAllDays: number;
  totalMatchedQtyAllDays: number;
  totalMismatchedQtyAllDays: number;
  totalQtyMismatchedQtyAllDays?: number;
  totalPendingQtyAllDays?: number;
  avgMatchedPct: number;
  avgMismatchedPct: number;
  bestDay: { date: string; matchedPct: number } | null;
  worstDay: { date: string; mismatchedPct: number } | null;
  daily: DailyTrendItem[];
}

export class TrendService {
  private cache: TrendsSummary | null = null;
  /**
   * STAB-FIX: the scan in progress, if any (see getDailyTrends).
   */
  private inflight: Promise<TrendsSummary> | null = null;
  private lastScannedTime = 0;
  private readonly snapshotsDir: string;
  private readonly dataLoader: DataLoaderService;
  private readonly calculator: CalculationService;

  constructor(
    snapshotsDir?: string,
    dataLoader?: DataLoaderService,
    calculator?: CalculationService
  ) {
    this.snapshotsDir = snapshotsDir || config.snapshotsDir;
    this.dataLoader = dataLoader || new DataLoaderService();
    this.calculator = calculator || new CalculationService();
  }

  /**
   * ล้าง In-memory cache เพื่อให้คำนวณใหม่เมื่อมี snapshot ใหม่
   */
  public clearCache(): void {
    this.cache = null;
    this.lastScannedTime = 0;
  }

  /**
   * อ่าน snapshot ทั้งหมดและคำนวณสถิติรายวัน
   * เรียงลำดับชื่อไฟล์ตามวันที่ (เก่าไปใหม่ ซ้ายไปขวา)
   *
   * STAB-FIX: concurrent cache misses are collapsed into ONE scan. The trends page,
   * a manual refresh and other endpoints can all miss the cache in the same tick,
   * and every miss reads + JSON.parses EVERY snapshot file (tens of MB together).
   * Running that three times over at once spiked CPU and heap exactly when the
   * server was already busy. Each caller still gets the same fresh result.
   *
   * The handle is cleared in `finally`, so a failed scan can never leave later
   * requesters awaiting a promise that already settled (a "zombie" freeze).
   */
  public async getDailyTrends(force = false): Promise<TrendsSummary> {
    const now = Date.now();
    // Cache มีอายุ 60 วินาที ถ้าไม่ force
    if (!force && this.cache && now - this.lastScannedTime < 60_000) {
      return this.cache;
    }

    if (this.inflight) return this.inflight;
    const running = this.scanSnapshots().finally(() => {
      if (this.inflight === running) this.inflight = null;
    });
    this.inflight = running;
    return running;
  }

  /** The actual directory scan (one call at a time - guarded by getDailyTrends). */
  private async scanSnapshots(): Promise<TrendsSummary> {
    if (!(await existsAsync(this.snapshotsDir))) {
      log.warn(`Snapshots directory does not exist: ${this.snapshotsDir}`);
      return this.getEmptySummary();
    }

    try {
      const allFiles = await fsp.readdir(this.snapshotsDir);
      // กรองเฉพาะไฟล์ที่ชื่อเป็น YYYY-MM-DD.json
      const dateFiles = allFiles
        .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort((a, b) => a.localeCompare(b)); // เรียงจากวันที่มาก่อน (เก่า -> ใหม่)

      if (dateFiles.length === 0) {
        return this.getEmptySummary();
      }

      const daily: DailyTrendItem[] = [];

      for (const fileName of dateFiles) {
        const date = fileName.replace('.json', '');

        try {
          const rawItems = await this.dataLoader.loadPickingData(date);
          if (!rawItems || rawItems.length === 0) {
            continue;
          }

          const result = this.calculator.calculateDashboard(rawItems, date);
          const { metrics, batches } = result;

          const totalQty = metrics.totalQty;
          const matchedQty = metrics.matchedQty;
          const mismatchedQty = metrics.mismatchedQty;
          const qtyMismatchedQty = metrics.qtyMismatchedQty || 0;
          const pendingQty = metrics.pendingQty || 0;

          // % คำนวณแบบถ่วงน้ำหนัก QTY ตามมาตรฐานเดียวกับหน้า Dashboard (matchedQtyPct / mismatchedQtyPct)
          const matchedPct = totalQty > 0 ? Number(((matchedQty / totalQty) * 100).toFixed(1)) : 0;
          const mismatchedPct = totalQty > 0 ? Number(((mismatchedQty / totalQty) * 100).toFixed(1)) : 0;
          const qtyMismatchedPct = totalQty > 0 ? Number(((qtyMismatchedQty / totalQty) * 100).toFixed(1)) : 0;
          const pendingPct = totalQty > 0 ? Number(((pendingQty / totalQty) * 100).toFixed(1)) : 0;

          const totalLines = metrics.totalLines;
          const matchedLines = metrics.matchedLines;
          const mismatchedLines = metrics.mismatchedLines;
          const qtyMismatchedLines = metrics.qtyMismatchedLines || 0;
          const pendingLines = metrics.pendingLines || 0;

          const lineMatchPct = totalLines > 0 ? Number(((matchedLines / totalLines) * 100).toFixed(1)) : 0;
          const lineMismatchedPct = totalLines > 0 ? Number(((mismatchedLines / totalLines) * 100).toFixed(1)) : 0;

          const totalSOs = batches.length || metrics.totalSO;
          const matchedSOs = batches.filter(b => b.status === 'COMPLETED').length;
          const mismatchedSOs = totalSOs - matchedSOs;

          const soMatchPct = totalSOs > 0 ? Number(((matchedSOs / totalSOs) * 100).toFixed(1)) : 0;
          const soMismatchedPct = totalSOs > 0 ? Number(((mismatchedSOs / totalSOs) * 100).toFixed(1)) : 0;

          daily.push({
            date,
            totalQty,
            matchedQty,
            mismatchedQty,
            qtyMismatchedQty,
            pendingQty,
            matchedPct,
            mismatchedPct,
            qtyMismatchedPct,
            pendingPct,
            totalSOs,
            matchedSOs,
            mismatchedSOs,
            soMatchPct,
            soMismatchedPct,
            totalLines,
            matchedLines,
            mismatchedLines,
            qtyMismatchedLines,
            pendingLines,
            lineMatchPct,
            lineMismatchedPct,
          });
        } catch (readErr: any) {
          log.warn(`ไม่สามารถคำนวณข้อมูลแนวโน้ม snapshot ${fileName}: ${readErr.message}`);
        }
      }

      if (daily.length === 0) {
        return this.getEmptySummary();
      }

      const totalDays = daily.length;
      const startDate = daily[0].date;
      const endDate = daily[daily.length - 1].date;

      let totalQtyAllDays = 0;
      let totalMatchedQtyAllDays = 0;
      let totalMismatchedQtyAllDays = 0;
      let totalQtyMismatchedQtyAllDays = 0;
      let totalPendingQtyAllDays = 0;

      let bestDay: { date: string; matchedPct: number } | null = null;
      let worstDay: { date: string; mismatchedPct: number } | null = null;

      for (const d of daily) {
        totalQtyAllDays += d.totalQty;
        totalMatchedQtyAllDays += d.matchedQty;
        totalMismatchedQtyAllDays += d.mismatchedQty;
        totalQtyMismatchedQtyAllDays += (d.qtyMismatchedQty || 0);
        totalPendingQtyAllDays += (d.pendingQty || 0);

        if (d.totalQty > 0) {
          if (!bestDay || d.matchedPct > bestDay.matchedPct) {
            bestDay = { date: d.date, matchedPct: d.matchedPct };
          }
          if (!worstDay || d.mismatchedPct > worstDay.mismatchedPct) {
            worstDay = { date: d.date, mismatchedPct: d.mismatchedPct };
          }
        }
      }

      const avgMatchedPct = totalQtyAllDays > 0
        ? Number(((totalMatchedQtyAllDays / totalQtyAllDays) * 100).toFixed(1))
        : 0;
      const avgMismatchedPct = totalQtyAllDays > 0
        ? Number(((totalMismatchedQtyAllDays / totalQtyAllDays) * 100).toFixed(1))
        : 0;

      const summary: TrendsSummary = {
        totalDays,
        startDate,
        endDate,
        totalQtyAllDays,
        totalMatchedQtyAllDays,
        totalMismatchedQtyAllDays,
        totalQtyMismatchedQtyAllDays,
        totalPendingQtyAllDays,
        avgMatchedPct,
        avgMismatchedPct,
        bestDay,
        worstDay,
        daily,
      };

      this.cache = summary;
      this.lastScannedTime = Date.now();
      return summary;
    } catch (err: any) {
      log.error(`เกิดข้อผิดพลาดในการคำนวณแนวโน้มภาพรวม: ${err.message}`);
      return this.getEmptySummary();
    }
  }

  private getEmptySummary(): TrendsSummary {
    return {
      totalDays: 0,
      startDate: '',
      endDate: '',
      totalQtyAllDays: 0,
      totalMatchedQtyAllDays: 0,
      totalMismatchedQtyAllDays: 0,
      totalQtyMismatchedQtyAllDays: 0,
      totalPendingQtyAllDays: 0,
      avgMatchedPct: 0,
      avgMismatchedPct: 0,
      bestDay: null,
      worstDay: null,
      daily: [],
    };
  }
}

export const trendService = new TrendService();
