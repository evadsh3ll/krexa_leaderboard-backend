import 'dotenv/config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  GROQ_API_KEY: string;
  OCR_MODEL: string;
  CDP_URL: string;
  CAMPAIGN: string;
  QUERIES: string[];
  OCR: boolean;
  MAX_POSTS: number;
  MAX_IDLE_ROUNDS: number;
  INTERVAL_MIN: number;
  PORT: number;
  DATA_DIR: string;
  DATABASE_URL: string;
  WEBHOOK_URL: string;
  WEBHOOK_SECRET: string;
  LOG_LEVEL: LogLevel;
}

let cfg: Config | null = null;

export function getConfig(): Config {
  if (cfg) return cfg;
  const split = (v: string | undefined, dflt: string) =>
    (v ?? dflt).split(',').map((s) => s.trim()).filter(Boolean);
  cfg = {
    GROQ_API_KEY: process.env.GROQ_API_KEY ?? '',
    OCR_MODEL: process.env.OCR_MODEL ?? 'meta-llama/llama-4-scout-17b-16e-instruct',
    CDP_URL: process.env.BROWSER_CDP_URL ?? 'http://localhost:9222',
    CAMPAIGN: process.env.CAMPAIGN ?? 'krexa',
    QUERIES: split(process.env.QUERIES, '#KrexaBillChallenge,@krexa_xyz,#Krexa'),
    OCR: (process.env.OCR ?? 'true').toLowerCase() !== 'false',
    MAX_POSTS: Number(process.env.MAX_POSTS ?? 10_000),
    MAX_IDLE_ROUNDS: Number(process.env.MAX_IDLE_ROUNDS ?? 25),
    INTERVAL_MIN: Number(process.env.INTERVAL_MIN ?? 30),
    PORT: Number(process.env.PORT ?? 8080),
    DATA_DIR: process.env.DATA_DIR ?? 'data',
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    WEBHOOK_URL: process.env.WEBHOOK_URL ?? '',
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET ?? '',
    LOG_LEVEL: (process.env.LOG_LEVEL as LogLevel) ?? 'info',
  };
  if (cfg.OCR && !cfg.GROQ_API_KEY) {
    throw new Error('OCR=true but GROQ_API_KEY is missing — set it in .env or set OCR=false');
  }
  return cfg;
}
