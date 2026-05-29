import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from './config';
import { logger } from './logger';

/**
 * Tiny read-only HTTP server so the Krexa site (or anything) can pull the
 * current leaderboard without filesystem access:
 *
 *   GET /                  → index of endpoints
 *   GET /leaderboard.json  → the ranked leaderboard (site consumes this)
 *   GET /mentions.csv      → raw per-post CSV
 *   GET /healthz           → { ok, posts, authors, bills, updated_at }
 *
 * CORS is open (GET only) so a browser front-end can fetch it directly.
 */
export function startServer(): Server {
  const cfg = getConfig();
  const leaderboardPath = join(cfg.DATA_DIR, `${cfg.CAMPAIGN}_leaderboard.json`);
  const mentionsPath = join(cfg.DATA_DIR, `${cfg.CAMPAIGN}_campaign_mentions.csv`);

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET');

    const sendJson = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const sendFile = (path: string, type: string) => {
      if (!existsSync(path)) return sendJson(404, { error: 'not generated yet — first run pending' });
      res.writeHead(200, { 'content-type': type });
      res.end(readFileSync(path));
    };

    if (req.method !== 'GET') return sendJson(405, { error: 'GET only' });

    switch (url) {
      case '/':
        return sendJson(200, {
          service: 'krexa-bill-bot',
          campaign: cfg.CAMPAIGN,
          endpoints: ['/leaderboard.json', '/mentions.csv', '/healthz'],
        });
      case '/leaderboard.json':
        return sendFile(leaderboardPath, 'application/json');
      case '/mentions.csv':
        return sendFile(mentionsPath, 'text/csv');
      case '/healthz': {
        if (!existsSync(leaderboardPath)) return sendJson(200, { ok: true, ready: false });
        try {
          const lb = JSON.parse(readFileSync(leaderboardPath, 'utf8'));
          return sendJson(200, { ok: true, ready: true, ...lb.totals, updated_at: lb.updated_at });
        } catch {
          return sendJson(200, { ok: true, ready: false });
        }
      }
      default:
        return sendJson(404, { error: 'not found' });
    }
  });

  server.listen(cfg.PORT, () => logger.info(`http server on :${cfg.PORT} (GET /leaderboard.json /mentions.csv /healthz)`));
  return server;
}
