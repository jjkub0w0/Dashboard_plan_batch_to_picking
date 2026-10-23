import { config } from '../config/config.js';
import { fetchWithTimeout } from '../utils/http.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sap');

export interface SapItem {
  ReferenceSDDocument: string;
  Vbeln: string;
  DistributionChannel: string;
  ActualDeliveryQuantity: string | number;
  DeliveryQuantityUnit?: string;
  RegionName: string;
  Material: string;
  ReferenceSDDocumentItem: string;
  Batch: string;
  ShipToParty?: string;
  ShipToFullName?: string;
  [key: string]: any;
}

/**
 * ตัดอักษาที่อาจใชทใน OData filter string ได (single quote) ออกไป
 * กัน filter injection ผาน DO number ที่มาจาก request body/query
 * (ปจจบุ น Vbeln เปนตัวเลขเทานั้ น — คุมดวย regex ที่นอกเหนือนจาก escape)
 */
function safeVbeln(vbeln: string): string | null {
  const clean = String(vbeln || '').trim().replace(/'/g, "''");
  return /^[0-9A-Za-z]+$/.test(clean) ? clean : null;
}

/**
 * ดึงขอมูลจาก SAP Fiori (ZI_PICKANDLOAD06A) ตาม Vbeln (DO) ทีละ 1 DO แบบ workQueue ขนานตาม concurrency
 * พร้อมตัดขอมูลที่ซ้ำออก (ReferenceSDDocument,Vbeln,DistributionChannel,ActualDeliveryQuantity,
 * RegionName,Material,ReferenceSDDocumentItem,Batch)
 *
 * STAB-FIX: แตละ request ตองตอบภายใน config.sap.timeout (default 30s) + retry 2 ครั้ง
 * เดิมใช fetch() ธรรมดานตอง micro 30s ทาให request คางถาวร + socket สะสม (leak) ถา SAP โหลดชา
 */
export async function fetchSapDataByVbeln(
  uniqueVbelnList: string[],
  dateStr: string,
  concurrencyLimit?: number
): Promise<SapItem[]> {
  const baseUrl = config.sap.baseUrl + '/' + config.sap.entitySet;
  const username = config.sap.username;
  const password = config.sap.password;
  if (!username || !password) {
    throw new Error('ไมพบ SAP credentials (FIORI_USERNAME/FIORI_PASSWORD) ใน .env — ข้ามการดึงขอมูล SAP');
  }
  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  // validate/format date กอนใชใน OData filter (กันสตริงแปลกปลอมเขามาลงใน $filter)
  const cleanDateMatch = (dateStr || '').trim().match(/^\d{4}-\d{2}-\d{2}/);
  if (!cleanDateMatch) {
    throw new Error(`รูแบบวันทไ มถูกรตองสำหรับ SAP query (ตองเปน YYYY-MM-DD): "${dateStr}"`);
  }
  const cleanDate = cleanDateMatch[0];
  const CONCURRENCY = Math.max(1, concurrencyLimit || config.sap.concurrency || 2);

  log.info(`เริ่ มกระบวนการดึงขอมูลจาก SAP Fiori ตาม Vbeln (DO) ขนาน ${CONCURRENCY} ท่อ, ทังหมด ${uniqueVbelnList.length} DOs, LoadingDate=${cleanDate}`);

  const rawResults: SapItem[][] = new Array(uniqueVbelnList.length);
  let currentIndex = 0;
  const startTime = Date.now();
  let skippedInvalid = 0;

  async function fetchWorker(workerId: number): Promise<void> {
    while (currentIndex < uniqueVbelnList.length) {
      const i = currentIndex++;
      const vbeln = uniqueVbelnList[i];
      const seq = `[${i + 1}/${uniqueVbelnList.length}]`;

      const safeValue = safeVbeln(vbeln);
      if (!safeValue) {
        skippedInvalid++;
        log.warn(`(ท่อ ${workerId}) ${seq} ข้าม Vbeln ที่รูแบบไมถูกรตอง: "${String(vbeln).slice(0, 40)}"`);
        rawResults[i] = [];
        continue;
      }

      const filterQuery = `Vbeln eq '${safeValue}' and LoadingDate eq datetime'${cleanDate}T00:00:00'`;
      const url = `${baseUrl}?$format=json&$filter=${encodeURIComponent(filterQuery)}&$select=ReferenceSDDocument,Vbeln,DistributionChannel,ActualDeliveryQuantity,DeliveryQuantityUnit,RegionName,Material,ReferenceSDDocumentItem,Batch,ShipToFullName,ShipToParty`;

      const reqStart = Date.now();
      try {
        const response = await fetchWithTimeout(
          url,
          {
            method: 'GET',
            headers: {
              'Authorization': authHeader,
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            },
          },
          { timeoutMs: config.sap.timeout, retries: 2 }
        );

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          log.error(`(ท่อ ${workerId}) ${seq} SAP Error (HTTP ${response.status}): ${errText.slice(0, 200)}`);
          rawResults[i] = [];
          continue;
        }

        const json: any = await response.json();
        const items = json.d?.results || json.value || [];
        rawResults[i] = items;

        const duration = Date.now() - reqStart;
        log.debug(`(ท่อ ${workerId}) ${seq} ดึงสำเร็จ: ${items.length} รายการ (ใชเวลา ${duration} ms)`);
      } catch (err: any) {
        // timeout/failed retry => store [] and keep the pipeline running (graceful degradation)
        log.error(`(ท่อ ${workerId}) ${seq} ผิดพลาด: ${err.message}`);
        rawResults[i] = [];
      }
    }
  }

  // รัน Worker แบบขนานตามจำนวน CONCURRENCY
  const workers = Array.from({ length: Math.min(CONCURRENCY, uniqueVbelnList.length || 1) }, (_, id) =>
    fetchWorker(id + 1)
  );
  await Promise.all(workers);

  const flatRawItems = rawResults.flat().filter(Boolean);
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

  // ---------------------------------------------------------------------------
  // จดัการขอมูลกอนจัดเก็บ (Deduplication):
  // ถา ReferenceSDDocument,Vbeln,DistributionChannel,ActualDeliveryQuantity,
  // RegionName,Material,ReferenceSDDocumentItem,Batch ตรงกันทกตัว ให skip ออก เก็บแคตัวแรก
  // ---------------------------------------------------------------------------
  const seenKeys = new Set<string>();
  const sapdata: SapItem[] = [];

  for (const item of flatRawItems) {
    const dedupKey = [
      String(item.ReferenceSDDocument || '').trim(),
      String(item.Vbeln || '').trim(),
      String(item.DistributionChannel || '').trim(),
      String(item.ActualDeliveryQuantity || '').trim(),
      String(item.DeliveryQuantityUnit || '').trim(),
      String(item.RegionName || '').trim(),
      String(item.Material || '').trim(),
      String(item.ReferenceSDDocumentItem || '').trim(),
      String(item.Batch || '').trim()
    ].join('|');

    if (seenKeys.has(dedupKey)) {
      continue; // skip ซ้ำ เก็บเฉพาะตัวแรก
    }

    seenKeys.add(dedupKey);
    sapdata.push(item);
  }

  log.info(
    `ดึงขอมูลจาก SAP ครบทั้งหมด ${uniqueVbelnList.length} DOs เรียบรอย — ` +
    `ดิบ ${flatRawItems.length} แถว, หลังตัดซ้ำ ${sapdata.length} แถว ` +
    `(ตัดออก ${flatRawItems.length - sapdata.length}, ข้าม Vbeln ผิดรูแบบ ${skippedInvalid}), ` +
    `เวลารวม ${totalDuration} วินาที`
  );

  return sapdata;
}
