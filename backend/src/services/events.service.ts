import { Response } from 'express';
import { createLogger } from '../utils/logger.js';

const log = createLogger('events');

export interface DataUpdateEvent {
  type: 'DATA_SYNC_COMPLETED';
  date: string;
  isDataChanged: boolean;
  timestamp: number;
}

export class EventsService {
  private clients = new Set<Response>();

  constructor() {
    // ส่ง Ping Keep-Alive ทุกๆ 25 วินาที เพื่อไม่ให้ Proxy/Firewall ตัดการเชื่อมต่อ SSE
    setInterval(() => {
      this.sendKeepAlive();
    }, 25000).unref();
  }

  /**
   * เพิ่ม client SSE เข้าสู่ระบบ
   */
  public addClient(res: Response): void {
    this.clients.add(res);
    log.info(`Client เชื่อมต่อ SSE สำเร็จ (จำนวน Client ปัจจุบัน: ${this.clients.size})`);

    // ส่งข้อความต้อนรับยืนยันการเชื่อมต่อ
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', message: 'SSE Connection Established' })}\n\n`);
  }

  /**
   * ลบ client ออกเมื่อตัดการเชื่อมต่อ
   */
  public removeClient(res: Response): void {
    this.clients.delete(res);
  }

  /**
   * ส่ง Keep-Alive Ping
   */
  private sendKeepAlive(): void {
    if (this.clients.size === 0) return;
    for (const client of this.clients) {
      try {
        client.write(': ping\n\n');
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * กระจายแจ้งเตือนเหตุการณ์ไปยังทุก Client ที่เชื่อมต่ออยู่
   */
  public broadcastDataUpdate(date: string, isDataChanged: boolean): void {
    const eventData: DataUpdateEvent = {
      type: 'DATA_SYNC_COMPLETED',
      date,
      isDataChanged,
      timestamp: Date.now(),
    };

    const message = `data: ${JSON.stringify(eventData)}\n\n`;
    log.info(`บรอดแคสต์แจ้งเตือนข้อมูลอัปเดต (${date}, changed=${isDataChanged}) ไปยัง ${this.clients.size} clients`);

    for (const client of this.clients) {
      try {
        client.write(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

export const eventsService = new EventsService();
