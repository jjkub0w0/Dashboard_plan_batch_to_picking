import { Component, inject, signal, computed, effect, OnInit, DestroyRef, HostListener } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { DateFilterService } from '../../services/date-filter.service';
import { getApiUrl } from '../../config/api.config';

export type OutDhlCategory = 'ALL' | 'IBD' | 'RETURN' | 'OTHER';

export function resolveOutDhlCategory(
  so: string,
  shipToParty?: string,
  storageLocation?: string
): { category: 'IBD' | 'RETURN' | 'OTHER'; label: string } {
  const s = String(so || '').trim();
  const p = String(shipToParty || '').trim();
  const sl = String(storageLocation || '').trim().toUpperCase();

  // 1. IBD: ตรวจสอบถ้าเลข SO ขึ้นต้นด้วย 132
  if (s.startsWith('132')) {
    return { category: 'IBD', label: 'IBD' };
  }
  // 2. การส่งคืน (Return): ถ้า ShipToParty == 1200 หรือ StorageLocation 2 ตัวแรกขึ้นต้นด้วย RT
  if (p === '1200' || sl.startsWith('RT')) {
    return { category: 'RETURN', label: 'การส่งคืน (Return)' };
  }
  // 3. การจัดส่งนอกเหนือจากกลุ่มอื่น
  return { category: 'OTHER', label: 'การจัดส่งนอกเหนือจากกลุ่มอื่น' };
}

/**
 * ตัดข้อความหลังเครื่องหมาย '/' ออก สำหรับการแสดงผลชื่อผู้รับ/ลูกค้า (ShipToFullName)
 * เช่น 'บริษัท อำพลฟูดส์ โพรเซสซิ่ง จำกัด/73220 จ.นครปฐม' -> 'บริษัท อำพลฟูดส์ โพรเซสซิ่ง จำกัด'
 */
export function formatShipToName(name?: string | null): string {
  if (!name) return '';
  const trimmed = name.trim();
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx !== -1) {
    return trimmed.substring(0, slashIdx).trim();
  }
  return trimmed;
}

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
  shipToFullName?: string;
  shipToParty?: string;
  storageLocation?: string;
  category: 'IBD' | 'RETURN' | 'OTHER';
  categoryLabel: string;
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
  shipToFullName?: string;
  shipToParty?: string;
  storageLocation?: string;
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
  shipToFullName?: string;
  shipToParty?: string;
  storageLocation?: string;
  category: 'IBD' | 'RETURN' | 'OTHER';
  categoryLabel: string;
}

export interface OutDhlDetailItem {
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
  shipToFullName?: string;
  shipToParty?: string;
  storageLocation?: string;
}

@Component({
  selector: 'app-out-dhl',
  standalone: true,
  templateUrl: './out-dhl.html',
  styleUrl: './out-dhl.scss',
})
export class OutDhlComponent implements OnInit {
  readonly dateService = inject(DateFilterService);
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly isLoading = signal<boolean>(false);
  readonly isExporting = signal<boolean>(false);

  // Filters
  readonly selectedCategoryFilter = signal<OutDhlCategory>('ALL');
  readonly selectedSoFilter = signal<string>('ALL');
  readonly batchSearchQuery = signal<string>('');
  readonly batchMatchFilter = signal<'ALL' | 'MATCH' | 'QTY_MISMATCH' | 'MISMATCH'>('ALL');

  setCategoryFilter(cat: OutDhlCategory): void {
    this.selectedCategoryFilter.set(cat);
  }

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

  private currentDataDate: string | null = null;

  // โครงสร้างค่าเริ่มต้นของ OUT_DHL
  private readonly defaultMetrics = {
    totalSO: 0,
    totalDO: 0,
    totalQty: 0,
    totalQtyCAR: 0,
    totalQtyPAC: 0,
    totalSKU: 0,
    totalLines: 0,
    matchedLines: 0,
    mismatchedLines: 0,
    matchedQty: 0,
    matchedQtyCAR: 0,
    matchedQtyPAC: 0,
    mismatchedQty: 0,
    mismatchedQtyCAR: 0,
    mismatchedQtyPAC: 0,
    matchedPct: 0,
    mismatchedPct: 0,
  };

  // Overall metrics from API
  readonly outDhlMetrics = signal({ ...this.defaultMetrics });

  // Raw list of OUT_DHL batch details
  readonly outDhlDetails = signal<OutDhlDetailItem[]>([]);

  // Category counts computed signal
  readonly categoryCounts = computed(() => {
    const list = this.groupedSkuItems();
    let ibd = 0;
    let ret = 0;
    let other = 0;
    for (const it of list) {
      if (it.category === 'IBD') ibd++;
      else if (it.category === 'RETURN') ret++;
      else other++;
    }
    return {
      all: list.length,
      ibd,
      ret,
      other,
    };
  });

  // Match status counts computed signal for status filter pills
  readonly matchStatusCounts = computed(() => {
    let list = this.groupedSkuItems();
    const catFilter = this.selectedCategoryFilter();
    const soFilter = this.selectedSoFilter();
    const query = this.batchSearchQuery().trim().toLowerCase();

    if (catFilter !== 'ALL') {
      list = list.filter(item => item.category === catFilter);
    }
    if (soFilter !== 'ALL') {
      list = list.filter(item => item.so === soFilter);
    }
    if (query) {
      list = list.filter(item => item.searchStr.includes(query));
    }

    let match = 0;
    let qtyMismatch = 0;
    let mismatch = 0;
    for (const it of list) {
      if (it.status === 'MATCH') match++;
      else if (it.status === 'QTY_MISMATCH') qtyMismatch++;
      else if (it.status === 'MISMATCH') mismatch++;
    }
    return {
      all: list.length,
      match,
      qtyMismatch,
      mismatch,
    };
  });

  // Group raw items into 1 row per SKU per DO
  readonly groupedSkuItems = computed<SkuBatchItem[]>(() => {
    const rawList = this.outDhlDetails();
    const doSkuMap = new Map<string, {
      so: string;
      do: string;
      route: string;
      customer: string;
      orderType: 'SO' | 'POSTO';
      material: string;
      item?: string;
      skuDescription: string;
      deliveryQuantityUnit: string;
      shipToFullName?: string;
      shipToParty?: string;
      storageLocation?: string;
      items: OutDhlDetailItem[];
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
          route: (it.route && it.route !== 'OUT_DHL') ? it.route : 'นอกเหนือจากระบบ TMS',
          customer: (it.customer && it.customer !== 'จัดส่งนอกเหนือจาก DHL') ? it.customer : 'ข้อมูลนอกเหนือจากระบบ TMS',
          orderType,
          material: mat,
          item: itemNum,
          skuDescription: it.skuDescription || '',
          deliveryQuantityUnit: (it.deliveryQuantityUnit || 'CAR').toUpperCase(),
          shipToFullName: it.shipToFullName || '',
          shipToParty: it.shipToParty || '',
          storageLocation: it.storageLocation || '',
          items: [],
        });
      }
      const entry = doSkuMap.get(key)!;
      if (!entry.item && itemNum) entry.item = itemNum;
      if (!entry.skuDescription && it.skuDescription) entry.skuDescription = it.skuDescription;
      if (!entry.shipToFullName && it.shipToFullName) entry.shipToFullName = it.shipToFullName;
      if (!entry.shipToParty && it.shipToParty) entry.shipToParty = it.shipToParty;
      if (!entry.storageLocation && it.storageLocation) entry.storageLocation = it.storageLocation;
      if (it.storageLocation && it.storageLocation.trim().toUpperCase().startsWith('RT')) entry.storageLocation = it.storageLocation;
      // ANY return row (ShipToParty 1200) makes the whole group RETURN, matching the
      // backend excel-export anyReturn rule - first-non-empty alone mislabeled mixed SOs.
      if (it.shipToParty && it.shipToParty.trim() === '1200') entry.shipToParty = it.shipToParty;
      entry.items.push(it);
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
          const isAllQtyMatch = realPlanBatches.every(pb => pb.qtyMatch);
          if (isAllQtyMatch) {
            status = 'MATCH';
            statusText = 'ตรงตามแนะนำ';
            isOverallMatch = true;
          } else {
            status = 'QTY_MISMATCH';
            statusText = 'ตรงตามแนะนำแต่จำนวนไม่ตรง';
            isOverallMatch = false;
          }
        }
      }

      // 6. SKU quantity: ผลรวมของทุกรายการในกลุ่ม SKU นี้ (ซึ่งอิงตาม FirstBatch.QTY แต่ละแถว)
      const totalSkuQty = group.items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);

      const { category, label: categoryLabel } = resolveOutDhlCategory(group.so, group.shipToParty, group.storageLocation);
      const planBatchesStr = planBatches.map(pb => pb.batch).join(' ');
      const sapBatchesStr = sapBatches.map(sb => sb.batch).join(' ');
      const searchStr = `${group.so} ${group.do} ${group.item || ''} ${group.route} ${group.customer} ${group.shipToFullName || ''} ${group.shipToParty || ''} ${group.storageLocation || ''} ${categoryLabel} ${group.material} ${group.skuDescription} ${planBatchesStr} ${sapBatchesStr} ${statusText}`.toLowerCase();

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
        shipToFullName: group.shipToFullName,
        shipToParty: group.shipToParty,
        storageLocation: group.storageLocation,
        category,
        categoryLabel,
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
    const map = new Map<string, {
      so: string;
      doCount: number;
      qty: number;
      matchedLines: number;
      totalLines: number;
      route: string;
      customer: string;
      shipToFullName?: string;
      shipToParty?: string;
      storageLocation?: string;
      dos: Set<string>;
    }>();

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
          shipToFullName: item.shipToFullName || '',
          shipToParty: item.shipToParty || '',
          storageLocation: item.storageLocation || '',
          dos: new Set<string>(),
        });
      }
      const entry = map.get(so)!;
      if (!entry.shipToFullName && item.shipToFullName) entry.shipToFullName = item.shipToFullName;
      if (!entry.shipToParty && item.shipToParty) entry.shipToParty = item.shipToParty;
      if (!entry.storageLocation && item.storageLocation) entry.storageLocation = item.storageLocation;
      if (item.storageLocation && item.storageLocation.trim().toUpperCase().startsWith('RT')) entry.storageLocation = item.storageLocation;
      // ANY return row (ShipToParty 1200) makes the whole group RETURN, matching the
      // backend excel-export anyReturn rule - first-non-empty alone mislabeled mixed SOs.
      if (item.shipToParty && item.shipToParty.trim() === '1200') entry.shipToParty = item.shipToParty;
      entry.qty += item.qty;
      entry.totalLines += 1;
      if (item.status === 'MATCH') entry.matchedLines += 1;
      entry.dos.add(item.do);
    }

    return Array.from(map.values()).map(e => {
      const { category, label: categoryLabel } = resolveOutDhlCategory(e.so, e.shipToParty, e.storageLocation);
      return {
        so: e.so,
        doCount: e.dos.size,
        qty: e.qty,
        route: e.route,
        customer: e.customer,
        shipToFullName: e.shipToFullName,
        storageLocation: e.storageLocation,
        category,
        categoryLabel,
        matchRate: e.totalLines > 0 ? Math.round((e.matchedLines / e.totalLines) * 100) : 0,
      };
    });
  });

  // Filtered grouped SKU list
  readonly filteredSkuItems = computed(() => {
    let list = this.groupedSkuItems();
    const catFilter = this.selectedCategoryFilter();
    const soFilter = this.selectedSoFilter();
    const matchFilter = this.batchMatchFilter();
    const query = this.batchSearchQuery().trim().toLowerCase();

    if (catFilter !== 'ALL') {
      list = list.filter(item => item.category === catFilter);
    }

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

  // Summary stats for currently filtered view
  readonly containerStats = computed(() => {
    const list = this.filteredSkuItems();
    const totalLines = list.length;
    const matched = list.filter(x => x.status === 'MATCH').length;
    const qtyMismatched = list.filter(x => x.status === 'QTY_MISMATCH').length;
    const mismatched = list.filter(x => x.status === 'MISMATCH').length;
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
    const matchPct = totalLines > 0 ? Math.round((matched / totalLines) * 100) : 0;

    return {
      totalLines,
      matched,
      qtyMismatched,
      mismatched,
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
      shipToFullName?: string;
      shipToParty?: string;
      storageLocation?: string;
      doMap: Map<string, {
        doNumber: string;
        route: string;
        customer: string;
        shipToFullName?: string;
        shipToParty?: string;
        storageLocation?: string;
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
          shipToFullName: item.shipToFullName || '',
          shipToParty: item.shipToParty || '',
          storageLocation: item.storageLocation || '',
          doMap: new Map(),
        });
      }

      const soEntry = soMap.get(so)!;
      if (!soEntry.shipToFullName && item.shipToFullName) soEntry.shipToFullName = item.shipToFullName;
      if (!soEntry.shipToParty && item.shipToParty) soEntry.shipToParty = item.shipToParty;
      if (!soEntry.storageLocation && item.storageLocation) soEntry.storageLocation = item.storageLocation;
      if (item.storageLocation && item.storageLocation.trim().toUpperCase().startsWith('RT')) soEntry.storageLocation = item.storageLocation;
      // ANY return row (ShipToParty 1200) makes the whole group RETURN, matching the
      // backend excel-export anyReturn rule - first-non-empty alone mislabeled mixed SOs.
      if (item.shipToParty && item.shipToParty.trim() === '1200') soEntry.shipToParty = item.shipToParty;

      if (!soEntry.doMap.has(doNum)) {
        soEntry.doMap.set(doNum, {
          doNumber: doNum,
          route: item.route,
          customer: item.customer,
          shipToFullName: item.shipToFullName || '',
          shipToParty: item.shipToParty || '',
          storageLocation: item.storageLocation || '',
          skus: [],
        });
      }

      const doEntry = soEntry.doMap.get(doNum)!;
      if (!doEntry.shipToFullName && item.shipToFullName) doEntry.shipToFullName = item.shipToFullName;
      if (!doEntry.shipToParty && item.shipToParty) doEntry.shipToParty = item.shipToParty;
      if (!doEntry.storageLocation && item.storageLocation) doEntry.storageLocation = item.storageLocation;
      if (item.storageLocation && item.storageLocation.trim().toUpperCase().startsWith('RT')) doEntry.storageLocation = item.storageLocation;
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
          shipToFullName: d.shipToFullName,
          shipToParty: d.shipToParty,
          storageLocation: d.storageLocation,
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
      const { category, label: categoryLabel } = resolveOutDhlCategory(so.soNumber, so.shipToParty, so.storageLocation);

      return {
        soNumber: so.soNumber,
        orderType: so.orderType,
        route: so.route,
        customer: so.customer,
        shipToFullName: so.shipToFullName,
        shipToParty: so.shipToParty,
        storageLocation: so.storageLocation,
        category,
        categoryLabel,
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
      this.outDhlMetrics.set({ ...this.defaultMetrics });
      this.outDhlDetails.set([]);
    }

    this.loadOutDhlEndpoint(cleanDate);
  }

  private loadOutDhlEndpoint(cleanDate: string): void {
    const apiUrl = getApiUrl('/out-dhl', { date: cleanDate });

    this.http.get<any>(apiUrl).subscribe({
      next: (res) => {
        // Race condition guard: หากผู้ใช้เปลี่ยนวันไปแล้ว ข้ามผลลัพธ์ของคำขอเดิม
        const currentSelected = this.dateService.isoDate();
        if (currentSelected && currentSelected !== cleanDate) {
          return;
        }

        this.isLoading.set(false);
        this.currentDataDate = cleanDate;

        if (res && res.data) {
          const m = res.data.metrics;
          if (m) {
            this.outDhlMetrics.set({
              totalSO: m.totalSO || 0,
              totalDO: m.totalDO || 0,
              totalQty: m.totalQty || 0,
              totalQtyCAR: m.totalQtyCAR || 0,
              totalQtyPAC: m.totalQtyPAC || 0,
              totalSKU: m.totalSKU || 0,
              totalLines: m.totalLines || 0,
              matchedLines: m.matchedLines || 0,
              mismatchedLines: m.mismatchedLines || 0,
              matchedQty: m.matchedQty || 0,
              matchedQtyCAR: m.matchedQtyCAR || 0,
              matchedQtyPAC: m.matchedQtyPAC || 0,
              mismatchedQty: m.mismatchedQty || 0,
              mismatchedQtyCAR: m.mismatchedQtyCAR || 0,
              mismatchedQtyPAC: m.mismatchedQtyPAC || 0,
              matchedPct: m.matchedPct || 0,
              mismatchedPct: m.mismatchedPct || 0,
            });
          }

          if (Array.isArray(res.data.soBatchDetails)) {
            this.outDhlDetails.set(res.data.soBatchDetails);
          } else if (Array.isArray(res.data.batches)) {
            const all = res.data.batches.flatMap((b: any) => b.batchDetails || []);
            this.outDhlDetails.set(all);
          } else {
            this.outDhlDetails.set([]);
          }

          // ตรวจสอบว่า SO Filter เดิมที่เคยเลือกไว้ ยังมีอยู่ในข้อมูลวันที่ใหม่หรือไม่
          const currentSo = this.selectedSoFilter();
          if (currentSo !== 'ALL') {
            const exists = (this.outDhlDetails() || []).some(item => item.so === currentSo);
            if (!exists) {
              this.selectedSoFilter.set('ALL');
            }
          }
        } else {
          this.outDhlMetrics.set({ ...this.defaultMetrics });
          this.outDhlDetails.set([]);
          this.selectedSoFilter.set('ALL');
        }
      },
      error: (err) => {
        const currentSelected = this.dateService.isoDate();
        if (currentSelected && currentSelected !== cleanDate) return;

        this.isLoading.set(false);
        this.currentDataDate = cleanDate;
        this.outDhlMetrics.set({ ...this.defaultMetrics });
        this.outDhlDetails.set([]);
        console.error(`[ERROR] [OutDhl] Error fetching OUT_DHL data for date "${cleanDate}":`, err);
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
    this.selectedCategoryFilter.set('ALL');
    this.selectedSoFilter.set('ALL');
    this.batchSearchQuery.set('');
    this.batchMatchFilter.set('ALL');
  }

  exportExcel(): void {
    const selectedIso = this.dateService.isoDate();
    const cleanDate = selectedIso
      ? (selectedIso.includes('T') ? selectedIso.split('T')[0] : selectedIso.trim())
      : new Date().toISOString().split('T')[0];

    this.isExporting.set(true);
    const exportUrl = getApiUrl('/export/excel/out-dhl', { date: cleanDate });

    this.http.get(exportUrl, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        this.isExporting.set(false);
        const fileName = `Non_TMS_Dashboard_Report_${cleanDate}.xlsx`;
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
        console.error('[ERROR] [OutDhl] Export Excel error:', err);
        alert('เกิดข้อผิดพลาดในการดาวน์โหลดรายงาน Excel กรุณาลองใหม่อีกครั้ง');
      },
    });
  }

  formatShipTo(name?: string | null): string {
    return formatShipToName(name);
  }
}
