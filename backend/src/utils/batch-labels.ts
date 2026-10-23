/**
 * The "no batch was planned" marker used across S3 / MSSQL / SAP data.
 *
 * MAINT-FIX: this literal was copy-pasted 49 times across three services, in two
 * spellings that differ ONLY by a trailing space:
 *   - "ไม่ได้ plant ไว้ "  (trailing space - the value written to the UI / snapshots)
 *   - "ไม่ได้ plant ไว้" (legacy value still present in older snapshot files)
 * A missing trailing space silently turns a "no plan" row into a "mismatch"
 * row, which is exactly the class of bug this module removes.
 */

/** display + stored value when nothing was planned (note the trailing space) */
export const NO_PLAN_BATCH = 'ไม่ได้ plant ไว้ ';

/** legacy spelling without the trailing space, still found in old snapshots */
export const NO_PLAN_BATCH_LEGACY = 'ไม่ได้ plant ไว้';

/** true when `code` is one of the two "no plan" spellings */
export function isNoPlanBatchCode(code: string): boolean {
  return code === NO_PLAN_BATCH || code === NO_PLAN_BATCH_LEGACY;
}

/**
 * true when `code` is a real batch code (non-empty and not a "no plan" marker).
 * Replaces the repeated `b !== '' && b !== ... && b !== ...` filter.
 */
export function isPlannedBatchCode(code: string): boolean {
  return code !== '' && !isNoPlanBatchCode(code);
}
