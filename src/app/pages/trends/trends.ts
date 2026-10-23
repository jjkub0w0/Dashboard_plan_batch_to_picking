import { Component, inject, signal, computed, OnInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { getApiUrl } from '../../config/api.config';
import { DateFilterService } from '../../services/date-filter.service';

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

interface ChartPoint {
  index: number;
  date: string;
  dayNumber: string;
  shortLabel: string;
  fullDateLabel: string;
  x: number;
  // ค่าตรงตาม plan (QTY)
  matchedY: number;
  matchedPct: number;
  matchedVal: number;
  // ค่าไม่ตรงตาม plan (QTY)
  mismatchedY: number;
  mismatchedPct: number;
  mismatchedVal: number;
  // ยอดรวมทั้งหมด (QTY)
  totalVal: number;
}

export interface MonthGroup {
  monthKey: string;      // '2026-08'
  monthLabel: string;    // 'สิงหาคม 2569'
  shortLabel: string;    // 'ส.ค. 69'
  displayLabel: string;  // based on width
  startX: number;
  endX: number;
  centerX: number;
  width: number;
  daysCount: number;
  points: ChartPoint[];
  isOdd: boolean;
}

/**
 * Numeric members of DailyTrendItem (everything except `date`).
 * Kept as an explicit list so a field added to the interface is normalised too,
 * instead of silently arriving as "" / null and poisoning the KPI sums.
 */
const DAILY_NUMBER_FIELDS: Exclude<keyof DailyTrendItem, 'date'>[] = [
  'totalQty', 'matchedQty', 'mismatchedQty', 'qtyMismatchedQty', 'pendingQty',
  'matchedPct', 'mismatchedPct', 'qtyMismatchedPct', 'pendingPct',
  'totalSOs', 'matchedSOs', 'mismatchedSOs', 'soMatchPct', 'soMismatchedPct',
  'totalLines', 'matchedLines', 'mismatchedLines', 'qtyMismatchedLines', 'pendingLines',
  'lineMatchPct', 'lineMismatchedPct',
];

/** Coerce anything JSON can carry into a number the chart maths can survive. */
function toFiniteNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

@Component({
  selector: 'app-trends',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './trends.html',
  styleUrls: ['./trends.scss']
})
export class TrendsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly dateService = inject(DateFilterService);

  readonly isLoading = signal<boolean>(true);
  readonly errorMsg = signal<string | null>(null);
  readonly trendsData = signal<TrendsSummary | null>(null);

  // ตัวเลือกช่วงเวลา: ทั้งหมด, 7 วันล่าสุด, 14 วันล่าสุด, 30 วันล่าสุด
  readonly rangeFilter = signal<'ALL' | '7' | '14' | '30'>('ALL');

  // จุดที่ Hover อยู่
  readonly hoveredIndex = signal<number | null>(null);
  readonly activeChartSection = signal<'matched' | 'mismatched' | null>(null);

  // คำค้นหาในตาราง
  readonly tableSearch = signal<string>('');

  // คอลัมน์ที่แสดงบนจอเล็ก (Responsive Columns)
  // ค่าเริ่มต้นแสดง ยอดรวม QTY และ % ตรง Plan
  readonly mobileCols = signal<{
    totalQty: boolean;
    matchedQty: boolean;
    mismatchedQty: boolean;
    matchedPct: boolean;
    mismatchedPct: boolean;
  }>({
    totalQty: true,
    matchedQty: false,
    mismatchedQty: false,
    matchedPct: true,
    mismatchedPct: false,
  });

  toggleMobileCol(col: 'totalQty' | 'matchedQty' | 'mismatchedQty' | 'matchedPct' | 'mismatchedPct'): void {
    this.mobileCols.update(cols => ({
      ...cols,
      [col]: !cols[col]
    }));
  }

  // State สำหรับ Modal รายละเอียดของวันนั้นเมื่อกดจุดไข่ปลา
  readonly selectedDailyDetail = signal<DailyTrendItem | null>(null);

  openDailyDetail(item: DailyTrendItem): void {
    this.selectedDailyDetail.set(item);
  }

  closeDailyDetail(): void {
    this.selectedDailyDetail.set(null);
  }

  @HostListener('document:keydown.escape')
  onEscapeHandler(): void {
    if (this.selectedDailyDetail()) {
      this.closeDailyDetail();
    }
  }

  // SVG Chart Canvas Dimensions
  readonly chartWidth = 920;
  readonly chartHeight = 330;
  readonly padding = { top: 28, right: 35, bottom: 58, left: 60 };

  get plotWidth(): number {
    return this.chartWidth - this.padding.left - this.padding.right;
  }

  get plotHeight(): number {
    return this.chartHeight - this.padding.top - this.padding.bottom;
  }

  readonly isAllRange = computed<boolean>(() => this.rangeFilter() === 'ALL');

  ngOnInit(): void {
    this.loadTrendsData();
  }

  loadTrendsData(force = false): void {
    this.isLoading.set(true);
    this.errorMsg.set(null);

    const url = getApiUrl('/trends', force ? { force: true } : undefined);
    this.http.get<{ success: boolean; data: TrendsSummary; error?: string }>(url).subscribe({
      next: (res) => {
        this.isLoading.set(false);
        // `res?.` because a 200 with an empty body (proxy timeout page, a 204 from
        // an upstream) delivers null here - reading res.success then threw inside
        // the subscriber and the user was left on an endless "loading" chart.
        if (res?.success && res?.data) {
          this.trendsData.set(this.sanitizeSummary(res.data));
        } else {
          this.errorMsg.set(res?.error || 'ไม่สามารถโหลดข้อมูลแนวโน้มได้');
        }
      },
      error: (err) => {
        this.isLoading.set(false);
        this.errorMsg.set(err?.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
      }
    });
  }

  /**
   * กรองข้อมูลรายวันตามช่วงเวลาที่เลือก
   */
  /**
   * Normalise the /api/trends payload before anything renders it.
   *
   * BUG-FIX 1 (NaN): every number here comes out of a snapshot JSON file written
   * by the pipeline. A hand-edited or half-written file can hold "" / null / NaN
   * (JSON.stringify turns NaN into null), and those used to reach the SVG maths
   * directly: Math.max(0, 'x') is NaN, so a single bad day made the whole polyline
   * and every KPI of the selected range render as "NaN" instead of that one day
   * simply reading as zero.
   *
   * BUG-FIX 2 (order): the "last 7/14/30 days" filter below uses slice(-N), which
   * silently means "the FIRST N days" if the service ever returns newest-first.
   * Sorting here is a no-op against the current backend (it already sorts old ->
   * new) and turns that into an enforced assumption instead of a silent trap.
   */
  private sanitizeSummary(data: TrendsSummary): TrendsSummary {
    const daily: DailyTrendItem[] = Array.isArray(data.daily) ? [...data.daily] : [];
    daily.sort((a, b) => String(a?.date ?? '').localeCompare(String(b?.date ?? '')));
    for (const item of daily) {
      for (const field of DAILY_NUMBER_FIELDS) {
        (item as any)[field] = toFiniteNumber((item as any)?.[field]);
      }
    }
    return { ...data, daily };
  }

  readonly filteredDaily = computed<DailyTrendItem[]>(() => {
    const data = this.trendsData();
    if (!data || !data.daily || data.daily.length === 0) return [];

    const list = [...data.daily];
    const range = this.rangeFilter();

    if (range === '7') {
      return list.slice(-7);
    } else if (range === '14') {
      return list.slice(-14);
    } else if (range === '30') {
      return list.slice(-30);
    }
    return list;
  });

  /**
   * คำนวณสรุป KPI ตามชุดข้อมูลที่ถูกกรอง
   */
  readonly summaryKpi = computed(() => {
    const list = this.filteredDaily();
    if (list.length === 0) {
      return {
        totalDays: 0,
        startDate: '-',
        endDate: '-',
        totalQty: 0,
        matchedQty: 0,
        mismatchedQty: 0,
        avgMatchedPct: 0,
        avgMismatchedPct: 0,
        bestDay: null as { date: string; matchedPct: number } | null,
        worstDay: null as { date: string; mismatchedPct: number } | null,
      };
    }

    let totalVal = 0;
    let totalMatched = 0;
    let totalMismatched = 0;
    let bestDay: { date: string; matchedPct: number } | null = null;
    let worstDay: { date: string; mismatchedPct: number } | null = null;

    for (const d of list) {
      totalVal += d.totalQty;
      totalMatched += d.matchedQty;
      totalMismatched += d.mismatchedQty;

      if (!bestDay || d.matchedPct > bestDay.matchedPct) {
        bestDay = { date: d.date, matchedPct: d.matchedPct };
      }
      if (!worstDay || d.mismatchedPct > worstDay.mismatchedPct) {
        worstDay = { date: d.date, mismatchedPct: d.mismatchedPct };
      }
    }

    const avgMatchedPct = totalVal > 0 ? Number(((totalMatched / totalVal) * 100).toFixed(1)) : 0;
    const avgMismatchedPct = totalVal > 0 ? Number(((totalMismatched / totalVal) * 100).toFixed(1)) : 0;

    return {
      totalDays: list.length,
      startDate: list[0].date,
      endDate: list[list.length - 1].date,
      totalQty: totalVal,
      matchedQty: totalMatched,
      mismatchedQty: totalMismatched,
      avgMatchedPct,
      avgMismatchedPct,
      bestDay,
      worstDay,
    };
  });

  /**
   * คำนวณพิกัดจุดบนกราฟ SVG (Points)
   */
  readonly chartPoints = computed<ChartPoint[]>(() => {
    const list = this.filteredDaily();
    if (list.length === 0) return [];

    const count = list.length;
    const pLeft = this.padding.left;
    const pTop = this.padding.top;
    const pW = this.plotWidth;
    const pH = this.plotHeight;

    // ระยะเว้นหัว-ท้ายเล็กน้อย (inset) เพื่อไม่ให้จุดขอบติดกับเส้นแบ่งหรือแกน Y เกินไป
    const inset = count > 1 ? 14 : 0;
    const usableW = pW - 2 * inset;

    return list.map((d, i) => {
      // แกน X เรียงจากวันที่มาก่อน (ซ้าย -> ขวา)
      const x = count === 1 ? pLeft + pW / 2 : pLeft + inset + (i / (count - 1)) * usableW;

      // แกน Y คือเปอร์เซ็นต์ (0% อยู่ล่าง, 100% อยู่บน)
      const matchedY = pTop + pH - (Math.min(100, Math.max(0, d.matchedPct)) / 100) * pH;
      const mismatchedY = pTop + pH - (Math.min(100, Math.max(0, d.mismatchedPct)) / 100) * pH;

      const dateParts = (d.date || '').split('-');
      const dayNum = dateParts[2] ? dateParts[2] : '';

      return {
        index: i,
        date: d.date,
        dayNumber: dayNum,
        shortLabel: this.formatDateShort(d.date),
        fullDateLabel: this.formatDateFull(d.date),
        x,
        matchedY,
        matchedPct: d.matchedPct,
        matchedVal: d.matchedQty,
        mismatchedY,
        mismatchedPct: d.mismatchedPct,
        mismatchedVal: d.mismatchedQty,
        totalVal: d.totalQty,
      };
    });
  });

  /**
   * จัดกลุ่มข้อมูลตามเดือน สำหรับสร้างเส้นแบ่งแนวตั้งและกรอบครอบแต่ละเดือน (เมื่อเลือก 'ทั้งหมด')
   */
  readonly monthGroups = computed<MonthGroup[]>(() => {
    const pts = this.chartPoints();
    if (pts.length === 0) return [];

    // รวมกลุ่มจุดตาม 'YYYY-MM'
    const groupsMap = new Map<string, ChartPoint[]>();
    for (const p of pts) {
      const monthKey = p.date.substring(0, 7);
      if (!groupsMap.has(monthKey)) {
        groupsMap.set(monthKey, []);
      }
      groupsMap.get(monthKey)!.push(p);
    }

    const groupKeys = Array.from(groupsMap.keys());
    const result: MonthGroup[] = [];
    const pLeft = this.padding.left;
    const pRight = this.chartWidth - this.padding.right;

    for (let i = 0; i < groupKeys.length; i++) {
      const key = groupKeys[i];
      const points = groupsMap.get(key)!;
      const isFirst = i === 0;
      const isLast = i === groupKeys.length - 1;

      // คำนวณขอบเขตซ้าย (startX)
      let startX: number;
      if (isFirst) {
        startX = pLeft;
      } else {
        const prevGroup = groupsMap.get(groupKeys[i - 1])!;
        const prevLastPoint = prevGroup[prevGroup.length - 1];
        const currentFirstPoint = points[0];
        startX = Number(((prevLastPoint.x + currentFirstPoint.x) / 2).toFixed(1));
      }

      // คำนวณขอบเขตขวา (endX)
      let endX: number;
      if (isLast) {
        endX = pRight;
      } else {
        const nextGroup = groupsMap.get(groupKeys[i + 1])!;
        const currentLastPoint = points[points.length - 1];
        const nextFirstPoint = nextGroup[0];
        endX = Number(((currentLastPoint.x + nextFirstPoint.x) / 2).toFixed(1));
      }

      const width = Number((endX - startX).toFixed(1));
      const centerX = Number(((startX + endX) / 2).toFixed(1));
      const monthLabel = this.formatMonthFull(key);
      const shortLabel = this.formatMonthShort(key);

      // เลือกข้อความแสดงผลตามความกว้างของพื้นที่เดือน
      let displayLabel: string;
      if (width < 50) {
        displayLabel = shortLabel; // เช่น 'ส.ค. 69'
      } else if (width < 140) {
        displayLabel = monthLabel; // เช่น 'สิงหาคม 2569'
      } else {
        displayLabel = `${monthLabel} (${points.length} วัน)`; // เช่น 'กันยายน 2569 (18 วัน)'
      }

      result.push({
        monthKey: key,
        monthLabel,
        shortLabel,
        displayLabel,
        startX,
        endX,
        centerX,
        width,
        daysCount: points.length,
        points,
        isOdd: i % 2 === 1,
      });
    }

    return result;
  });

  /**
   * SVG Path สำหรับเส้นตรงตาม Plan (เขียว)
   */
  readonly matchedLinePath = computed<string>(() => {
    const pts = this.chartPoints();
    if (pts.length === 0) return '';
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.matchedY.toFixed(1)}`).join(' ');
  });

  /**
   * SVG Area Path สำหรับพื้นที่ใต้กราฟตรงตาม Plan
   */
  readonly matchedAreaPath = computed<string>(() => {
    const pts = this.chartPoints();
    if (pts.length === 0) return '';
    const baseY = (this.padding.top + this.plotHeight).toFixed(1);
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.matchedY.toFixed(1)}`).join(' ');
    const firstX = pts[0].x.toFixed(1);
    const lastX = pts[pts.length - 1].x.toFixed(1);
    return `${line} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;
  });

  /**
   * SVG Path สำหรับเส้นไม่ตรงตาม Plan (แดง/ชมพูเข้ม)
   */
  readonly mismatchedLinePath = computed<string>(() => {
    const pts = this.chartPoints();
    if (pts.length === 0) return '';
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.mismatchedY.toFixed(1)}`).join(' ');
  });

  /**
   * SVG Area Path สำหรับพื้นที่ใต้กราฟไม่ตรงตาม Plan
   */
  readonly mismatchedAreaPath = computed<string>(() => {
    const pts = this.chartPoints();
    if (pts.length === 0) return '';
    const baseY = (this.padding.top + this.plotHeight).toFixed(1);
    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.mismatchedY.toFixed(1)}`).join(' ');
    const firstX = pts[0].x.toFixed(1);
    const lastX = pts[pts.length - 1].x.toFixed(1);
    return `${line} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;
  });

  /**
   * พิกัด Y ของเส้นค่าเฉลี่ย
   */
  readonly avgMatchedY = computed<number>(() => {
    const avg = this.summaryKpi().avgMatchedPct;
    return this.padding.top + this.plotHeight - (avg / 100) * this.plotHeight;
  });

  readonly avgMismatchedY = computed<number>(() => {
    const avg = this.summaryKpi().avgMismatchedPct;
    return this.padding.top + this.plotHeight - (avg / 100) * this.plotHeight;
  });

  /**
   * เส้นตารางแนวนอนแกน Y (0%, 25%, 50%, 75%, 100%)
   */
  readonly yGridTicks = computed(() => {
    const ticks = [0, 25, 50, 75, 100];
    const pH = this.plotHeight;
    const pTop = this.padding.top;
    return ticks.map(pct => ({
      pct,
      y: pTop + pH - (pct / 100) * pH,
    }));
  });

  /**
   * ข้อมูลจุดที่กำลัง Hover สำหรับแสดง Tooltip
   */
  readonly activeTooltipPoint = computed<ChartPoint | null>(() => {
    const idx = this.hoveredIndex();
    if (idx === null) return null;
    const pts = this.chartPoints();
    return pts[idx] || null;
  });

  /**
   * คำนวณตำแหน่ง X ของ Tooltip เป็นเปอร์เซ็นต์ เพื่อให้ตรงกับจุดบนกราฟทุกขนาดหน้าจอ
   */
  readonly tooltipLeftPct = computed<number>(() => {
    const pt = this.activeTooltipPoint();
    if (!pt) return 0;
    return Number(((pt.x / this.chartWidth) * 100).toFixed(2));
  });

  /**
   * ตรวจสอบว่าจุดอยู่ใกล้ขอบขวาของกราฟหรือไม่ (ถ้าเกิน 65% ให้จัดชิดขวาเพื่อไม่ให้ Tooltip ล้นจอ)
   */
  readonly isNearRightEdge = computed<boolean>(() => {
    return this.tooltipLeftPct() > 65;
  });

  /**
   * ตรวจสอบว่าจุดอยู่ใกล้ขอบซ้ายของกราฟหรือไม่ (ถ้าน้อยกว่า 30% ให้จัดชิดซ้ายเพื่อไม่ให้ Tooltip ล้นจอ)
   */
  readonly isNearLeftEdge = computed<boolean>(() => {
    return this.tooltipLeftPct() < 30;
  });

  /**
   * ลำดับการเรียงข้อมูลในตารางรายวัน (ค่าเริ่มต้น: desc = วันที่ล่าสุดอยู่บนสุด)
   */
  readonly tableSortOrder = signal<'desc' | 'asc'>('desc');

  toggleTableSort(): void {
    this.tableSortOrder.update(order => order === 'desc' ? 'asc' : 'desc');
  }

  /**
   * ตารางข้อมูลรายวัน พร้อมฟังก์ชันค้นหา (เรียงวันที่ล่าสุดขึ้นก่อนตามค่าเริ่มต้น)
   */
  readonly filteredTableData = computed<DailyTrendItem[]>(() => {
    let list = [...this.filteredDaily()];
    if (this.tableSortOrder() === 'desc') {
      list.reverse();
    }
    const q = this.tableSearch().trim().toLowerCase();
    if (!q) return list;
    return list.filter(d => d.date.includes(q) || this.formatDateFull(d.date).toLowerCase().includes(q));
  });

  // Action: คลิกเลือกวันเพื่อกระโดดไปดู Dashboard วันนั้น
  navigateToDate(dateStr: string): void {
    if (!dateStr) return;
    const d = new Date(`${dateStr}T00:00:00`);
    this.dateService.setDate(d);
    this.router.navigate(['/']);
  }

  onPointHover(index: number | null, section: 'matched' | 'mismatched' | null): void {
    this.hoveredIndex.set(index);
    this.activeChartSection.set(section);
  }

  // Format Helper
  formatDateShort(dateStr: string): string {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      return `${parseInt(parts[2], 10)}/${parseInt(parts[1], 10)}`;
    }
    return dateStr;
  }

  formatDateFull(dateStr: string): string {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10) + 543;
      const monthIdx = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      // BUG-FIX: the backend only checks the file NAME against a digit regex, so a
      // stray 2026-13-01.json used to land here and render "undefined" as the month.
      if (monthIdx < 0 || monthIdx > 11 || Number.isNaN(day)) return dateStr;
      const thaiMonths = [
        'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
        'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
      ];
      return `${day} ${thaiMonths[monthIdx]} ${year}`;
    }
    return dateStr;
  }

  getMonthBracketPath(mg: MonthGroup): string {
    const yTop = this.padding.top + this.plotHeight + 17;
    const yBottom = this.padding.top + this.plotHeight + 25;
    return `M ${mg.startX} ${yTop} L ${mg.startX} ${yBottom} L ${mg.endX} ${yBottom} L ${mg.endX} ${yTop}`;
  }

  formatMonthFull(monthKey: string): string {
    if (!monthKey) return '';
    const parts = monthKey.split('-');
    if (parts.length >= 2) {
      const year = parseInt(parts[0], 10) + 543;
      const monthIdx = parseInt(parts[1], 10) - 1;
      const fullMonths = [
        'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
        'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
      ];
      if (monthIdx >= 0 && monthIdx <= 11) {
        return `${fullMonths[monthIdx]} ${year}`;
      }
    }
    return monthKey;
  }

  formatMonthShort(monthKey: string): string {
    if (!monthKey) return '';
    const parts = monthKey.split('-');
    if (parts.length >= 2) {
      const year = (parseInt(parts[0], 10) + 543).toString().slice(-2);
      const monthIdx = parseInt(parts[1], 10) - 1;
      const shortMonths = [
        'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
        'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
      ];
      if (monthIdx >= 0 && monthIdx <= 11) {
        return `${shortMonths[monthIdx]} ${year}`;
      }
    }
    return monthKey;
  }

  getUnitLabel(): string {
    return 'ลัง';
  }
}
