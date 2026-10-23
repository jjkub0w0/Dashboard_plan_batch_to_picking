export interface RawPickingItem {
  route: string;
  orderType: string;
  orderNum: string;
  do: string;
  customer: string;
  qty: number;
  match: boolean;
  batchStatus?: 'MATCH' | 'QTY_MISMATCH' | 'MISMATCH' | 'PENDING';
  itemCode: string;
  stdDesc: string;
  batchPlan: string;
  vrfyBatch: string;
  qtyRaw?: string | number;
  firstBatch?: Array<{ Batch: string; QTY: string | number }>;
  firstBatchStr?: string;
  sapBatch?: string;
  deliveryQuantityUnit?: string; // CAR, PAC, etc.
  item?: string; // ReferenceSDDocumentItem / ITEM
  shipToParty?: string;   // SAP ShipToParty (จำแนกกลุ่ Non-TMS)
  shipToFullName?: string; // SAP ShipToFullName (ชื่ือผู้รรับ)
  storageLocation?: string; // สrab StorageLocation (ถ้าวางแผนจะกรอง RT)
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
  deliveryQuantityUnit?: string; // CAR, PAC, etc.
  match: boolean;
  batchStatus?: 'MATCH' | 'QTY_MISMATCH' | 'MISMATCH' | 'PENDING';
  status: 'COMPLETED' | 'IN_PROGRESS' | 'PLANNED';
  item?: string; // ReferenceSDDocumentItem / ITEM
  shipToParty?: string;
  shipToFullName?: string;
  storageLocation?: string;
}

export interface DashboardMetrics {
  date: string;              // Format: YYYY-MM-DDTHH:mm:ss
  totalSO: number;           // ยอดรวม SO
  totalDO: number;           // ยอดรวม DO
  totalQty: number;          // ยอดรวม QTY รวมทั้งหมด
  totalQtyCAR: number;       // ยอดรวม QTY เฉพาะ CAR (ลัง)
  totalQtyPAC: number;       // ยอดรวม QTY เฉพาะ PAC (แพ็ค)
  totalQtyOther: number;     // ยอดรวม QTY หน่วยอื่นๆ (ถ้ามี)
  qtyByUnit: Record<string, { total: number; matched: number; mismatched: number }>; // สรุปแยกตามหน่วย
  totalSKU: number;          // ยอดรวม SKU
  totalBatches: number;      // Batch รวมทั้งหมด
  totalLines: number;        // จำนวนแถวรายการทั้งหมด
  matchedLines: number;      // จำนวนรายการที่จัดตรงตาม Batch ที่ Plan ไว้
  qtyMismatchedLines: number; // จำนวนรายการที่เลข Batch ตรงแต่ยอดไม่ตรง
  mismatchedLines: number;   // จำนวนรายการที่จัดตาม Batch ไม่ตรง
  pendingLines: number;      // จำนวนรายการที่รอข้อมูล SAP
  matchedQty: number;        // ยอดรวม QTY ที่จัดตรงตาม Batch ที่ Plan ไว้ (รวมทุกหน่วย)
  matchedQtyCAR: number;     // ยอดตรงตามแผน เฉพาะ CAR
  matchedQtyPAC: number;     // ยอดตรงตามแผน เฉพาะ PAC
  qtyMismatchedQty: number;  // ยอดรวม QTY ที่เลข Batch ตรงแต่ยอดไม่ตรง
  qtyMismatchedQtyCAR: number;
  qtyMismatchedQtyPAC: number;
  mismatchedQty: number;     // ยอดรวม QTY ที่จัดตาม Batch ไม่ตรง (รวมทุกหน่วย)
  mismatchedQtyCAR: number;  // ยอดสลับล็อต เฉพาะ CAR
  mismatchedQtyPAC: number;  // ยอดสลับล็อต เฉพาะ PAC
  pendingQty: number;        // ยอดรวม QTY ที่รอข้อมูล SAP
  pendingQtyCAR: number;     // ยอดรอ SAP เฉพาะ CAR
  pendingQtyPAC: number;     // ยอดรอ SAP เฉพาะ PAC
  matchedPct: number;        // % จัดตรงตามแผน
  qtyMismatchedPct: number;  // % จัดตรงตาม PlanBatch แต่ยอดไม่ตรง
  mismatchedPct: number;     // % สลับล็อต/ไม่ตรงตามแผน
  pendingPct: number;        // % รอข้อมูล SAP
  swapInPlanCount: number;   // สลับล็อตในแผน
  swapOutPlanCount: number;  // จ่ายล็อตนอกแผน
}

export interface BatchSummary {
  batchCode: string;
  soNumber?: string;
  doNumber?: string;
  route: string;
  customer?: string;
  orderType: 'SO' | 'POSTO';
  soCount: number;
  doCount: number;
  totalQty: number;
  totalQtyCAR: number;
  totalQtyPAC: number;
  skusCount: number;
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
  matchedLines: number;
  qtyMismatchedLines?: number;
  mismatchedLines: number;
  pendingLines?: number;
  matchRate: number;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'PLANNED';
  qtyByUnit?: Record<string, number>;
  batchDetails?: SoBatchDetailItem[];
}

export interface OrderSummary {
  route: string;
  orderType: string;
  orderNum: string;
  do: string;
  customer: string;
  rows: number;
  totalQty: number;
  totalQtyCAR: number;
  totalQtyPAC: number;
  qtyByUnit?: Record<string, number>;
  matches: number;
  changed: number;
  matchPct: number;
}

export interface MismatchedLineItem {
  route: string;
  orderType: string;
  orderNum: string;
  do: string;
  customer: string;
  itemCode: string;
  stdDesc: string;
  batchPlan: string;
  vrfyBatch: string;
  qty: number;
  swapType: 'สลับล็อตในแผน' | 'จ่ายล็อตนอกแผน';
}

export interface CalculationResult {
  metrics: DashboardMetrics;
  batches: BatchSummary[];
  orders: OrderSummary[];
  mismatchedLines: MismatchedLineItem[];
  soBatchDetails?: SoBatchDetailItem[];
  rawDataCount: number;
}
