import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from './config';
import { logger } from './logger';

/**
 * Optional push: POST the leaderboard JSON to your site's ingest endpoint after
 * every run. Enabled by setting WEBHOOK_URL. The WEBHOOK_SECRET (if set) is sent
 * as the `x-webhook-secret` header so your site can verify the caller.
 *
 * No-op when WEBHOOK_URL is empty — in that case the site is expected to pull
 * from the built-in HTTP server instead.
 */
export async function publishLeaderboard(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.WEBHOOK_URL) return;

  const path = join(cfg.DATA_DIR, `${cfg.CAMPAIGN}_leaderboard.json`);
  if (!existsSync(path)) {
    logger.warn('publish: leaderboard.json not found — skipping webhook');
    return;
  }
  const body = readFileSync(path, 'utf8');
  try {
    const res = await fetch(cfg.WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.WEBHOOK_SECRET ? { 'x-webhook-secret': cfg.WEBHOOK_SECRET } : {}),
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) logger.info(`publish: POSTed leaderboard to ${cfg.WEBHOOK_URL} (${res.status})`);
    else logger.warn(`publish: webhook returned ${res.status} ${res.statusText}`);
  } catch (e) {
    logger.warn(`publish: webhook failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}
