import { createServer, type Server } from 'node:http';
import { logger } from './logger';

/**
 * Tiny HTTP control surface for the browserless runner.
 *
 *   GET  /health  (or /healthz, /)  → 200 + status. Ping this from an external
 *                                     uptime service to keep a Render free Web
 *                                     Service awake (it sleeps after ~15m idle).
 *   GET/POST /run                   → trigger a fetch+OCR+DB cycle on demand.
 *                                     202 if started, 409 if one's already running.
 *
 * The server runs alongside the interval loop in the same process, so a Render
 * Web Service both auto-fetches on a timer AND responds to pings/manual runs.
 */
export interface ServerHooks {
  port: number;
  getStatus: () => Record<string, unknown>;
  /** returns {started} — false if a cycle is already in progress */
  triggerRun: () => { started: boolean };
}

export function startApiServer(h: ServerHooks): Server {
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };

    if (url === '/health' || url === '/healthz' || url === '/') {
      return json(200, { ok: true, ...h.getStatus() });
    }
    if (url === '/run' && (req.method === 'GET' || req.method === 'POST')) {
      const { started } = h.triggerRun();
      if (!started) return json(409, { ok: false, busy: true, message: 'a cycle is already running' });
      return json(202, { ok: true, started: true, message: 'cycle started — poll /health for results' });
    }
    return json(404, { ok: false, error: 'not found', endpoints: ['/health', '/run'] });
  });

  server.listen(h.port, () => logger.info(`http server on :${h.port} — GET /health, GET|POST /run`));
  return server;
}
