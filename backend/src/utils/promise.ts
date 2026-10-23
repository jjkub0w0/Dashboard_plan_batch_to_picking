/**
 * Promise helpers used by the long-running pipelines.
 *
 * Why this exists: the sync pipeline (and anything else that can outlive the
 * HTTP request that started it) must ALWAYS settle. A promise that never
 * settles is worse than a failed one - the caller hangs, the in-flight
 * bookkeeping entry is never released, and the service slowly wedges itself
 * until someone restarts the process. See SyncService.syncAllByDate().
 */
import { createLogger } from './logger.js';

const log = createLogger('promise');

export interface WithTimeoutOptions {
  /** label used in the log/error message, e.g. "sync 2026-09-23" */
  label: string;
  /**
   * Keep running the underlying work after the deadline and only log the
   * outcome. Used where abandoning is impossible (the SQL/SAP calls cannot be
   * cancelled mid-flight) but the *caller* must be released anyway.
   */
  detach?: boolean;
}

/**
 * Reject with a clear error if `promise` has not settled within `ms`.
 *
 * Notes on safety:
 * - The original promise stays attached to the race, so a LATE rejection is
 *   still "handled" and never becomes an unhandledRejection (which could kill
 *   the server long after the job was supposed to be over).
 * - The timer is cleared as soon as the promise settles, so a fast call does
 *   not leave a pending timer keeping the event loop alive.
 *
 * @param promise the work to guard
 * @param ms      deadline in milliseconds (non-positive disables the guard)
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, opts: WithTimeoutOptions): Promise<T> {
  const { label, detach = true } = opts;
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  // Set only when the deadline actually fires - otherwise the slow-work log
  // below would also trigger for every healthy, on-time run.
  let timedOut = false;

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Sub-second budgets used to log "0 seconds" (Math.round of 20/1000), which
      // reads like a misconfigured timeout to whoever is debugging a frozen dashboard.
      const budget = ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`;
      const err = new Error(`${label} exceeded its ${budget} budget - the wait was cancelled`);
      log.error(`${err.message} (งานเดิมยังรันต่อเบื้องหลัง แต่ปล่อยคำขอไปแล้ว)`);
      reject(err);
    }, ms);
    // Do not let the watchdog itself keep a closing process alive.
    timer.unref?.();
  });

  if (detach) {
    // Observe the late outcome without swallowing it: the handlers here make
    // the rejection "handled", and we only report it once the guard fired.
    promise.then(
      () => {
        if (timedOut) log.warn(`${label} สำเร็จ AFTER watchdog — ผลไม่ถูกส่งให้ลูกค้าแล้ว (ถ้าเป็น sync ไฟล์ snapshot ยังเขียนครบถ้วน)`);
      },
      (err) => {
        if (timedOut) log.warn(`${label} ล้มเหลว AFTER watchdog: ${err?.message || err}`);
      }
    );
  }

  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
