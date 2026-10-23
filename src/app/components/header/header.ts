import { Component, inject, signal, computed, ElementRef, HostListener } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { RouterModule, Router, NavigationEnd } from '@angular/router';
import { DateFilterService } from '../../services/date-filter.service';
import { getApiUrl } from '../../config/api.config';

interface CalendarDay {
  date: Date;
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
}

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [RouterModule],
  template: `
    <header class="app-header">
      <div class="header-container">
        <!-- Left Side: Brand Logo & Home Navigation -->
        <div class="left-section">
          <a routerLink="/" (click)="onNavDashboard()" class="brand-link">
            <div class="brand-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
                <path d="m3.3 7 8.7 5 8.7-5"/>
                <path d="M12 22V12"/>
              </svg>
            </div>
            <div class="brand-info">
              <span class="brand-title">Plan Batch to Picking</span>
              <span class="brand-sub">Dashboard</span>
            </div>
          </a>

          <!-- Navigation Menu (Desktop) -->
          <nav class="header-nav desktop-nav">
            <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" (click)="onNavDashboard()" class="nav-tab-btn" aria-label="หน้าหลักภาพรวม" title="หน้าหลักภาพรวม">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect width="7" height="9" x="3" y="3" rx="1"/>
                <rect width="7" height="5" x="14" y="3" rx="1"/>
                <rect width="7" height="9" x="14" y="12" rx="1"/>
                <rect width="7" height="5" x="3" y="16" rx="1"/>
              </svg>
              <span>ภาพรวม</span>
            </a>
            <a routerLink="/so-batches" routerLinkActive="active" class="nav-tab-btn" aria-label="รายละเอียด Batch ตาม SO" title="รายละเอียดเลข Batch ทั้งหมดตาม SO">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                <rect width="8" height="4" x="8" y="2" rx="1"/>
                <path d="M9 12h6"/>
                <path d="M9 16h6"/>
              </svg>
              <span>รายละเอียด Batch ตาม SO</span>
            </a>
            <a routerLink="/out-dhl" [class.active]="isOutDhlActive()" class="nav-tab-btn" aria-label="ข้อมูลนอกเหนือจากระบบ TMS" title="ข้อมูลนอกเหนือจากระบบ TMS">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/>
                <path d="M15 18H9"/>
                <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/>
                <circle cx="17" cy="18" r="2"/>
                <circle cx="7" cy="18" r="2"/>
              </svg>
              <span>ข้อมูลนอกเหนือจากระบบ TMS</span>
            </a>
          </nav>
        </div>

        <!-- Right Side: Action Button & Interactive Calendar Date Selector -->
        <div class="right-section">
          <!-- Button กราฟเส้น (Icon Only) ข้างปฏิทิน -->
          <a
            routerLink="/trends"
            routerLinkActive="active"
            class="header-btn-chart"
            title="ดูกราฟเส้นเปรียบเทียบแนวโน้มภาพรวม, ยอดตรง Plan และยอดไม่ตรง Plan"
            aria-label="ดูกราฟเส้นแนวโน้ม"
          >
            <div class="chart-btn-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
                <polyline points="16 7 22 7 22 13"/>
              </svg>
            </div>
          </a>

          <!-- Button ดึงข้อมูลใหม่ -->
          <button
            type="button"
            class="header-btn-sync"
            aria-label="ดึงข้อมูลใหม่"
            [disabled]="dateService.isSyncing()"
            (click)="forceSyncCurrentDate()"
            title="ดึงข้อมูลใหม่ล่าสุดจาก 3 ระบบ (S3, MS SQL, SAP) สำหรับวันที่เลือกในปฏิทิน (Backend มีระบบดึงข้อมูลอัตโนมัติทุกๆ 30 นาที)"
          >
            <div class="sync-icon" [class.spin]="dateService.isSyncing()">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                <path d="M16 16h5v5"/>
              </svg>
            </div>
            <span>{{ dateService.isSyncing() ? 'กำลังดึงข้อมูล...' : 'ดึงข้อมูลใหม่' }}</span>
          </button>

          <div class="calendar-wrapper" #calendarDropdown>
            <!-- Date Display Button (Shows only the selected date by default) -->
            <button
              type="button"
              class="date-picker-trigger"
              [class.open]="isCalendarOpen()"
              (click)="toggleCalendar()"
              aria-label="เลือกวันที่"
            >
              <div class="cal-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect width="18" height="18" x="3" y="4" rx="2" ry="2"/>
                  <line x1="16" x2="16" y1="2" y2="6"/>
                  <line x1="8" x2="8" y1="2" y2="6"/>
                  <line x1="3" x2="21" y1="10" y2="10"/>
                </svg>
              </div>

              <!-- Only the date is shown here -->
              <span class="date-text">{{ dateService.shortDateLabel() }}</span>

              @if (dateService.isToday()) {
                <span class="today-tag">วันนี้</span>
              }

              <div class="chevron-icon" [class.rotated]="isCalendarOpen()">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m6 9 6 6 6-6"/>
                </svg>
              </div>
            </button>

            <!-- Calendar Popover (Appears when clicked) -->
            @if (isCalendarOpen()) {
              <div class="calendar-popover">
                <!-- Month & Year Navigation Header -->
                <div class="cal-popover-header">
                  <button type="button" class="nav-month-btn" (click)="prevMonth()" title="เดือนก่อนหน้า">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="m15 18-6-6 6-6"/>
                    </svg>
                  </button>

                  <span class="month-label">{{ currentMonthLabel() }}</span>

                  <button type="button" class="nav-month-btn" (click)="nextMonth()" title="เดือนถัดไป">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="m9 18 6-6-6-6"/>
                    </svg>
                  </button>
                </div>

                <!-- Days of Week Header -->
                <div class="weekdays-grid">
                  <span>อา</span>
                  <span>จ</span>
                  <span>อ</span>
                  <span>พ</span>
                  <span>พฤ</span>
                  <span>ศ</span>
                  <span>ส</span>
                </div>

                <!-- Days Grid -->
                <div class="days-grid">
                  @for (day of calendarDays(); track day.date.getTime()) {
                    <button
                      type="button"
                      class="day-btn"
                      [class.not-current]="!day.isCurrentMonth"
                      [class.today]="day.isToday"
                      [class.selected]="day.isSelected"
                      (click)="selectDay(day.date)"
                    >
                      {{ day.dayNumber }}
                    </button>
                  }
                </div>

                <!-- Quick Action Shortcuts -->
                <div class="cal-popover-footer">
                  <button type="button" class="quick-btn" (click)="selectToday()">
                    วันนี้
                  </button>
                  <button type="button" class="quick-btn" (click)="selectYesterday()">
                    เมื่อวาน
                  </button>
                  <button type="button" class="close-btn" (click)="isCalendarOpen.set(false)">
                    ปิด
                  </button>
                </div>

                <!-- Format Variable Indicator -->
                <div class="cal-format-preview">
                  <span class="preview-lbl">ตัวแปรระบบ:</span>
                  <code class="preview-val">{{ dateService.formattedDateTime() }}</code>
                </div>
              </div>
            }
          </div>

          <!-- Hamburger Menu Button (แสดงเฉพาะบนจอเล็ก <= 1120px) -->
          <button
            type="button"
            class="hamburger-btn"
            [class.open]="isMobileMenuOpen()"
            (click)="toggleMobileMenu()"
            aria-label="เปิดเมนูนำทาง"
            title="เมนูนำทาง (Navigation Menu)"
          >
            @if (isMobileMenuOpen()) {
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            } @else {
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="4" y1="6" x2="20" y2="6"/>
                <line x1="4" y1="12" x2="20" y2="12"/>
                <line x1="4" y1="18" x2="20" y2="18"/>
              </svg>
            }
          </button>
        </div>
      </div>

      <!-- Mobile Dropdown Navigation Menu (แสดง 3 แท็บเมื่อกดปุ่ม Hamburger) -->
      @if (isMobileMenuOpen()) {
        <div class="mobile-nav-backdrop" (click)="closeMobileMenu()"></div>
        <nav class="mobile-nav-drawer">
          <a
            routerLink="/"
            routerLinkActive="active"
            [routerLinkActiveOptions]="{ exact: true }"
            (click)="onNavDashboard(); closeMobileMenu()"
            class="mobile-nav-item"
            aria-label="หน้าหลักภาพรวม"
          >
            <div class="nav-item-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect width="7" height="9" x="3" y="3" rx="1"/>
                <rect width="7" height="5" x="14" y="3" rx="1"/>
                <rect width="7" height="9" x="14" y="12" rx="1"/>
                <rect width="7" height="5" x="3" y="16" rx="1"/>
              </svg>
            </div>
            <span class="nav-item-text">ภาพรวม</span>
            <span class="nav-item-arrow">→</span>
          </a>

          <a
            routerLink="/so-batches"
            routerLinkActive="active"
            (click)="closeMobileMenu()"
            class="mobile-nav-item"
            aria-label="รายละเอียด Batch ตาม SO"
          >
            <div class="nav-item-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
                <rect width="8" height="4" x="8" y="2" rx="1"/>
                <path d="M9 12h6"/>
                <path d="M9 16h6"/>
              </svg>
            </div>
            <span class="nav-item-text">รายละเอียด Batch ตาม SO</span>
            <span class="nav-item-arrow">→</span>
          </a>

          <a
            routerLink="/out-dhl"
            [class.active]="isOutDhlActive()"
            (click)="closeMobileMenu()"
            class="mobile-nav-item"
            aria-label="ข้อมูลนอกเหนือจากระบบ TMS"
          >
            <div class="nav-item-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/>
                <path d="M15 18H9"/>
                <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/>
                <circle cx="17" cy="18" r="2"/>
                <circle cx="7" cy="18" r="2"/>
              </svg>
            </div>
            <span class="nav-item-text">ข้อมูลนอกเหนือจากระบบ TMS</span>
            <span class="nav-item-arrow">→</span>
          </a>
        </nav>
      }
    </header>
  `,
  styles: [`
    .app-header {
      background: #064e3b;
      color: #f8fafc;
      border-bottom: 1px solid #065f46;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 4px 14px rgba(6, 78, 59, 0.25);
    }
    .header-container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 0 1.5rem;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .left-section {
      display: flex;
      align-items: center;
      gap: 1.5rem;
    }
    .brand-link {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: inherit;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .brand-icon {
      background: linear-gradient(135deg, #10b981 0%, #047857 100%);
      color: white;
      width: 36px;
      height: 36px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4);
      flex-shrink: 0;
    }
    .brand-info {
      display: flex;
      flex-direction: column;
      white-space: nowrap;
    }
    .brand-title {
      font-weight: 700;
      font-size: 1rem;
      color: #ffffff;
      line-height: 1.2;
      white-space: nowrap;
    }
    .brand-sub {
      font-size: 0.7rem;
      color: #a7f3d0;
      white-space: nowrap;
    }

    /* Navigation Menu */
    .header-nav {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-left: 0.5rem;
    }

    .nav-tab-btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 6px 14px;
      border-radius: 8px;
      background: rgba(6, 95, 70, 0.6);
      color: #ecfdf5;
      text-decoration: none;
      font-size: 0.8125rem;
      font-weight: 600;
      transition: all 0.2s ease;
      border: 1px solid rgba(4, 120, 87, 0.6);
      white-space: nowrap;
      flex-shrink: 0;

      &:hover {
        background: #047857;
        color: #6ee7b7;
        border-color: #10b981;
      }

      &.active {
        background: #10b981;
        color: #ffffff;
        border-color: #34d399;
        box-shadow: 0 2px 8px rgba(16, 185, 129, 0.35);
      }
    }

    /* Right Section: Actions & Calendar */
    .right-section {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .header-btn-chart {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      background: #065f46;
      color: #ecfdf5;
      border: 1px solid #047857;
      border-radius: 8px;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.2s ease;
      flex-shrink: 0;

      &:hover {
        background: #047857;
        border-color: #34d399;
        color: #ffffff;
        box-shadow: 0 0 0 2px rgba(52, 211, 153, 0.25);
      }

      &.active {
        background: #10b981;
        border-color: #34d399;
        color: #ffffff;
        box-shadow: 0 2px 8px rgba(16, 185, 129, 0.35);
      }
    }

    .chart-btn-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      color: #34d399;
    }

    .header-btn-chart.active .chart-btn-icon {
      color: #ffffff;
    }

    .header-btn-sync {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      background: #047857;
      color: #ffffff;
      border: 1px solid #10b981;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 0.8125rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      white-space: nowrap;

      &:hover:not(:disabled) {
        background: #059669;
        border-color: #34d399;
        box-shadow: 0 0 0 2px rgba(52, 211, 153, 0.25);
      }

      &:active:not(:disabled) {
        transform: translateY(1px);
      }

      &:disabled {
        opacity: 0.65;
        cursor: not-allowed;
      }
    }

    .sync-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      color: #6ee7b7;

      &.spin {
        animation: spin 1s linear infinite;
      }
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .auto-update-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(16, 185, 129, 0.18);
      border: 1px solid rgba(52, 211, 153, 0.6);
      color: #a7f3d0;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 5px 11px;
      border-radius: 20px;
      white-space: nowrap;
      animation: chipFadeIn 0.3s ease-out;

      .live-pulse {
        width: 7px;
        height: 7px;
        background-color: #34d399;
        border-radius: 50%;
        display: inline-block;
        box-shadow: 0 0 0 rgba(52, 211, 153, 0.7);
        animation: pulseLive 1.8s infinite;
      }
    }

    @keyframes pulseLive {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.7); }
      70% { transform: scale(1.1); box-shadow: 0 0 0 5px rgba(52, 211, 153, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
    }

    @keyframes chipFadeIn {
      from { opacity: 0; transform: translateY(-3px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .calendar-wrapper {
      position: relative;
    }

    /* Date Trigger Button */
    .date-picker-trigger {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      background: #065f46;
      color: #f8fafc;
      border: 1px solid #047857;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
      flex-shrink: 0;

      &:hover, &.open {
        background: #047857;
        border-color: #34d399;
        box-shadow: 0 0 0 2px rgba(52, 211, 153, 0.25);
      }
    }
    .cal-icon {
      color: #34d399;
      display: flex;
      align-items: center;
    }
    .date-text {
      color: #ffffff;
      font-family: inherit;
      letter-spacing: 0.01em;
    }
    .today-tag {
      font-size: 0.6875rem;
      background: #10b981;
      color: white;
      padding: 1px 6px;
      border-radius: 9999px;
      font-weight: 600;
    }
    .chevron-icon {
      color: #a7f3d0;
      display: flex;
      align-items: center;
      transition: transform 0.2s ease;
      &.rotated {
        transform: rotate(180deg);
      }
    }

    /* Calendar Popover */
    .calendar-popover {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      background: #ffffff;
      color: #0f172a;
      width: 300px;
      border-radius: 12px;
      box-shadow: 0 10px 25px -5px rgba(6, 78, 59, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
      border: 1px solid #d1fae5;
      padding: 1rem;
      z-index: 150;
      animation: fadeIn 0.15s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .cal-popover-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid #f1f5f9;
    }
    .month-label {
      font-weight: 700;
      font-size: 0.95rem;
      color: #064e3b;
    }
    .nav-month-btn {
      background: transparent;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      color: #475569;
      transition: all 0.15s;
      &:hover {
        background: #ecfdf5;
        color: #047857;
        border-color: #a7f3d0;
      }
    }

    .weekdays-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      text-align: center;
      font-size: 0.75rem;
      font-weight: 600;
      color: #94a3b8;
      margin-bottom: 6px;
    }

    .days-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 2px;
    }
    .day-btn {
      aspect-ratio: 1;
      border: none;
      background: transparent;
      border-radius: 6px;
      font-size: 0.8125rem;
      font-weight: 500;
      color: #1e293b;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;

      &:hover:not(.selected) {
        background: #ecfdf5;
      }
      &.not-current {
        color: #cbd5e1;
      }
      &.today {
        border: 1px solid #10b981;
        color: #047857;
        font-weight: 700;
      }
      &.selected {
        background: #059669;
        color: #ffffff !important;
        font-weight: 700;
      }
    }

    .cal-popover-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px solid #f1f5f9;
      gap: 6px;
    }
    .quick-btn {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 0.75rem;
      font-weight: 600;
      color: #334155;
      cursor: pointer;
      transition: all 0.15s;
      &:hover {
        background: #ecfdf5;
        color: #047857;
        border-color: #a7f3d0;
      }
    }
    .close-btn {
      margin-left: auto;
      background: none;
      border: none;
      color: #64748b;
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      padding: 4px 8px;
      &:hover {
        color: #047857;
        text-decoration: underline;
      }
    }

    .cal-format-preview {
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px dashed #d1fae5;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.6875rem;
      color: #047857;
    }
    .preview-val {
      font-family: monospace;
      background: #ecfdf5;
      color: #047857;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 700;
      font-size: 0.75rem;
      border: 1px solid #a7f3d0;
    }

    /* ================= Hamburger Menu & Mobile Drawer ================= */
    .hamburger-btn {
      display: none;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      padding: 0;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      color: #ffffff;
      cursor: pointer;
      transition: all 0.2s ease;
      flex-shrink: 0;
    }
    .hamburger-btn:hover {
      background: rgba(255, 255, 255, 0.18);
      border-color: rgba(255, 255, 255, 0.35);
      transform: translateY(-1px);
    }
    .hamburger-btn:active {
      transform: translateY(0);
    }
    .hamburger-btn.open {
      background: #059669;
      border-color: #34d399;
      box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.3);
    }

    /* Mobile Backdrop */
    .mobile-nav-backdrop {
      position: fixed;
      top: 64px;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(15, 23, 42, 0.45);
      backdrop-filter: blur(2px);
      z-index: 99;
    }

    /* Mobile Nav Drawer Dropdown */
    .mobile-nav-drawer {
      position: absolute;
      top: calc(100% + 8px);
      right: 1.25rem;
      width: calc(100% - 2.5rem);
      max-width: 340px;
      background: #064e3b;
      border: 1px solid rgba(52, 211, 153, 0.3);
      border-radius: 12px;
      padding: 8px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.4), 0 4px 10px rgba(0, 0, 0, 0.2);
      z-index: 101;
      display: flex;
      flex-direction: column;
      gap: 6px;
      animation: mobileNavFadeIn 0.18s ease-out;
    }

    @keyframes mobileNavFadeIn {
      from {
        opacity: 0;
        transform: translateY(-8px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .mobile-nav-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-radius: 8px;
      color: #e2e8f0;
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      transition: all 0.15s ease;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid transparent;
    }

    .mobile-nav-item:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #ffffff;
      transform: translateX(3px);
    }

    .mobile-nav-item.active {
      background: #059669;
      color: #ffffff;
      font-weight: 600;
      border-color: #34d399;
      box-shadow: 0 2px 8px rgba(5, 150, 105, 0.4);
    }

    .mobile-nav-item .nav-item-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.1);
      flex-shrink: 0;
    }

    .mobile-nav-item.active .nav-item-icon {
      background: rgba(255, 255, 255, 0.2);
    }

    .mobile-nav-item .nav-item-text {
      flex: 1;
    }

    .mobile-nav-item .nav-item-arrow {
      font-size: 1rem;
      opacity: 0.6;
      transition: transform 0.15s ease, opacity 0.15s ease;
    }

    .mobile-nav-item:hover .nav-item-arrow {
      transform: translateX(3px);
      opacity: 1;
    }

    /* ================= Responsive ================= */

    /* Laptop / Compact desktop (1121px - 1280px): tighten nav spacing to fit on 1 row */
    @media (max-width: 1280px) and (min-width: 1121px) {
      .header-container { padding: 0 1rem; }
      .left-section { gap: 0.75rem; }
      .header-nav { gap: 4px; margin-left: 0.25rem; }
      .nav-tab-btn { padding: 6px 10px; font-size: 0.78rem; gap: 5px; }
      .brand-title { font-size: 0.95rem; }
      .brand-sub { font-size: 0.65rem; }
      .header-btn-sync { padding: 6px 10px; font-size: 0.78rem; gap: 5px; }
      .date-picker-trigger { padding: 6px 10px; font-size: 0.8125rem; gap: 6px; }
    }

    /* Tablet & Medium screens (<= 1120px, including iPad Pro 1024px, 941px):
       Keep header on a single sleek 64px row, hide desktop nav tabs, and display hamburger button */
    @media (max-width: 1120px) {
      .desktop-nav {
        display: none !important;
      }
      .hamburger-btn {
        display: inline-flex !important;
      }
      .header-container {
        height: 64px;
        padding: 0 1rem;
      }
      .calendar-popover {
        max-width: calc(100vw - 2rem);
      }
    }

    /* Phone (<= 640px): icon-only sync button, slimmer controls */
    @media (max-width: 640px) {
      .header-container { padding: 0 0.75rem; }
      .brand-sub { display: none; }
      .right-section { gap: 6px; }
      .header-btn-sync { padding: 6px 8px; }
      .header-btn-sync span { display: none; }
      .date-picker-trigger { padding: 6px 8px; gap: 5px; font-size: 0.78rem; }
      .today-tag { display: none; }
      .brand-title { font-size: 0.875rem; }
      .mobile-nav-drawer {
        right: 0.75rem;
        width: calc(100% - 1.5rem);
      }
    }

    /* Very small phone (<= 420px): icon-only brand */
    @media (max-width: 420px) {
      .brand-info { display: none; }
    }
  `]
})
export class HeaderComponent {
  readonly dateService = inject(DateFilterService);
  private readonly http = inject(HttpClient);
  private readonly elRef = inject(ElementRef);
  private readonly router = inject(Router);

  // ROUTE-ALIAS-FIX: the Non-TMS page answers on both /out-dhl and /non-tms, but
  // routerLinkActive only matches the literal routerLink - /non-tms visitors got no
  // nav highlight. Track the URL and drive the active class ourselves.
  private readonly navUrl = toSignal(
    this.router.events.pipe(
      filter((ev): ev is NavigationEnd => ev instanceof NavigationEnd),
      map((ev) => ev.urlAfterRedirects)
    ),
    { initialValue: this.router.url }
  );
  isOutDhlActive(): boolean {
    const u = this.navUrl() || '';
    return u.startsWith('/out-dhl') || u.startsWith('/non-tms');
  }

  /**
   * ดึงและประมวลผลข้อมูลใหม่จาก 3 ระบบ (S3, MS SQL, SAP) สำหรับวันที่เลือกในปฏิทิน
   */
  forceSyncCurrentDate(): void {
    if (this.dateService.isSyncing()) return;
    const selectedIso = this.dateService.isoDate();
    if (!selectedIso) return;

    this.dateService.isSyncing.set(true);
    const cleanDate = selectedIso.includes('T') ? selectedIso.split('T')[0] : selectedIso.trim();
    const apiUrl = getApiUrl('/sync', { date: cleanDate, force: true });

    this.http.get<any>(apiUrl).subscribe({
      next: (res) => {
        this.dateService.isSyncing.set(false);
        this.dateService.triggerRefresh();
      },
      error: (err) => {
        this.dateService.isSyncing.set(false);
        this.dateService.triggerRefresh();
      }
    });
  }

  readonly isCalendarOpen = signal<boolean>(false);
  readonly isMobileMenuOpen = signal<boolean>(false);
  readonly viewDate = signal<Date>(new Date(this.dateService.selectedDate()));

  toggleMobileMenu(): void {
    this.isMobileMenuOpen.update(v => !v);
    if (this.isMobileMenuOpen()) {
      this.isCalendarOpen.set(false);
    }
  }

  closeMobileMenu(): void {
    this.isMobileMenuOpen.set(false);
  }

  readonly currentMonthLabel = computed(() => {
    const d = this.viewDate();
    const thaiMonths = [
      'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
      'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
    ];
    return `${thaiMonths[d.getMonth()]} ${d.getFullYear() + 543}`;
  });

  readonly calendarDays = computed<CalendarDay[]>(() => {
    const vDate = this.viewDate();
    const selected = this.dateService.selectedDate();
    const today = new Date();

    const year = vDate.getFullYear();
    const month = vDate.getMonth();

    const firstDayIndex = new Date(year, month, 1).getDay();
    const totalDaysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    const days: CalendarDay[] = [];

    // Previous month padding days
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const d = new Date(year, month - 1, prevMonthDays - i);
      days.push({
        date: d,
        dayNumber: d.getDate(),
        isCurrentMonth: false,
        isToday: this.isSameDay(d, today),
        isSelected: this.isSameDay(d, selected),
      });
    }

    // Current month days
    for (let i = 1; i <= totalDaysInMonth; i++) {
      const d = new Date(year, month, i);
      days.push({
        date: d,
        dayNumber: i,
        isCurrentMonth: true,
        isToday: this.isSameDay(d, today),
        isSelected: this.isSameDay(d, selected),
      });
    }

    // Next month padding days to fill 42 cells (6 rows * 7 cols)
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      const d = new Date(year, month + 1, i);
      days.push({
        date: d,
        dayNumber: i,
        isCurrentMonth: false,
        isToday: this.isSameDay(d, today),
        isSelected: this.isSameDay(d, selected),
      });
    }

    return days;
  });

  toggleCalendar() {
    this.closeMobileMenu();
    this.viewDate.set(new Date(this.dateService.selectedDate()));
    this.isCalendarOpen.update(v => !v);
  }

  prevMonth() {
    this.shiftMonth(-1);
  }

  nextMonth() {
    this.shiftMonth(1);
  }

  /**
   * BUG-FIX: the two buttons used to do `cur.setMonth(cur.getMonth() +/- 1)` on a
   * date that still carried the selected day-of-month. On the 29th-31st that
   * overflows ("Feb 31" is normalised to Mar 3), so pressing Prev/Next appeared to
   * skip or repeat a month. Rebuilding with day = 1 can never overflow, and the
   * month grid only ever reads year/month from this signal, so nothing is lost.
   */
  private shiftMonth(delta: number) {
    const cur = new Date(this.viewDate());
    this.viewDate.set(new Date(cur.getFullYear(), cur.getMonth() + delta, 1));
  }

  selectDay(d: Date) {
    this.dateService.setDate(d);
    this.isCalendarOpen.set(false);
  }

  selectToday() {
    this.dateService.setToday();
    this.viewDate.set(new Date());
    this.isCalendarOpen.set(false);
  }

  selectYesterday() {
    this.dateService.setYesterday();
    const d = new Date();
    d.setDate(d.getDate() - 1);
    this.viewDate.set(d);
    this.isCalendarOpen.set(false);
  }

  onNavDashboard() {
    // keep the user's selected date (no reset to yesterday) — just
    // re-fetch data so the overview is fresh for the chosen day
    this.dateService.triggerRefresh();
  }

  private isSameDay(d1: Date, d2: Date): boolean {
    return (
      d1.getDate() === d2.getDate() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getFullYear() === d2.getFullYear()
    );
  }

  // Click outside to close calendar popover and mobile menu
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.isCalendarOpen() && !this.elRef.nativeElement.contains(event.target)) {
      this.isCalendarOpen.set(false);
    }
    if (this.isMobileMenuOpen() && !this.elRef.nativeElement.contains(event.target)) {
      this.isMobileMenuOpen.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  onEscapePress() {
    this.isCalendarOpen.set(false);
    this.isMobileMenuOpen.set(false);
  }
}
