import { getConfig } from './config';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function threshold(): number {
  try {
    return LEVELS[getConfig().LOG_LEVEL];
  } catch {
    return LEVELS.info;
  }
}

function safe(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function log(level: Level, msg: string, extra?: unknown) {
  if (LEVELS[level] < threshold()) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(extra !== undefined ? `${line} ${safe(extra)}\n` : `${line}\n`);
}

export const logger = {
  debug: (m: string, e?: unknown) => log('debug', m, e),
  info: (m: string, e?: unknown) => log('info', m, e),
  warn: (m: string, e?: unknown) => log('warn', m, e),
  error: (m: string, e?: unknown) => log('error', m, e),
};
