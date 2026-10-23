import { Injectable, signal, computed } from '@angular/core';
import { getApiUrl } from '../config/api.config';

@Injectable({
  providedIn: 'root',
})
export class DateFilterService {
  // Current selected date object signal (defaults to วันปัจจุบัน)
  readonly selectedDate = signal<Date>(new Date());

  /**
   * ตัวแปรจัดเก็บวันที่ในรูปแบบ "YYYY-MM-DDTHH:mm:ss" เช่น "2026-09-17T00:00:00"
   */
  readonly formattedDateTime = computed(() => {
    return this.formatToDateTimeString(this.selectedDate());
  });

  /**
   * สถานะการซิงค์ข้อมูลใหม่จาก 3 ระบบ (S3, MSSQL, SAP)
   */
  readonly isSyncing = signal<boolean>(false);

  /**
   * ตัวแปร Trigger เพื่อแจ้งเตือน Component ทุกหน้าให้โหลดข้อมูลใหม่ทันที
   */
  readonly refreshTrigger = signal<number>(0);

  /**
   * ข้อมูลการอัปเดตอัตโนมัติล่าสุด เช่น "อัปเดตข้อมูลอัตโนมัติแล้ว (11:30 น.)"
   */
  readonly lastAutoUpdateInfo = signal<string | null>(null);

  /**
   * สั่งให้ Component ทุกหน้าทำการรีเฟรชข้อมูล
   */
  triggerRefresh(): void {
    this.refreshTrigger.update(n => n + 1);
  }

  // Short format for header button, e.g. "10 ก.ย. 2026"
  readonly shortDateLabel = computed(() => {
    const d = this.selectedDate();
    const day = d.getDate();
    const thaiMonths = [
      'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
      'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
    ];
    const month = thaiMonths[d.getMonth()];
    const year = d.getFullYear();
    return `${day} ${month} ${year}`;
  });

  // Long Thai format for dashboard banner, e.g. "วันพฤหัสบดีที่ 10 กันยายน 2569"
  readonly fullDateLabel = computed(() => {
    const d = this.selectedDate();
    const thaiDays = [
      'วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์'
    ];
    const thaiFullMonths = [
      'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
      'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
    ];
    const dayName = thaiDays[d.getDay()];
    const day = d.getDate();
    const month = thaiFullMonths[d.getMonth()];
    const yearTh = d.getFullYear() + 543;
    return `${dayName}ที่ ${day} ${month} ${yearTh}`;
  });

  // ISO date string (YYYY-MM-DD)
  readonly isoDate = computed(() => {
    const d = this.selectedDate();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  });

  // Is today selected?
  readonly isToday = computed(() => {
    const sel = this.selectedDate();
    const today = new Date();
    return (
      sel.getDate() === today.getDate() &&
      sel.getMonth() === today.getMonth() &&
      sel.getFullYear() === today.getFullYear()
    );
  });

  /**
   * ฟังก์ชันแปลง Date เป็นรูปแบบ "YYYY-MM-DDTHH:mm:ss" (เช่น "2026-08-01T00:00:00")
   */
  formatToDateTimeString(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}T00:00:00`;
  }

  setDate(d: Date): void {
    const newDate = new Date(d);
    this.selectedDate.set(newDate);
    this.lastKnownSnapshotMtime = 0;
    this.triggerRefresh();
  }

  setToday(): void {
    this.setDate(new Date());
  }

  setYesterday(): void {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    this.setDate(d);
  }

  shiftDay(delta: number): void {
    const cur = new Date(this.selectedDate());
    cur.setDate(cur.getDate() + delta);
    this.setDate(cur);
  }

  private lastKnownSnapshotMtime = 0;
  private lastRefreshTriggerTime = 0;
  private sseSource?: EventSource;
  private pollTimer?: any;
  private toastClearTimer?: any;

  constructor() {
    this.initLiveUpdateWatcher();
  }

  private initLiveUpdateWatcher(): void {
    if (typeof window === 'undefined') return;

    // 1. เชื่อมต่อ Server-Sent Events (SSE) เพื่อรับ Event ทันทีที่ Backend ซิงค์เสร็จ
    this.connectEventSource();

    // 2. ตั้งเวลาสำรอง (Polling) ทุกๆ 30 วินาที ตรวจสอบการเปลี่ยนแปลงของข้อมูล
    this.pollTimer = setInterval(() => {
      this.pollCheckSnapshotUpdate();
    }, 30000);
  }

  private connectEventSource(): void {
    if (typeof EventSource === 'undefined') return;

    try {
      const url = getApiUrl('/events');
      this.sseSource = new EventSource(url);

      this.sseSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && data.type === 'DATA_SYNC_COMPLETED') {
            this.handleDataSyncEvent(data);
          }
        } catch { /* ignore */ }
      };

      this.sseSource.onerror = () => {
        // EventSource มีระบบ auto-reconnect ในตัว
      };
    } catch {
      // fallback to polling
    }
  }

  private handleDataSyncEvent(data: { date: string; isDataChanged: boolean }): void {
    const curDate = this.isoDate();
    // ถ้าวันที่ในหน้าจอตรงกับวันที่ที่มีการซิงค์ข้อมูล
    if (curDate === data.date && data.isDataChanged) {
      const now = Date.now();
      // ป้องกันการโหลดซ้ำถี่เกินไป (debounce / throttle 3 วินาที)
      if (now - this.lastRefreshTriggerTime < 3000) {
        console.log(`[AutoUpdate] ⏳ ข้อมูลวันที่ ${data.date} เพิ่งได้รับการโหลดไป ข้ามการสั่งรีเฟรชซ้ำ`);
        return;
      }
      this.lastRefreshTriggerTime = now;
      const timeStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
      console.log(`[AutoUpdate] 🔄 ข้อมูลวันที่ ${data.date} มีการเปลี่ยนแปลง -> โหลดข้อมูลใหม่ขึ้นหน้าจอทันที (${timeStr})`);
      this.notifyAutoUpdated(timeStr);
      this.triggerRefresh();
    } else if (curDate === data.date && !data.isDataChanged) {
      console.log(`[AutoUpdate] ℹ️ ข้อมูลวันที่ ${data.date} ดึงรอบใหม่แล้ว แต่ข้อมูลเดิมไม่มีการเปลี่ยนแปลง`);
    }
  }

  private pollCheckSnapshotUpdate(): void {
    const curDate = this.isoDate();
    if (!curDate) return;

    const url = getApiUrl('/sync/version', { date: curDate });
    fetch(url)
      .then(res => res.json())
      .then(data => {
        if (data && data.fileMtime) {
          if (this.lastKnownSnapshotMtime === 0) {
            this.lastKnownSnapshotMtime = data.fileMtime;
          } else if (data.fileMtime > this.lastKnownSnapshotMtime) {
            this.lastKnownSnapshotMtime = data.fileMtime;
            const timeStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
            console.log(`[AutoUpdate Poll] 🔄 ตรวจพบไฟล์ข้อมูลเปลี่ยนใหม่ -> สั่งรีเฟรชหน้าจออัตโนมัติ (${timeStr})`);
            this.notifyAutoUpdated(timeStr);
            this.triggerRefresh();
          }
        }
      })
      .catch(() => undefined);
  }

  private notifyAutoUpdated(timeStr: string): void {
    this.lastAutoUpdateInfo.set(`อัปเดตข้อมูลอัตโนมัติแล้ว (${timeStr} น.)`);
    if (this.toastClearTimer) clearTimeout(this.toastClearTimer);
    // แสดง badge 12 วินาทีแล้วค่อยซ่อน
    this.toastClearTimer = setTimeout(() => {
      this.lastAutoUpdateInfo.set(null);
    }, 12000);
  }
}
