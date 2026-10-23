import { Component, inject, signal, computed, effect, HostListener } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { DateFilterService } from '../../services/date-filter.service';
import { getApiUrl } from '../../config/api.config';

export interface BatchSummaryItem {
  batchCode: string;
  soNumber?: string;
  doNumber?: string;
  route: string;
  customer?: string;
  orderType: 'SO' | 'POSTO';
  soCount: number;
  doCount: number;
  totalQty: number;
  totalQtyCAR?: number;
  totalQtyPAC?: number;
  skusCount: number;
  matchedLines: number;
  qtyMismatchedLines?: number;
  mismatchedLines: number;
  pendingLines?: number;
  matchedQty: number;
  matchedQtyCAR?: number;
  matchedQtyPAC?: number;
  qtyMismatchedQty?: number;
  qtyMismatchedQtyCAR?: number;
  qtyMismatchedQtyPAC?: number;
  mismatchedQty: number;
  mismatchedQtyCAR?: number;
  mismatchedQtyPAC?: number;
  pendingQty?: number;
  pendingQtyCAR?: number;
  pendingQtyPAC?: number;
  matchRate: number;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'PLANNED';
  qtyByUnit?: Record<string, number>;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class DashboardComponent {
  readonly dateService = inject(DateFilterService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  // NOTE: date is NOT reset when entering this page anymore.
  // The global default (yesterday) applies only on first page load/refresh
  // (DateFilterService initial value). Navigating here keeps whatever date
  // the user picked, same as the other menus. Data loads via effect() below.

  readonly selectedTab = signal<'ALL' | 'SO' | 'POSTO'>('ALL');
  readonly isLoading = signal<boolean>(false);
  readonly isExporting = signal<boolean>(false);
  readonly syncStatus = signal<any>(null);
  readonly isFromCache = signal<boolean>(false);
  private currentDataDate: string | null = null;

  // โครงสร้างค่าเริ่มต้นของแดชบอร์ด
  private readonly defaultMetrics = {
    totalSO: 0,
    totalDO: 0,
    totalQty: 0,
    totalQtyCAR: 0,
    totalQtyPAC: 0,
    totalQtyOther: 0,
    totalSKU: 0,
    totalBatches: 0,
    totalLines: 0,
    matchedLines: 0,
    qtyMismatchedLines: 0,
    mismatchedLines: 0,
    pendingLines: 0,
    matchedQty: 0,
    matchedQtyCAR: 0,
    matchedQtyPAC: 0,
    qtyMismatchedQty: 0,
    qtyMismatchedQtyCAR: 0,
    qtyMismatchedQtyPAC: 0,
    mismatchedQty: 0,
    mismatchedQtyCAR: 0,
    mismatchedQtyPAC: 0,
    pendingQty: 0,
    pendingQtyCAR: 0,
    pendingQtyPAC: 0,
    matchedPct: 0,
    qtyMismatchedPct: 0,
    mismatchedPct: 0,
    pendingPct: 0,
    swapInPlan: 0,
    swapOutPlan: 0,
  };

  // โครงสร้างตัวแปรของ Framework แดชบอร์ด
  readonly currentData = signal({ ...this.defaultMetrics });

  // รายการ Batch
  readonly batchesList = signal<BatchSummaryItem[]>([]);

  // ควบคุมการแสดงผลคอลัมน์บนจอแท็บเล็ต/มือถือ (Responsive Columns)
  // ค่าเริ่มต้นแสดงเฉพาะ จำนวนรวม (qty) และ สถานะ (status) เหมือนหน้า SO
  readonly mobileCols = signal<{
    do: boolean;
    trip: boolean;
    type: boolean;
    sku: boolean;
    qty: boolean;
    match: boolean;
    qtyMismatch: boolean;
    mismatch: boolean;
    rate: boolean;
    status: boolean;
  }>({
    do: false,
    trip: false,
    type: false,
    sku: false,
    qty: true,
    match: false,
    qtyMismatch: false,
    mismatch: false,
    rate: true,
    status: true,
  });

  toggleMobileCol(col: 'do' | 'trip' | 'type' | 'sku' | 'qty' | 'match' | 'qtyMismatch' | 'mismatch' | 'rate' | 'status') {
    this.mobileCols.update(cols => ({
      ...cols,
      [col]: !cols[col]
    }));
  }

  // State สำหรับ Modal แสดงรายละเอียดทั้งหมดของคำสั่งซื้อเมื่อกดจุดไข่ปลา
  readonly selectedBatchDetail = signal<BatchSummaryItem | null>(null);

  openBatchDetail(batch: BatchSummaryItem): void {
    this.selectedBatchDetail.set(batch);
  }

  closeBatchDetail(): void {
    this.selectedBatchDetail.set(null);
  }

  @HostListener('document:keydown.escape')
  onEscapeHandler() {
    if (this.selectedBatchDetail()) {
      this.closeBatchDetail();
    }
  }

  readonly filteredBatches = computed(() => {
    const list = this.batchesList();
    const tab = this.selectedTab();
    if (tab === 'ALL') return list;
    return list.filter(b => b.orderType === tab);
  });

  /**
   * Share of the day weighted by QTY instead of by row count.
   */
  // FOOTER-FIX: the footer row-count respected the active tab but every total cell
  // showed whole-day metrics - the POSTO tab printed "(3)" next to the day's grand
  // totals, numbers that match no row on screen. Filtered tabs now sum the rows.
  readonly footerTotals = computed(() => {
    if (this.selectedTab() === 'ALL') {
      const d = this.currentData();
      return {
        totalSKU: d.totalSKU || 0,
        totalQty: d.totalQty || 0,
        matchedQty: d.matchedQty || 0,
        qtyMismatchedQty: d.qtyMismatchedQty || 0,
        mismatchedQty: d.mismatchedQty || 0,
        rate: this.matchedQtyPct(),
      };
    }
    const list = this.filteredBatches();
    const sum = (f: (b: BatchSummaryItem) => number | undefined) =>
      list.reduce((acc, b) => acc + (f(b) || 0), 0);
    const totalQty = sum(b => b.totalQty);
    const matchedQty = sum(b => b.matchedQty);
    return {
      totalSKU: sum(b => b.skusCount),
      totalQty,
      matchedQty,
      qtyMismatchedQty: sum(b => b.qtyMismatchedQty),
      mismatchedQty: sum(b => b.mismatchedQty),
      rate: this.getSharePct(matchedQty, totalQty, 1),
    };
  });

  readonly matchedQtyPct = computed(() => {
    const d = this.currentData();
    return this.getSharePct(d.matchedQty, d.totalQty, 1);
  });

  readonly qtyMismatchedQtyPct = computed(() => {
    const d = this.currentData();
    return this.getSharePct(d.qtyMismatchedQty, d.totalQty, 1);
  });

  readonly mismatchedQtyPct = computed(() => {
    const d = this.currentData();
    return this.getSharePct(d.mismatchedQty, d.totalQty, 1);
  });

  readonly pendingQtyPct = computed(() => {
    const d = this.currentData();
    return this.getSharePct(d.pendingQty, d.totalQty, 1);
  });

  /**
   * Proportional split for states in the ratio barometer.
   */
  readonly matchBarSplit = computed(() => {
    const d = this.currentData();
    if (!d.totalQty || d.totalQty <= 0) return { match: 0, qtyMismatch: 0, mismatch: 0, pending: 0 };
    const match = (Math.max(0, d.matchedQty) / d.totalQty) * 100;
    const qtyMismatch = (Math.max(0, d.qtyMismatchedQty) / d.totalQty) * 100;
    const mismatch = (Math.max(0, d.mismatchedQty) / d.totalQty) * 100;
    const pending = Math.max(0, 100 - match - qtyMismatch - mismatch);
    return { match, qtyMismatch, mismatch, pending };
  });

  /**
   * รูปแบบการแสดงผลกราฟ ('bar' = หลอดแนวนอน 100%, 'donut' = กราฟวงกลม)
   */
  readonly chartViewMode = signal<'bar' | 'donut'>(
    (() => {
      try {
        const saved = localStorage.getItem('barometer_chart_view_mode');
        return (saved === 'donut' || saved === 'bar') ? saved : 'bar';
      } catch {
        return 'bar';
      }
    })()
  );

  setChartViewMode(mode: 'bar' | 'donut'): void {
    this.chartViewMode.set(mode);
    try {
      localStorage.setItem('barometer_chart_view_mode', mode);
    } catch {
      // ignore
    }
  }

  /**
   * คำนวณค่าสำหรับวาด SVG Donut Chart (รัศมี r = 70, เส้นรอบวง C = 2 * PI * 70 ≈ 439.823)
   */
  readonly donutChartData = computed(() => {
    const split = this.matchBarSplit();
    const circumference = 2 * Math.PI * 70; // 439.8229715
    
    const matchLen = (split.match / 100) * circumference;
    const qtyMismatchLen = (split.qtyMismatch / 100) * circumference;
    const mismatchLen = (split.mismatch / 100) * circumference;
    const pendingLen = (split.pending / 100) * circumference;

    const matchOffset = 0;
    const qtyMismatchOffset = -matchLen;
    const mismatchOffset = -(matchLen + qtyMismatchLen);
    const pendingOffset = -(matchLen + qtyMismatchLen + mismatchLen);

    return {
      circumference,
      match: {
        len: matchLen,
        dashArray: `${matchLen} ${circumference}`,
        offset: matchOffset
      },
      qtyMismatch: {
        len: qtyMismatchLen,
        dashArray: `${qtyMismatchLen} ${circumference}`,
        offset: qtyMismatchOffset
      },
      mismatch: {
        len: mismatchLen,
        dashArray: `${mismatchLen} ${circumference}`,
        offset: mismatchOffset
      },
      pending: {
        len: pendingLen,
        dashArray: `${pendingLen} ${circumference}`,
        offset: pendingOffset
      }
    };
  });

  constructor() {
    // เมื่อมีการเปลี่ยนวันในหน้าเว็บ หรือมีการกดดึงข้อมูลใหม่จาก Header จะตรวจจับและดึงข้อมูลทันที
    effect(() => {
      const selectedIso = this.dateService.isoDate();
      const trigger = this.dateService.refreshTrigger();
      if (selectedIso) {
        this.fetchDataForDate(selectedIso);
      }
    });
  }

  fetchDataForDate(dateStr: string): void {
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr.trim();
    this.isLoading.set(true);

    // หากเปลี่ยนวันที่: ให้รีเซ็ตค่าแสดงผลเก่าออกทันที เพื่อไม่ให้ข้อมูลของวันเดิมค้างอยู่บนหน้าจอ
    if (this.currentDataDate !== cleanDate) {
      this.currentData.set({ ...this.defaultMetrics });
      this.batchesList.set([]);
      this.syncStatus.set(null);
      this.isFromCache.set(false);
    }

    const apiUrl = getApiUrl('/sync', { date: cleanDate });

    this.http.get<any>(apiUrl).subscribe({
      next: (res) => {
        // Race condition guard: หากผู้ใช้เปลี่ยนวันไปแล้ว ข้ามผลลัพธ์ของคำขอเดิม
        const currentSelected = this.dateService.isoDate();
        if (currentSelected && currentSelected !== cleanDate) {
          return;
        }

        this.isLoading.set(false);
        this.currentDataDate = cleanDate;
        this.syncStatus.set(res?.sources || null);
        this.isFromCache.set(Boolean(res?.fromCache));

        if (res && res.dashboard && res.dashboard.metrics) {
          const m = res.dashboard.metrics;
          this.currentData.set({
            totalSO: m.totalSO || 0,
            totalDO: m.totalDO || 0,
            totalQty: m.totalQty || 0,
            totalQtyCAR: m.totalQtyCAR || 0,
            totalQtyPAC: m.totalQtyPAC || 0,
            totalQtyOther: m.totalQtyOther || 0,
            totalSKU: m.totalSKU || 0,
            totalBatches: m.totalBatches || 0,
            totalLines: m.totalLines || 0,
            matchedLines: m.matchedLines || 0,
            qtyMismatchedLines: m.qtyMismatchedLines || 0,
            mismatchedLines: m.mismatchedLines || 0,
            pendingLines: m.pendingLines || 0,
            matchedQty: m.matchedQty || 0,
            matchedQtyCAR: m.matchedQtyCAR || 0,
            matchedQtyPAC: m.matchedQtyPAC || 0,
            qtyMismatchedQty: m.qtyMismatchedQty || 0,
            qtyMismatchedQtyCAR: m.qtyMismatchedQtyCAR || 0,
            qtyMismatchedQtyPAC: m.qtyMismatchedQtyPAC || 0,
            mismatchedQty: m.mismatchedQty || 0,
            mismatchedQtyCAR: m.mismatchedQtyCAR || 0,
            mismatchedQtyPAC: m.mismatchedQtyPAC || 0,
            pendingQty: m.pendingQty || 0,
            pendingQtyCAR: m.pendingQtyCAR || 0,
            pendingQtyPAC: m.pendingQtyPAC || 0,
            matchedPct: m.matchedPct || 0,
            qtyMismatchedPct: m.qtyMismatchedPct || 0,
            mismatchedPct: m.mismatchedPct || 0,
            pendingPct: m.pendingPct || 0,
            swapInPlan: m.swapInPlanCount || 0,
            swapOutPlan: m.swapOutPlanCount || 0,
          });

          if (Array.isArray(res.dashboard.batches)) {
            this.batchesList.set(res.dashboard.batches);
          } else {
            this.batchesList.set([]);
          }
        } else {
          this.currentData.set({ ...this.defaultMetrics });
          this.batchesList.set([]);
        }
      },
      error: (err) => {
        const currentSelected = this.dateService.isoDate();
        if (currentSelected && currentSelected !== cleanDate) return;

        this.isLoading.set(false);
        this.currentDataDate = cleanDate;
        this.currentData.set({ ...this.defaultMetrics });
        this.batchesList.set([]);
        this.syncStatus.set(null);
        this.isFromCache.set(false);
        console.error(`[ERROR] [Frontend] เกิดข้อผิดพลาดในการดึงข้อมูลวันที่ "${cleanDate}":`, err);
      },
    });
  }

  selectSo(soNumber: string): void {
    const sel = typeof window !== 'undefined' ? window.getSelection()?.toString().trim() : '';
    if (sel && sel.length > 0) {
      // ผู้ใช้กำลังลากคลุมข้อความเพื่อก๊อปปี้ ไม่เปลี่ยนหน้า
      return;
    }
    this.router.navigate(['/so-batches'], { queryParams: { so: soNumber } });
  }

  /**
   * Percentage of `val` over `total`. `decimals` defaults to 0 so every existing
   * call site keeps printing whole numbers; the QTY share displays pass 1 to line
   * up with the one-decimal percentages the backend already sends.
   */
  getSharePct(val: number, total: number, decimals = 0): number {
    if (!total || total === 0) return 0;
    const factor = Math.pow(10, Math.max(0, decimals));
    return Math.round((Math.max(0, val) / total) * 100 * factor) / factor;
  }

  /**
   * ส่งออกรายงานแดชบอร์ดในรูปแบบ Excel (.xlsx) ที่คำนวณและจัดรูปแบบด้วย Python
   * โดยใช้ข้อมูลตามวันที่ที่เลือกในปฏิทิน
   */
  exportExcel(): void {
    const selectedIso = this.dateService.isoDate();
    const cleanDate = selectedIso
      ? (selectedIso.includes('T') ? selectedIso.split('T')[0] : selectedIso.trim())
      : new Date().toISOString().split('T')[0];

    this.isExporting.set(true);
    const exportUrl = getApiUrl('/export/excel', { date: cleanDate });

    this.http.get(exportUrl, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        this.isExporting.set(false);
        const fileName = `Batch_Dashboard_Report_${cleanDate}.xlsx`;
        const blobUrl = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(blobUrl);
      },
      error: (err) => {
        this.isExporting.set(false);
        console.error('[ERROR] [Frontend] Export Excel error:', err);
        alert('เกิดข้อผิดพลาดในการดาวน์โหลดรายงาน Excel กรุณาลองใหม่อีกครั้ง');
      },
    });
  }
}
