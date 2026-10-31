import { Component, inject, signal, computed, effect, OnInit, DestroyRef, HostListener } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { DateFilterService } from '../../services/date-filter.service';
import { getApiUrl } from '../../config/api.config';

export interface SkuPlanBatch {
  batch: string;
  qty?: string | number;
  unit?: string;
  isNoPlan: boolean;
  match: boolean;
  qtyMatch?: boolean;
}

export interface SkuSapBatch {
  batch: string;
  qty?: string | number;
  unit?: string;
  match: boolean;
  qtyMatch?: boolean;
}

export interface SkuBatchItem {
  so: string;
  do: string;
  route: string;
  customer: string;
  orderType: 'SO' | 'POSTO';
  material: string;
  item?: string;
  skuDescription: string;
  deliveryQuantityUnit: string;
  planBatches: SkuPlanBatch[];
  sapBatches: SkuSapBatch[];
  qty: number;
  match: boolean;
  status: 'MATCH' | 'QTY_MISMATCH' | 'MISMATCH' | 'PENDING';
  statusText: string;
  searchStr: string;
}

export interface DoGroupItem {
  doNumber: string;
  route: string;
  customer: string;
  skus: SkuBatchItem[];
  totalQty: number;
  totalQtyCAR: number;
  totalQtyPAC: number;
  totalLines: number;
  matchedLines: number;
  qtyMismatchedLines: number;
  mismatchedLines: number;
  pendingLines: number;
  matchRate: number;
}

export interface SoGroupItem {
  soNumber: string;
  orderType: 'SO' | 'POSTO';
  route: string;
  customer: string;
  dos: DoGroupItem[];
  totalDos: number;
  totalLines: number;
  totalQty: number;
  totalQtyCAR: number;
  totalQtyPAC: number;
  matchedLines: number;
  qtyMismatchedLines: number;
  mismatchedLines: number;
  pendingLines: number;
  matchRate: number;
}

export interface SoBatchDetailItem {
  so: string;
  do: string;
  route: string;
  customer: string;
  material: string;
  skuDescription: string;
  firstBatch: Array<{ Batch: string; QTY: string | number }>;
  firstBatchStr: string;
  batchPlan: string;
  sapBatch: string;
  qty: number;
  deliveryQuantityUnit?: string;
  match: boolean;
  batchStatus?: 'MATCH' | 'QTY_MISMATCH' | 'MISMATCH' | 'PENDING';
  status: 'COMPLETED' | 'IN_PROGRESS' | 'PLANNED';
  item?: string;
}

@Component({
  selector: 'app-so-batches',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './so-batches.html',
  styleUrl: './so-batches.scss',
})
export class SoBatchesComponent implements OnInit {
  readonly dateService = inject(DateFilterService);
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly isLoading = signal<boolean>(false);
  readonly isExporting = signal<boolean>(false);
  readonly isFromCache = signal<boolean>(false);
  readonly syncStatus = signal<any>(null);

  // Filters
  readonly selectedSoFilter = signal<string>('ALL');
  readonly batchSearchQuery = signal<string>('');
  readonly batchMatchFilter = signal<'ALL' | 'MATCH' | 'QTY_MISMATCH' | 'MISMATCH'>('ALL');

  // Column visibility for mobile / tablet (< 900px)
  readonly mobileCols = signal<{
    desc: boolean;
    plan: boolean;
    sap: boolean;
    qty: boolean;
    status: boolean;
  }>({
    desc: false,
    plan: false,
    sap: false,
    qty: true,
    status: true,
  });

  toggleMobileCol(col: 'desc' | 'plan' | 'sap' | 'qty' | 'status') {
    this.mobileCols.update(cols => ({
      ...cols,
      [col]: !cols[col]
    }));
  }

  // Modal Detail State (for mobile/tablet ellipsis view)
  readonly selectedSkuDetail = signal<{
    sku: SkuBatchItem;
    soNumber: string;
    doNumber: string;
    customer?: string;
  } | null>(null);

  openSkuDetail(sku: SkuBatchItem, soNumber: string, doNumber: string, customer?: string) {
    this.selectedSkuDetail.set({ sku, soNumber, doNumber, customer });
  }

  closeSkuDetail() {
    this.selectedSkuDetail.set(null);
  }

  @HostListener('document:keydown.escape')
  onEscapeHandler() {
    if (this.selectedSkuDetail()) {
      this.closeSkuDetail();
    }
  }

  // Raw list of SO batch details
  readonly soBatchDetails = signal<SoBatchDetailItem[]>([]);
  private currentDataDate: string | null = null;

  // Group raw items into 1 row per SKU per DO
  readonly groupedSkuItems = computed<SkuBatchItem[]>(() => {
    const rawList = this.soBatchDetails();
    const doSkuMap = new Map<string, {
      so: string;
      do: string;
      route: string;
      customer: string;
      orderType: 'SO' | 'POSTO';
      material: string;
      item: string;
      skuDescription: string;
      deliveryQuantityUnit: string;
      items: SoBatchDetailItem[];
    }>();

    for (const it of rawList) {
      const so = it.so || 'UNKNOWN_SO';
      const doNum = it.do || 'UNKNOWN_DO';
      const mat = it.material || 'UNKNOWN_MAT';
      const itemNum = it.item || '';
      const key = `${doNum}|${mat}|${itemNum}`;

      if (!doSkuMap.has(key)) {
        const orderType = (so.startsWith('42') || doNum.startsWith('80')) ? 'POSTO' : 'SO';
        doSkuMap.set(key, {
          so,
          do: doNum,
          route: it.route || '',
          customer: it.customer || '',
          orderType,
          material: mat,
          item: itemNum,
          skuDescription: it.skuDescription || '',
          deliveryQuantityUnit: (it.deliveryQuantityUnit || 'CAR').toUpperCase(),
          items: [],
        });
      }
      doSkuMap.get(key)!.items.push(it);
    }

    const result: SkuBatchItem[] = [];

    for (const group of doSkuMap.values()) {
      // 1. Plan batches
      const planBatchMap = new Map<string, { batch: string; qty: number; unit: string }>();
      let hasExplicitNoPlan = false;
      let noPlanQty = 0;
      const seenPlanKeys = new Set<string>();

      for (const it of group.items) {
        const fbs = Array.isArray(it.firstBatch) ? it.firstBatch : [];
        if (fbs.length > 0) {
          // หากเป็นรายการจาก ITEM เดียวกัน หรือ firstBatch ซ้ำกันในกลุ่มเดียวกัน ให้ประมวลผลเพียงครั้งเดียว
          const planKey = it.item ? `${it.item}` : JSON.stringify(fbs);
          if (seenPlanKeys.has(planKey)) {
            continue;
          }
          seenPlanKeys.add(planKey);

          for (const fb of fbs) {
            const b = (fb.Batch || '').trim();
            const q = Number(fb.QTY) || 0;
            if (!b || b === 'ไม่ได้ plant ไว้ ' || b === 'ไม่ได้ plant ไว้') {
              hasExplicitNoPlan = true;
              noPlanQty += q;
            } else {
              if (!planBatchMap.has(b)) {
                planBatchMap.set(b, {
                  batch: b,
                  qty: q,
                  unit: group.deliveryQuantityUnit === 'PAC' ? 'แพ็ค' : 'ลัง',
                });
              } else {
                planBatchMap.get(b)!.qty += q;
              }
            }
          }
        } else if (it.batchPlan && it.batchPlan.trim()) {
          const b = it.batchPlan.trim();
          const q = Number(it.qty) || 0;
          if (!b || b === 'ไม่ได้ plant ไว้ ' || b === 'ไม่ได้ plant ไว้') {
            hasExplicitNoPlan = true;
            noPlanQty += q;
          } else {
            if (!planBatchMap.has(b)) {
              planBatchMap.set(b, {
                batch: b,
                qty: q,
                unit: group.deliveryQuantityUnit === 'PAC' ? 'แพ็ค' : 'ลัง',
              });
            } else {
              planBatchMap.get(b)!.qty += q;
            }
          }
        }
      }

      // 2. SAP batches
      const sapBatchMap = new Map<string, { batch: string; qty: number; unit: string }>();
      for (const it of group.items) {
        const sb = (it.sapBatch || '').trim();
        if (sb) {
          const q = Number(it.qty) || 0;
          if (!sapBatchMap.has(sb)) {
            sapBatchMap.set(sb, {
              batch: sb,
              qty: q,
              unit: group.deliveryQuantityUnit,
            });
          } else {
            sapBatchMap.get(sb)!.qty += q;
          }
        }
      }

      const sapBatchesList = Array.from(sapBatchMap.values());
      const hasPlannedBatches = planBatchMap.size > 0;
      const isAllNoPlan = !hasPlannedBatches && hasExplicitNoPlan;
      const totalSapQty = sapBatchesList.reduce((sum, sb) => sum + sb.qty, 0);
      const isNoPlanQtyMatch = isAllNoPlan ? (noPlanQty <= 0 || noPlanQty === totalSapQty) : true;

      // 3. Plan batches array & match calculation:
      const planBatches: SkuPlanBatch[] = [];
      if (hasExplicitNoPlan) {
        planBatches.push({
          batch: 'ไม่ได้ plant ไว้ ',
          qty: noPlanQty > 0 ? noPlanQty : '',
          unit: group.deliveryQuantityUnit === 'PAC' ? 'แพ็ค' : 'ลัง',
          isNoPlan: true,
          match: true,
          qtyMatch: isNoPlanQtyMatch,
        });
      }
      for (const pb of planBatchMap.values()) {
        const sapEntry = sapBatchMap.get(pb.batch);
        const isMatched = isAllNoPlan ? true : Boolean(sapEntry);
        const isQtyMatched = isAllNoPlan ? true : (isMatched && Number(sapEntry?.qty) === Number(pb.qty));
        planBatches.push({
          batch: pb.batch,
          qty: pb.qty > 0 ? pb.qty : '',
          unit: pb.unit,
          isNoPlan: false,
          match: isMatched,
          qtyMatch: isQtyMatched,
        });
      }

      // 4. SAP batches array & match calculation
      const sapBatches: SkuSapBatch[] = sapBatchesList.map(sb => {
        const planEntry = planBatchMap.get(sb.batch);
        const isMatched = isAllNoPlan ? true : Boolean(planEntry);
        const isQtyMatched = isAllNoPlan ? isNoPlanQtyMatch : (isMatched && Number(planEntry?.qty) === Number(sb.qty));
        return {
          batch: sb.batch,
          qty: sb.qty,
          unit: sb.unit,
          match: isMatched,
          qtyMatch: isQtyMatched,
        };
      });

      // 5. Overall match & status determination
      const realPlanBatches = planBatches.filter(pb => !pb.isNoPlan);
      let status: 'MATCH' | 'QTY_MISMATCH' | 'MISMATCH' | 'PENDING' = 'MATCH';
      let statusText = 'ตรงตามแนะนำ';
      let isOverallMatch = true;

      if (sapBatches.length === 0) {
        status = 'PENDING';
        statusText = 'รอข้อมูล SAP';
        isOverallMatch = false;
      } else if (isAllNoPlan) {
        if (isNoPlanQtyMatch) {
          status = 'MATCH';
          statusText = 'ตรงตามแนะนำ';
          isOverallMatch = true;
        } else {
          status = 'QTY_MISMATCH';
          statusText = 'ตรงตามแนะนำแต่จำนวนไม่ตรง';
          isOverallMatch = false;
        }
      } else {
        const allPlanInSap = realPlanBatches.length > 0 && realPlanBatches.every(pb => pb.match);
        const allSapInPlan = sapBatches.length > 0 && sapBatches.every(sb => sb.match);
        const isBatchCodeMatch = allPlanInSap && allSapInPlan;

        if (!isBatchCodeMatch) {
          status = 'MISMATCH';
          statusText = 'เปลี่ยนล็อต';
          isOverallMatch = false;
        } else {
          const totalPlanQty = (hasExplicitNoPlan ? noPlanQty : 0) + Array.from(planBatchMap.values()).reduce((sum, pb) => sum + pb.qty, 0);
          const isTotalQtyMatch = totalPlanQty > 0 ? totalPlanQty === totalSapQty : true;

          // เคสพิเศษ: มี plan batch > 1 และมี plan batch == null อย่างน้อย 1 ตัว
          // โดย batch ที่ดึงมาจาก fiori ตรงกับตัวอื่นในนั้นจนครบ และ qty ของแต่ละ batch ไม่น้อยกว่าที่ First batch กำหนด
          const isSpecialNoPlanQtyMatch = hasExplicitNoPlan &&
            planBatches.length > 1 &&
            realPlanBatches.length > 0 &&
            isBatchCodeMatch &&
            isTotalQtyMatch &&
            realPlanBatches.every(pb => {
              const sapEntry = sapBatchMap.get(pb.batch);
              return sapEntry && Number(sapEntry.qty) >= Number(pb.qty);
            });

          const isAllQtyMatch = realPlanBatches.every(pb => pb.qtyMatch);
          if (isAllQtyMatch || isSpecialNoPlanQtyMatch) {
            status = 'MATCH';
            statusText = 'ตรงตามแนะนำ';
            isOverallMatch = true;
            if (isSpecialNoPlanQtyMatch) {
              planBatches.forEach(pb => { pb.qtyMatch = true; });
              sapBatches.forEach(sb => { sb.qtyMatch = true; });
            }
          } else {
            status = 'QTY_MISMATCH';
            statusText = 'ตรงตามแนะนำแต่จำนวนไม่ตรง';
            isOverallMatch = false;
          }
        }
      }

      // 6. SKU quantity: ผลรวมของทุกรายการในกลุ่ม SKU นี้ (ซึ่งอิงตาม FirstBatch.QTY แต่ละแถว)
      const totalSkuQty = group.items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);

      const planBatchesStr = planBatches.map(pb => pb.batch).join(' ');
      const sapBatchesStr = sapBatches.map(sb => sb.batch).join(' ');
      const itemTag = group.item ? `item ${group.item} ${group.item}` : '';
      const searchStr = `${group.so} ${group.do} ${group.route} ${group.customer} ${group.material} ${itemTag} ${group.skuDescription} ${planBatchesStr} ${sapBatchesStr} ${statusText}`.toLowerCase();

      result.push({
        so: group.so,
        do: group.do,
        route: group.route,
        customer: group.customer,
        orderType: group.orderType,
        material: group.material,
        item: group.item,
        skuDescription: group.skuDescription,
        deliveryQuantityUnit: group.deliveryQuantityUnit,
        planBatches,
        sapBatches,
        qty: totalSkuQty,
        match: isOverallMatch,
        status,
        statusText,
        searchStr,
      });
    }

    return result;
  });

  // Unique SO list for dropdown
  readonly uniqueSoList = computed(() => {
    const list = this.groupedSkuItems();
    const map = new Map<string, { so: string; doCount: number; qty: number; matchedLines: number; totalLines: number; route: string; customer: string; dos: Set<string> }>();

    for (const item of list) {
      const so = item.so || 'UNKNOWN';
      if (!map.has(so)) {
        map.set(so, {
          so,
          doCount: 0,
          qty: 0,
          matchedLines: 0,
          totalLines: 0,
          route: item.route,
          customer: item.customer,
          dos: new Set<string>(),
        });
      }
      const entry = map.get(so)!;
      entry.qty += item.qty;
      entry.totalLines += 1;
      if (item.status === 'MATCH') entry.matchedLines += 1;
      entry.dos.add(item.do);
    }

    return Array.from(map.values()).map(e => ({
      so: e.so,
      doCount: e.dos.size,
      qty: e.qty,
      route: e.route,
      customer: e.customer,
      matchRate: e.totalLines > 0 ? Math.round((e.matchedLines / e.totalLines) * 100) : 0,
    }));
  });

  // Filtered grouped SKU list
  readonly filteredSkuItems = computed(() => {
    let list = this.groupedSkuItems();
    const soFilter = this.selectedSoFilter();
    const matchFilter = this.batchMatchFilter();
    const query = this.batchSearchQuery().trim().toLowerCase();

    if (soFilter !== 'ALL') {
      list = list.filter(item => item.so === soFilter);
    }

    if (matchFilter === 'MATCH') {
      list = list.filter(item => item.status === 'MATCH');
    } else if (matchFilter === 'QTY_MISMATCH') {
      list = list.filter(item => item.status === 'QTY_MISMATCH');
    } else if (matchFilter === 'MISMATCH') {
      list = list.filter(item => item.status === 'MISMATCH');
    }

    if (query) {
      list = list.filter(item => item.searchStr.includes(query));
    }

    return list;
  });

  readonly matchStatusCounts = computed(() => {
    let list = this.groupedSkuItems();
    const soFilter = this.selectedSoFilter();
    const query = this.batchSearchQuery().trim().toLowerCase();

    if (soFilter !== 'ALL') {
      list = list.filter(item => item.so === soFilter);
    }
    if (query) {
      list = list.filter(item => item.searchStr.includes(query));
    }

    let match = 0;
    let qtyMismatch = 0;
    let mismatch = 0;
    let pending = 0;
    for (const it of list) {
      if (it.status === 'MATCH') match++;
      else if (it.status === 'QTY_MISMATCH') qtyMismatch++;
      else if (it.status === 'MISMATCH') mismatch++;
      else if (it.status === 'PENDING') pending++;
    }
    return {
      all: list.length,
      match,
      qtyMismatch,
      mismatch,
      pending,
    };
  });

  // Summary stats for currently filtered view
  readonly containerStats = computed(() => {
    const list = this.filteredSkuItems();
    const totalLines = list.length;
    const matched = list.filter(x => x.status === 'MATCH').length;
    const qtyMismatched = list.filter(x => x.status === 'QTY_MISMATCH').length;
    const mismatched = list.filter(x => x.status === 'MISMATCH').length;
    const pending = list.filter(x => x.status === 'PENDING').length;
    const totalQty = list.reduce((sum, x) => sum + x.qty, 0);
    const totalQtyCAR = list.filter(x => x.deliveryQuantityUnit === 'CAR').reduce((sum, x) => sum + x.qty, 0);
    const totalQtyPAC = list.filter(x => x.deliveryQuantityUnit === 'PAC').reduce((sum, x) => sum + x.qty, 0);
    const matchedQty = list.filter(x => x.status === 'MATCH').reduce((sum, x) => sum + x.qty, 0);
    const matchedQtyCAR = list.filter(x => x.status === 'MATCH' && x.deliveryQuantityUnit === 'CAR').reduce((sum, x) => sum + x.qty, 0);
    const matchedQtyPAC = list.filter(x => x.status === 'MATCH' && x.deliveryQuantityUnit === 'PAC').reduce((sum, x) => sum + x.qty, 0);
    const qtyMismatchedQty = list.filter(x => x.status === 'QTY_MISMATCH').reduce((sum, x) => sum + x.qty, 0);
    const qtyMismatchedQtyCAR = list.filter(x => x.status === 'QTY_MISMATCH' && x.deliveryQuantityUnit === 'CAR').reduce((sum, x) => sum + x.qty, 0);
    const qtyMismatchedQtyPAC = list.filter(x => x.status === 'QTY_MISMATCH' && x.deliveryQuantityUnit === 'PAC').reduce((sum, x) => sum + x.qty, 0);
    const mismatchedQty = list.filter(x => x.status === 'MISMATCH').reduce((sum, x) => sum + x.qty, 0);
    const mismatchedQtyCAR = list.filter(x => x.status === 'MISMATCH' && x.deliveryQuantityUnit === 'CAR').reduce((sum, x) => sum + x.qty, 0);
    const mismatchedQtyPAC = list.filter(x => x.status === 'MISMATCH' && x.deliveryQuantityUnit === 'PAC').reduce((sum, x) => sum + x.qty, 0);
    const pendingQty = list.filter(x => x.status === 'PENDING').reduce((sum, x) => sum + x.qty, 0);
    const pendingQtyCAR = list.filter(x => x.status === 'PENDING' && x.deliveryQuantityUnit === 'CAR').reduce((sum, x) => sum + x.qty, 0);
    const pendingQtyPAC = list.filter(x => x.status === 'PENDING' && x.deliveryQuantityUnit === 'PAC').reduce((sum, x) => sum + x.qty, 0);
    const matchPct = totalLines > 0 ? Math.round((matched / totalLines) * 100) : 0;

    return {
      totalLines,
      matched,
      qtyMismatched,
      mismatched,
      pending,
      totalQty,
      totalQtyCAR,
      totalQtyPAC,
      matchedQty,
      matchedQtyCAR,
      matchedQtyPAC,
      qtyMismatchedQty,
      qtyMismatchedQtyCAR,
      qtyMismatchedQtyPAC,
      mismatchedQty,
      mismatchedQtyCAR,
      mismatchedQtyPAC,
      pendingQty,
      pendingQtyCAR,
      pendingQtyPAC,
      matchPct,
    };
  });

  // Grouped hierarchy: SO -> DO -> SKU
  readonly groupedSoDoHierarchy = computed<SoGroupItem[]>(() => {
    const skuItems = this.filteredSkuItems();
    const soMap = new Map<string, {
      soNumber: string;
      orderType: 'SO' | 'POSTO';
      route: string;
      customer: string;
      doMap: Map<string, {
        doNumber: string;
        route: string;
        customer: string;
        skus: SkuBatchItem[];
      }>;
    }>();

    for (const item of skuItems) {
      const so = item.so || 'UNKNOWN_SO';
      const doNum = item.do || 'UNKNOWN_DO';

      if (!soMap.has(so)) {
        soMap.set(so, {
          soNumber: so,
          orderType: item.orderType,
          route: item.route,
          customer: item.customer,
          doMap: new Map(),
        });
      }

      const soEntry = soMap.get(so)!;
      if (!soEntry.doMap.has(doNum)) {
        soEntry.doMap.set(doNum, {
          doNumber: doNum,
          route: item.route,
          customer: item.customer,
          skus: [],
        });
      }

      const doEntry = soEntry.doMap.get(doNum)!;
      doEntry.skus.push(item);
    }

    return Array.from(soMap.values()).map(so => {
      const dos = Array.from(so.doMap.values()).map(d => {
        const totalQty = d.skus.reduce((sum, s) => sum + s.qty, 0);
        const totalQtyCAR = d.skus.filter(s => s.deliveryQuantityUnit === 'CAR').reduce((sum, s) => sum + s.qty, 0);
        const totalQtyPAC = d.skus.filter(s => s.deliveryQuantityUnit === 'PAC').reduce((sum, s) => sum + s.qty, 0);
        const totalLines = d.skus.length;
        const matchedLines = d.skus.filter(s => s.status === 'MATCH').length;
        const qtyMismatchedLines = d.skus.filter(s => s.status === 'QTY_MISMATCH').length;
        const mismatchedLines = d.skus.filter(s => s.status === 'MISMATCH').length;
        const pendingLines = d.skus.filter(s => s.status === 'PENDING').length;
        const matchRate = totalLines > 0 ? Math.round((matchedLines / totalLines) * 100) : 0;
        return {
          doNumber: d.doNumber,
          route: d.route,
          customer: d.customer,
          skus: d.skus,
          totalQty,
          totalQtyCAR,
          totalQtyPAC,
          totalLines,
          matchedLines,
          qtyMismatchedLines,
          mismatchedLines,
          pendingLines,
          matchRate,
        };
      });

      const totalQty = dos.reduce((sum, d) => sum + d.totalQty, 0);
      const totalQtyCAR = dos.reduce((sum, d) => sum + d.totalQtyCAR, 0);
      const totalQtyPAC = dos.reduce((sum, d) => sum + d.totalQtyPAC, 0);
      const totalLines = dos.reduce((sum, d) => sum + d.totalLines, 0);
      const matchedLines = dos.reduce((sum, d) => sum + d.matchedLines, 0);
      const qtyMismatchedLines = dos.reduce((sum, d) => sum + d.qtyMismatchedLines, 0);
      const mismatchedLines = dos.reduce((sum, d) => sum + d.mismatchedLines, 0);
      const pendingLines = dos.reduce((sum, d) => sum + d.pendingLines, 0);
      const matchRate = totalLines > 0 ? Math.round((matchedLines / totalLines) * 100) : 0;

      return {
        soNumber: so.soNumber,
        orderType: so.orderType,
        route: so.route,
        customer: so.customer,
        dos,
        totalDos: dos.length,
        totalLines,
        totalQty,
        totalQtyCAR,
        totalQtyPAC,
        matchedLines,
        qtyMismatchedLines,
        mismatchedLines,
        pendingLines,
        matchRate,
      };
    });
  });

  constructor() {
    effect(() => {
      const selectedIso = this.dateService.isoDate();
      const trigger = this.dateService.refreshTrigger();
      if (selectedIso) {
        this.fetchDataForDate(selectedIso);
      }
    });
  }

  ngOnInit(): void {
    // BUG-FIX (leak): the subscription had no teardown. Navigating to this page
    // again and again left every previous component instance subscribed to the
    // shared queryParamMap forever - each still writing into its own signals and
    // holding its full item list (thousands of rows) alive. takeUntilDestroyed
    // completes the stream when this instance is destroyed.
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(params => {
        const soParam = params.get('so');
        if (soParam) {
          this.selectedSoFilter.set(soParam);
        }
      });
  }

  fetchDataForDate(dateStr: string): void {
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr.trim();
    this.isLoading.set(true);

    // หากเปลี่ยนวันที่: ล้างรายการแสดงผลเดิมออกทันที ไม่ให้ค้างข้อมูลของวันก่อนหน้า
    if (this.currentDataDate !== cleanDate) {
      this.soBatchDetails.set([]);
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

        if (res && res.dashboard) {
          let items: SoBatchDetailItem[] = [];
          if (Array.isArray(res.dashboard.soBatchDetails)) {
            items = res.dashboard.soBatchDetails;
          } else if (Array.isArray(res.dashboard.batches)) {
            items = res.dashboard.batches.flatMap((b: any) => b.batchDetails || []);
          }
          this.soBatchDetails.set(items);

          // หาก SO Filter เดิมที่เลือกไว้ไม่อยู่ในข้อมูลของวันที่เลือก ให้รีเซ็ตกลับเป็น ALL
          const curFilter = this.selectedSoFilter();
          if (curFilter !== 'ALL' && !items.some(it => it.so === curFilter)) {
            this.selectedSoFilter.set('ALL');
          }
        } else {
          this.soBatchDetails.set([]);
        }
      },
      error: (err) => {
        const currentSelected = this.dateService.isoDate();
        if (currentSelected && currentSelected !== cleanDate) return;

        this.isLoading.set(false);
        this.currentDataDate = cleanDate;
        this.soBatchDetails.set([]);
        this.syncStatus.set(null);
        this.isFromCache.set(false);
        console.error(`[ERROR] [SoBatches] Error fetching data for date "${cleanDate}":`, err);
      },
    });
  }

  onSoFilterChange(event: Event): void {
    const val = (event.target as HTMLSelectElement).value;
    this.selectedSoFilter.set(val);
  }

  onSearchChange(event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    this.batchSearchQuery.set(val);
  }

  setMatchFilter(filter: 'ALL' | 'MATCH' | 'QTY_MISMATCH' | 'MISMATCH'): void {
    this.batchMatchFilter.set(filter);
  }

  resetBatchFilters(): void {
    this.selectedSoFilter.set('ALL');
    this.batchSearchQuery.set('');
    this.batchMatchFilter.set('ALL');
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
        console.error('[ERROR] [SoBatches] Export Excel error:', err);
        alert('เกิดข้อผิดพลาดในการดาวน์โหลดรายงาน Excel กรุณาลองใหม่อีกครั้ง');
      },
    });
  }
}

