/**
 * Logger กลางของระบบ (เบา ๆ ไม่เพิม dependency ภายนอก)
 * - ระดับ log คุมผ่าน env LOG_LEVEL (error | warn | info | debug) เป็น info เสมอ
 * - ทกุ บรรท udp่ timestamp และ tag ของ module เพื่ อสะดวกตอการ grep/debug
 * - หนกั log error ไปท่ี stderr สว นอื่นไปท่ี stdout เพื่ อ log file แยก stream ได
 */
import { getBangkokIsoString } from './date.js';

type Level = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel(): number {
  const raw = String(process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  return LEVEL_ORDER[raw as Level] ?? LEVEL_ORDER.info;
}

// DEDUPE-FIX: was a hand-rolled copy of getBangkokIsoString() — a TZ fix applied to
// utils/date.ts used to silently miss every log line. Delegate to the single source.
function ts(): string {
  return getBangkokIsoString();
}

export interface Logger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

export function createLogger(scope: string): Logger {
  const log = (level: Level, stream: NodeJS.WriteStream, ...args: unknown[]) => {
    if (LEVEL_ORDER[level] > currentLevel()) return;
    stream.write(`[${ts()}] [${level.toUpperCase()}] [${scope}] ${args.map(formatArg).join(' ')}\n`);
  };
  return {
    error: (...a) => log('error', process.stderr, ...a),
    warn: (...a) => log('warn', process.stdout, ...a),
    info: (...a) => log('info', process.stdout, ...a),
    debug: (...a) => log('debug', process.stdout, ...a),
  };
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}
