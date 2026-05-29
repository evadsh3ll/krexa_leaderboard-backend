/**
 * Entry point for the Krexa bill-challenge bot.
 *
 *   tsx src/run.ts --once            one scrape+OCR cycle, write files, exit
 *   tsx src/run.ts --watch           loop every INTERVAL_MIN minutes (no server)
 *   tsx src/run.ts --serve           only serve existing data over HTTP, no scraping
 *   tsx src/run.ts --watch --serve   the production mode: loop AND serve (default)
 *
 * On a VPS this runs under pm2/systemd (see README). It connects to a logged-in
 * Chrome over CDP — the caller is responsible for keeping that Chrome alive.
 */
import { runOnce } from './scraper';
import { syncFromDisk } from './db';
import { publishLeaderboard } from './publish';
import { startServer } from './server';
import { getConfig } from './config';
import { sleep } from './human';
import { logger } from './logger';

async function cycle(): Promise<void> {
  try {
    const stats = await runOnce();
    await syncFromDisk(); // push to Postgres (no-op if DATABASE_URL unset)
    await publishLeaderboard(); // optional webhook (no-op if WEBHOOK_URL unset)
    logger.info(`cycle complete: ${JSON.stringify(stats)}`);
  } catch (e) {
    // never let one bad cycle kill the loop
    logger.error(`cycle failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const watchFlag = args.includes('--watch');
  const serveFlag = args.includes('--serve');
  const noFlags = !once && !watchFlag && !serveFlag;

  // default (no flags) = watch loop, pushing to the DB each cycle. The HTTP
  // server is opt-in via --serve (the site reads the DB, not the file server).
  const watch = watchFlag || noFlags;
  const serve = serveFlag;
  const cfg = getConfig();
  if (cfg.DATABASE_URL) logger.info('db sink: enabled (krexa_posts)');
  else logger.warn('db sink: DATABASE_URL not set — results go to files only');

  if (serve) startServer();

  // serve-only: a --serve with no scraping mode → just expose existing data
  if (serveFlag && !watch && !once) {
    logger.info('serve-only mode — not scraping; serving existing data');
    return; // the http server keeps the process alive
  }

  if (once) {
    await cycle();
    if (!serve) process.exit(0);
    return; // if also serving, stay up
  }

  // watch loop
  logger.info(`watch mode — scraping every ${cfg.INTERVAL_MIN} min`);
  for (;;) {
    await cycle();
    logger.info(`sleeping ${cfg.INTERVAL_MIN} min until next cycle`);
    await sleep(cfg.INTERVAL_MIN * 60_000);
  }
}

main().catch((e) => {
  logger.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
