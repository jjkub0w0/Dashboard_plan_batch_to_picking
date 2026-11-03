import {
  RawPickingItem,
  DashboardMetrics,
  BatchSummary,
  OrderSummary,
  MismatchedLineItem,
  CalculationResult,
  SoBatchDetailItem,
} from '../types/backend.types.js';
import { NO_PLAN_BATCH, NO_PLAN_BATCH_LEGACY } from '../utils/batch-labels.js';
import { getTodayDateStr } from '../utils/date.js';

export class CalculationService {
  /**
   * คำนวณภาพรวมทั้งหมดจากข้อมูลจริง: SO, DO, QTY, SKU, Batch, Matched, Mismatched
   * @param rawItems รายการข้อมูลจริงจากไฟล์
   * @param dateString วันที่ในรูปแบบ YYYY-MM-DDTHH:mm:ss
   */
  calculateDashboard(rawItems: RawPickingItem[], dateString?: string): CalculationResult {
    const formattedDate = dateString || this.getTodayIso();

    // หากไม่มีข้อมูลจริงสำหรับวันที่นั้น (0 แถว) ให้ส่งกลับค่า 0 ทั้งหมด (ไม่มีการจำลองข้อมูล)
    if (!rawItems || rawItems.length === 0) {
      const emptyMetrics: DashboardMetrics = {
        date: formattedDate,
        totalSO: 0,
        totalDO: 0,
        totalQty: 0,
        totalQtyCAR: 0,
        totalQtyPAC: 0,
        totalQtyOther: 0,
        qtyByUnit: {},
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
        swapInPlanCount: 0,
        swapOutPlanCount: 0,
      };

      return {
        metrics: emptyMetrics,
        batches: [],
        orders: [],
        mismatchedLines: [],
        rawDataCount: 0,
      };
    }

    // Pre-processing: ตรวจสอบเงื่อนไขถ้า FirstBatch.Batch == "" หรือไม่มีการวางแผนล็อต
    // ให้แสดงผลตรงช่อง Plan Batch / FirstBatch (จาก S3) เป็น "ไม่ได้ plant ไว้ " แล้ว match = true แทน (บังคับโดยไม่ต้องตรวจสอบ)
    for (const item of rawItems) {
      const fbList = Array.isArray(item.firstBatch) ? item.firstBatch : [];
      const isFirstBatchEmpty = fbList.length > 0 && fbList.every((fb: any) => !fb.Batch || String(fb.Batch).trim() === '' || String(fb.Batch).trim() === NO_PLAN_BATCH_LEGACY);
      const hasPlannedBatch = fbList.some((fb: any) => {
        const b = String(fb.Batch || '').trim();
        return b !== '' && b !== NO_PLAN_BATCH_LEGACY;
      });
      const isBatchPlanNoPlan = item.batchPlan === NO_PLAN_BATCH || item.batchPlan === NO_PLAN_BATCH_LEGACY;
      const isStrNoPlan = Boolean(item.firstBatchStr && item.firstBatchStr.trim() === NO_PLAN_BATCH_LEGACY);
      const isAllNoPlan = !hasPlannedBatch && ((fbList.length > 0 && isFirstBatchEmpty) || (fbList.length === 0 && (isBatchPlanNoPlan || isStrNoPlan)));

      if (isAllNoPlan) {
        item.batchPlan = NO_PLAN_BATCH;
        const u = (item.deliveryQuantityUnit || 'CAR').trim().toUpperCase() || 'CAR';
        const unitLabel = u === 'CAR' ? 'ลัง' : (u === 'PAC' ? 'แพ็ค' : u);

        if (fbList.length > 0) {
          item.firstBatch = fbList.map((fb: any) => ({
            Batch: (!fb.Batch || String(fb.Batch).trim() === '' || String(fb.Batch).trim() === NO_PLAN_BATCH_LEGACY || String(fb.Batch).trim() === NO_PLAN_BATCH.trim())
              ? NO_PLAN_BATCH
              : String(fb.Batch).trim(),
            QTY: fb.QTY !== undefined && fb.QTY !== null && String(fb.QTY).trim() !== ''
              ? (Number(fb.QTY) || 0)
              : (Number(item.qty) || 0),
          }));
        } else {
          item.firstBatch = [{ Batch: NO_PLAN_BATCH, QTY: Number(item.qty) || 0 }];
        }

        const planQtySum = item.firstBatch.reduce((sum: number, fb: any) => sum + (Number(fb.QTY) || 0), 0);
        if (!item.firstBatchStr || item.firstBatchStr === NO_PLAN_BATCH || item.firstBatchStr.trim() === NO_PLAN_BATCH_LEGACY) {
          item.firstBatchStr = planQtySum > 0 ? `${NO_PLAN_BATCH.trim()} (${planQtySum} ${unitLabel})` : NO_PLAN_BATCH;
        }
      }
    }

    // 2. ตรวจสอบเงื่อนไข: "ถ้าไม่ได้เหมือน plan batch ทั้งหมด = สถานะ สลับล็อต"
    // รวมกลุ่มตาม DO + itemCode + item เพื่อดูภาพรวมของล็อตที่หยิบจริงใน SAP เทียบกับแผน FirstBatch
    const doItemGroups = new Map<string, RawPickingItem[]>();
    for (const it of rawItems) {
      const key = `${it.do}|${it.itemCode}|${it.item || ''}`;
      if (!doItemGroups.has(key)) doItemGroups.set(key, []);
      doItemGroups.get(key)!.push(it);
    }

    for (const grp of doItemGroups.values()) {
      const sapBatches = grp
        .map(it => String(it.sapBatch || it.vrfyBatch || '').trim())
        .filter(Boolean);

      // 1. หากไม่มีข้อมูลใน SAP เลย (รอข้อมูล SAP) ให้แยกเป็นสถานะ PENDING โดยไม่นับรวมใน MATCH หรือ MISMATCH
      if (sapBatches.length === 0) {
        for (const it of grp) {
          it.match = false;
          it.batchStatus = 'PENDING';
        }
        continue;
      }

      const fbList = Array.isArray(grp[0].firstBatch) ? grp[0].firstBatch : [];
      const plannedBatches = fbList
        .map((fb: any) => String(fb.Batch || '').trim())
        .filter((b: string) => b !== '' && !b.includes(NO_PLAN_BATCH_LEGACY));

      const isAllNoPlan = grp[0].batchPlan === NO_PLAN_BATCH || (plannedBatches.length === 0 && fbList.some((fb: any) => String(fb.Batch || '').includes(NO_PLAN_BATCH)));

      if (isAllNoPlan) {
        const planTotalQty = fbList.reduce((sum: number, fb: any) => sum + (Number(fb?.QTY) || 0), 0);
        const actualTotalQty = grp.reduce((sum: number, it: any) => sum + (Number(it.qty) || 0), 0);
        const isQtyMatch = planTotalQty > 0 ? planTotalQty === actualTotalQty : true;

        for (const it of grp) {
          it.match = isQtyMatch;
          it.batchStatus = isQtyMatch ? 'MATCH' : 'QTY_MISMATCH';
        }
      } else if (plannedBatches.length > 0) {
        // ทุก batch ในแผนต้องถูกหยิบใน SAP และทุก batch ใน SAP ต้องอยู่ในแผน
        const allPlannedInSap = plannedBatches.every(pb => sapBatches.includes(pb));
        const allSapInPlan = sapBatches.every(sb => plannedBatches.includes(sb));

        // หาก batch ไม่ตรงกันทั้งหมด -> สลับล็อต
        if (!allPlannedInSap || !allSapInPlan) {
          for (const it of grp) {
            it.match = false;
            it.batchStatus = 'MISMATCH';
          }
        } else {
          // ถ้า batch เหมือนกันแล้ว แต่ยอดไม่ตรง ให้มีอีกสถานะคือ จัดตรงตาม PlanBatch แต่ยอดไม่ตรง
          let isAllQtyMatch = true;
          for (const fb of fbList) {
            const b = String(fb.Batch || '').trim();
            if (!b || b.includes(NO_PLAN_BATCH_LEGACY)) continue;
            const planQty = Number(fb.QTY) || 0;
            const sapQty = grp
              .filter(it => String(it.sapBatch || it.vrfyBatch || '').trim() === b)
              .reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
            if (planQty !== sapQty) {
              isAllQtyMatch = false;
              break;
            }
          }

          // เคสพิเศษ: มี plan batch > 1 และมี plan batch == null อย่างน้อย 1 ตัว
          // โดย batch ที่ดึงมาจาก fiori ตรงกับตัวอื่นในนั้นจนครบ และ qty ของแต่ละ batch ไม่น้อยกว่าที่ First batch กำหนด
          const hasNoPlanInFb = fbList.some((fb: any) => {
            const b = String(fb?.Batch || '').trim();
            return !b || b === '-' || b.includes(NO_PLAN_BATCH_LEGACY);
          });
          const planTotalQty = fbList.reduce((sum: number, fb: any) => sum + (Number(fb?.QTY) || 0), 0);
          const actualTotalQty = grp.reduce((sum: number, it: any) => sum + (Number(it.qty) || 0), 0);
          const isTotalQtyMatch = planTotalQty > 0 ? planTotalQty === actualTotalQty : true;

          let isSpecialNoPlanQtyMatch = false;
          if (hasNoPlanInFb && fbList.length > 1 && plannedBatches.length > 0 && isTotalQtyMatch) {
            isSpecialNoPlanQtyMatch = plannedBatches.every(b => {
              const planQty = fbList
                .filter((fb: any) => String(fb?.Batch || '').trim() === b)
                .reduce((sum: number, fb: any) => sum + (Number(fb.QTY) || 0), 0);
              const sapQty = grp
                .filter(it => String(it.sapBatch || it.vrfyBatch || '').trim() === b)
                .reduce((sum: number, it: any) => sum + (Number(it.qty) || 0), 0);
              return sapQty >= planQty;
            });
          }

          for (const it of grp) {
            if (isAllQtyMatch || isSpecialNoPlanQtyMatch) {
              it.match = true;
              it.batchStatus = 'MATCH';
            } else {
              it.match = false;
              it.batchStatus = 'QTY_MISMATCH';
            }
          }
        }
      } else {
        const planBatch = String(grp[0].batchPlan || '').trim();
        if (planBatch && planBatch !== '-' && planBatch !== NO_PLAN_BATCH) {
          const isMatch = sapBatches.every(sb => sb === planBatch);
          for (const it of grp) {
            it.match = isMatch;
            it.batchStatus = isMatch ? 'MATCH' : 'MISMATCH';
          }
        } else {
          for (const it of grp) {
            it.match = true;
            it.batchStatus = 'MATCH';
          }
        }
      }
    }

    // 1. Unique Sets for SKUs and DOs
    const uniqueSkus = new Set<string>();
    const uniqueDos = new Set<string>();
    const planByItem = new Map<string, Set<string>>();

    for (const item of rawItems) {
      if (item.itemCode) uniqueSkus.add(item.itemCode);
      if (item.do) uniqueDos.add(item.do);

      if (!planByItem.has(item.itemCode)) {
        planByItem.set(item.itemCode, new Set());
      }
      if (item.batchPlan && !item.batchPlan.includes(NO_PLAN_BATCH_LEGACY)) {
        planByItem.get(item.itemCode)!.add(item.batchPlan.slice(0, 6));
      }
      const fbList = Array.isArray(item.firstBatch) ? item.firstBatch : [];
      for (const fb of fbList) {
        const b = String(fb.Batch || '').trim();
        if (b && !b.includes(NO_PLAN_BATCH_LEGACY)) {
          planByItem.get(item.itemCode)!.add(b.slice(0, 6));
        }
      }
    }

    // 2. Order Level Aggregations
    const orderGroups = new Map<string, RawPickingItem[]>();
    for (const r of rawItems) {
      const key = `${r.route}|${r.orderType}|${r.orderNum}`;
      if (!orderGroups.has(key)) orderGroups.set(key, []);
      orderGroups.get(key)!.push(r);
    }

    let soCount = 0;
    let postoCount = 0;
    const orders: OrderSummary[] = [];

    orderGroups.forEach((grp, key) => {
      const [route, otype, onum] = key.split('|');
      if (otype === 'SO') soCount++;
      if (otype === 'POSTO') postoCount++;

      const uniqueDOs = Array.from(new Set(grp.map(x => x.do).filter(Boolean))).sort().join(', ');
      const customer = grp.find(x => Boolean(x.customer))?.customer || '';
      const rows = grp.length;
      const totalQty = grp.reduce((sum, x) => sum + x.qty, 0);
      let orderQtyCAR = 0;
      let orderQtyPAC = 0;
      const orderQtyByUnit: Record<string, number> = {};
      for (const x of grp) {
        const u = (x.deliveryQuantityUnit || 'CAR').trim().toUpperCase() || 'CAR';
        orderQtyByUnit[u] = (orderQtyByUnit[u] || 0) + x.qty;
        if (u === 'CAR') orderQtyCAR += x.qty;
        else if (u === 'PAC') orderQtyPAC += x.qty;
      }
      const matches = grp.filter(x => x.batchStatus === 'MATCH').length;
      const changed = grp.filter(x => x.batchStatus === 'MISMATCH').length;
      const matchPct = rows > 0 ? (matches / rows) * 100 : 0;

      orders.push({
        route,
        orderType: otype,
        orderNum: onum,
        do: uniqueDOs,
        customer,
        rows,
        totalQty,
        totalQtyCAR: orderQtyCAR,
        totalQtyPAC: orderQtyPAC,
        qtyByUnit: orderQtyByUnit,
        matches,
        changed,
        matchPct,
      });
    });

    // Sort orders: orderType ASC, totalQty DESC
    orders.sort((a, b) => {
      if (a.orderType !== b.orderType) return a.orderType.localeCompare(b.orderType);
      return b.totalQty - a.totalQty;
    });

    // 3. Line Items & Swap Types Calculations (4 กลุ่มแยกเด็ดขาด: MATCH, QTY_MISMATCH, MISMATCH, PENDING)
    let totalQty = 0;
    let totalQtyCAR = 0;
    let totalQtyPAC = 0;
    let totalQtyOther = 0;
    let matchedLines = 0;
    let matchedQty = 0;
    let matchedQtyCAR = 0;
    let matchedQtyPAC = 0;
    let qtyMismatchedLines = 0;
    let qtyMismatchedQty = 0;
    let qtyMismatchedQtyCAR = 0;
    let qtyMismatchedQtyPAC = 0;
    let mismatchedLines = 0;
    let mismatchedQty = 0;
    let mismatchedQtyCAR = 0;
    let mismatchedQtyPAC = 0;
    let pendingLines = 0;
    let pendingQty = 0;
    let pendingQtyCAR = 0;
    let pendingQtyPAC = 0;
    let swapInPlanCount = 0;
    let swapOutPlanCount = 0;
    const qtyByUnit: Record<string, { total: number; matched: number; mismatched: number }> = {};

    const mismatchedItems: MismatchedLineItem[] = [];

    for (const r of rawItems) {
      const u = (r.deliveryQuantityUnit || 'CAR').trim().toUpperCase() || 'CAR';
      if (!qtyByUnit[u]) {
        qtyByUnit[u] = { total: 0, matched: 0, mismatched: 0 };
      }
      qtyByUnit[u].total += r.qty;
      totalQty += r.qty;

      if (u === 'CAR') {
        totalQtyCAR += r.qty;
      } else if (u === 'PAC') {
        totalQtyPAC += r.qty;
      } else {
        totalQtyOther += r.qty;
      }

      if (r.batchStatus === 'MATCH') {
        matchedLines++;
        matchedQty += r.qty;
        qtyByUnit[u].matched += r.qty;
        if (u === 'CAR') matchedQtyCAR += r.qty;
        else if (u === 'PAC') matchedQtyPAC += r.qty;
      } else if (r.batchStatus === 'QTY_MISMATCH') {
        qtyMismatchedLines++;
        qtyMismatchedQty += r.qty;
        if (u === 'CAR') qtyMismatchedQtyCAR += r.qty;
        else if (u === 'PAC') qtyMismatchedQtyPAC += r.qty;
      } else if (r.batchStatus === 'PENDING') {
        pendingLines++;
        pendingQty += r.qty;
        if (u === 'CAR') pendingQtyCAR += r.qty;
        else if (u === 'PAC') pendingQtyPAC += r.qty;
      } else {
        // MISMATCH (สลับล็อต)
        mismatchedLines++;
        mismatchedQty += r.qty;
        qtyByUnit[u].mismatched += r.qty;
        if (u === 'CAR') mismatchedQtyCAR += r.qty;
        else if (u === 'PAC') mismatchedQtyPAC += r.qty;

        const vrfyPrefix = r.vrfyBatch ? r.vrfyBatch.slice(0, 6) : '';
        const itemPlans = planByItem.get(r.itemCode) || new Set();
        const isSwapInPlan = itemPlans.has(vrfyPrefix);

        if (isSwapInPlan) {
          swapInPlanCount++;
        } else {
          swapOutPlanCount++;
        }

        mismatchedItems.push({
          route: r.route,
          orderType: r.orderType,
          orderNum: r.orderNum,
          do: r.do,
          customer: r.customer,
          itemCode: r.itemCode,
          stdDesc: r.stdDesc,
          batchPlan: r.batchPlan,
          vrfyBatch: r.vrfyBatch,
          qty: r.qty,
          swapType: isSwapInPlan ? 'สลับล็อตในแผน' : 'จ่ายล็อตนอกแผน',
        });
      }
    }

    const totalLines = rawItems.length;
    const matchedPct = totalLines > 0 ? Math.round((matchedLines / totalLines) * 1000) / 10 : 0;
    const qtyMismatchedPct = totalLines > 0 ? Math.round((qtyMismatchedLines / totalLines) * 1000) / 10 : 0;
    const mismatchedPct = totalLines > 0 ? Math.round((mismatchedLines / totalLines) * 1000) / 10 : 0;
    const pendingPct = totalLines > 0 ? Math.round((pendingLines / totalLines) * 1000) / 10 : 0;

    // 4. SO Level Aggregations (Grouped by SO / Sales Order และ Trip Number รองรับกรณีสปลิตคัน)
    const soGroups = new Map<string, RawPickingItem[]>();
    for (const r of rawItems) {
      const soNum = r.orderNum || r.do || 'UNKNOWN';
      const routeStr = (r.route || '').trim();
      // จัดกลุ่มด้วย SO + Trip เพื่อแยกแถวเมื่อมีสปลิตคัน (Split Trip) แต่หาก Trip เดียวกันจะรวมเป็นแถวเดียวกัน
      const groupKey = routeStr ? `${soNum}|${routeStr}` : soNum;
      if (!soGroups.has(groupKey)) soGroups.set(groupKey, []);
      soGroups.get(groupKey)!.push(r);
    }

    const batches: BatchSummary[] = [];

    soGroups.forEach((grp, groupKey) => {
      const soNum = groupKey.includes('|') ? groupKey.split('|')[0] : groupKey;
      const oType = (grp.some(x => x.orderType === 'POSTO') || soNum.startsWith('42')) ? 'POSTO' : 'SO';
      const uniqueDos = Array.from(new Set(grp.map(x => x.do).filter(Boolean)));
      const doStr = uniqueDos.join(', ');
      const rDOs = uniqueDos.length || 1;
      const rSkus = new Set(grp.map(x => x.itemCode)).size;
      const route = grp.find(x => Boolean(x.route))?.route || '';
      const customer = grp.find(x => Boolean(x.customer))?.customer || '';

      const rTotQty = grp.reduce((acc, x) => acc + x.qty, 0);
      let bTotQtyCAR = 0;
      let bTotQtyPAC = 0;
      let bMatchQtyCAR = 0;
      let bMatchQtyPAC = 0;
      let bQtyMisQtyCAR = 0;
      let bQtyMisQtyPAC = 0;
      let bMisQtyCAR = 0;
      let bMisQtyPAC = 0;
      let bPendingQtyCAR = 0;
      let bPendingQtyPAC = 0;
      const bQtyByUnit: Record<string, number> = {};

      for (const item of grp) {
        const u = (item.deliveryQuantityUnit || 'CAR').trim().toUpperCase() || 'CAR';
        bQtyByUnit[u] = (bQtyByUnit[u] || 0) + item.qty;
        if (u === 'CAR') {
          bTotQtyCAR += item.qty;
          if (item.batchStatus === 'MATCH') bMatchQtyCAR += item.qty;
          else if (item.batchStatus === 'QTY_MISMATCH') bQtyMisQtyCAR += item.qty;
          else if (item.batchStatus === 'MISMATCH') bMisQtyCAR += item.qty;
          else if (item.batchStatus === 'PENDING') bPendingQtyCAR += item.qty;
        } else if (u === 'PAC') {
          bTotQtyPAC += item.qty;
          if (item.batchStatus === 'MATCH') bMatchQtyPAC += item.qty;
          else if (item.batchStatus === 'QTY_MISMATCH') bQtyMisQtyPAC += item.qty;
          else if (item.batchStatus === 'MISMATCH') bMisQtyPAC += item.qty;
          else if (item.batchStatus === 'PENDING') bPendingQtyPAC += item.qty;
        }
      }

      const rMatchLines = grp.filter(x => x.batchStatus === 'MATCH').length;
      const rMatchQty = grp.filter(x => x.batchStatus === 'MATCH').reduce((acc, x) => acc + x.qty, 0);
      const rQtyMisLines = grp.filter(x => x.batchStatus === 'QTY_MISMATCH').length;
      const rQtyMisQty = grp.filter(x => x.batchStatus === 'QTY_MISMATCH').reduce((acc, x) => acc + x.qty, 0);
      const rMisLines = grp.filter(x => x.batchStatus === 'MISMATCH').length;
      const rMisQty = grp.filter(x => x.batchStatus === 'MISMATCH').reduce((acc, x) => acc + x.qty, 0);
      const rPendingLines = grp.filter(x => x.batchStatus === 'PENDING').length;
      const rPendingQty = grp.filter(x => x.batchStatus === 'PENDING').reduce((acc, x) => acc + x.qty, 0);
      const rRate = grp.length > 0 ? Math.round((rMatchLines / grp.length) * 1000) / 10 : 0;

      let status: 'COMPLETED' | 'IN_PROGRESS' | 'PLANNED' = 'COMPLETED';
      if (rPendingLines === grp.length) {
        status = 'PLANNED';
      } else if (rMisLines > 0 || rQtyMisLines > 0) {
        status = 'IN_PROGRESS';
      } else if (rPendingLines > 0) {
        status = 'PLANNED';
      } else {
        status = 'COMPLETED';
      }

      const batchDetails: SoBatchDetailItem[] = grp.map(item => {
        const u = (item.deliveryQuantityUnit || 'CAR').trim().toUpperCase() || 'CAR';
        const unitLabel = u === 'CAR' ? 'ลัง' : (u === 'PAC' ? 'แพ็ค' : u);
        const fbList = Array.isArray(item.firstBatch) ? item.firstBatch : [];
        const isFirstBatchAllEmpty = fbList.length > 0 && fbList.every((fb: any) => !fb.Batch || String(fb.Batch).trim() === '' || String(fb.Batch).trim() === NO_PLAN_BATCH_LEGACY);
        const hasPlannedBatch = fbList.some((fb: any) => {
          const b = String(fb.Batch || '').trim();
          return b !== '' && b !== NO_PLAN_BATCH_LEGACY;
        });
        const isBatchPlanNoPlan = item.batchPlan === NO_PLAN_BATCH || item.batchPlan === NO_PLAN_BATCH_LEGACY;
        const isAllNoPlan = !hasPlannedBatch && ((fbList.length > 0 && isFirstBatchAllEmpty) || (fbList.length === 0 && isBatchPlanNoPlan));
        const planQtySum = (item.firstBatch || []).reduce((sum: number, fb: any) => sum + (Number(fb.QTY) || 0), 0);
        const fbStr = item.firstBatchStr && item.firstBatchStr !== NO_PLAN_BATCH && item.firstBatchStr.trim() !== NO_PLAN_BATCH_LEGACY
          ? item.firstBatchStr
          : (isAllNoPlan
              ? (planQtySum > 0 ? `${NO_PLAN_BATCH.trim()} (${planQtySum} ${unitLabel})` : NO_PLAN_BATCH)
              : (item.batchPlan ? `${item.batchPlan} (${item.qty} ${unitLabel})` : '-'));

        return {
          so: item.orderNum,
          do: item.do,
          item: item.item,
          route: item.route,
          customer: item.customer,
          material: item.itemCode,
          skuDescription: item.stdDesc,
          firstBatch: (item.firstBatch && item.firstBatch.length > 0) ? item.firstBatch : (isAllNoPlan ? [{ Batch: NO_PLAN_BATCH, QTY: item.qty }] : []),
          firstBatchStr: fbStr,
          batchPlan: isAllNoPlan ? NO_PLAN_BATCH : item.batchPlan,
          sapBatch: item.sapBatch || item.vrfyBatch,
          qty: item.qty,
          deliveryQuantityUnit: u,
          match: item.match,
          batchStatus: item.batchStatus || (isAllNoPlan ? (item.match ? 'MATCH' : 'QTY_MISMATCH') : (!item.vrfyBatch && !item.sapBatch ? 'PENDING' : (item.match ? 'MATCH' : 'MISMATCH'))),
          status: item.batchStatus === 'PENDING' ? 'PLANNED' : (item.batchStatus === 'MATCH' ? 'COMPLETED' : 'IN_PROGRESS'),
          shipToFullName: item.shipToFullName || '',
          shipToParty: item.shipToParty || '',
          storageLocation: item.storageLocation || '',
        };
      });

      batches.push({
        batchCode: groupKey,
        soNumber: soNum,
        doNumber: doStr,
        route,
        customer,
        orderType: oType,
        soCount: 1,
        doCount: rDOs,
        totalQty: rTotQty,
        totalQtyCAR: bTotQtyCAR,
        totalQtyPAC: bTotQtyPAC,
        skusCount: rSkus,
        matchedQty: rMatchQty,
        matchedQtyCAR: bMatchQtyCAR,
        matchedQtyPAC: bMatchQtyPAC,
        qtyMismatchedQty: rQtyMisQty,
        qtyMismatchedQtyCAR: bQtyMisQtyCAR,
        qtyMismatchedQtyPAC: bQtyMisQtyPAC,
        mismatchedQty: rMisQty,
        mismatchedQtyCAR: bMisQtyCAR,
        mismatchedQtyPAC: bMisQtyPAC,
        pendingQty: rPendingQty,
        pendingQtyCAR: bPendingQtyCAR,
        pendingQtyPAC: bPendingQtyPAC,
        matchedLines: rMatchLines,
        qtyMismatchedLines: rQtyMisLines,
        mismatchedLines: rMisLines,
        pendingLines: rPendingLines,
        matchRate: rRate,
        status,
        qtyByUnit: bQtyByUnit,
        batchDetails,
        shipToFullName: grp.find(it => it.shipToFullName)?.shipToFullName || '',
        shipToParty: grp.find(it => it.shipToParty)?.shipToParty || '',
        storageLocation: grp.find(it => it.storageLocation)?.storageLocation || '',
      });
    });

    // Sort batches by totalQty DESC
    batches.sort((a, b) => b.totalQty - a.totalQty);

    const allBatchDetails: SoBatchDetailItem[] = batches.flatMap(b => b.batchDetails || []);

    const uniqueTrips = new Set(rawItems.map(x => x.route).filter(Boolean)).size;
    const uniqueSoCount = new Set(rawItems.map(x => x.orderNum).filter(Boolean)).size;

    const metrics: DashboardMetrics = {
      date: formattedDate,
      totalSO: uniqueSoCount || soCount,
      totalDO: uniqueDos.size || orders.length,
      totalQty,
      totalQtyCAR,
      totalQtyPAC,
      totalQtyOther,
      qtyByUnit,
      totalSKU: uniqueSkus.size,
      totalBatches: uniqueTrips || batches.length,
      totalLines,
      matchedLines,
      qtyMismatchedLines,
      mismatchedLines,
      pendingLines,
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
      matchedPct,
      qtyMismatchedPct,
      mismatchedPct,
      pendingPct,
      swapInPlanCount,
      swapOutPlanCount,
    };

    return {
      metrics,
      batches,
      orders,
      mismatchedLines: mismatchedItems,
      soBatchDetails: allBatchDetails,
      rawDataCount: rawItems.length,
    };
  }

  private getTodayIso(): string {
    return `${getTodayDateStr()}T00:00:00`;
  }
}
