import { spawn } from 'node:child_process';
import type { ApiPost } from './xapi';

/**
 * Fetch posts for a query by shelling out to collector.py (twscrape), which
 * handles X's x-client-transaction-id + rotating query ids. Returns the same
 * ApiPost shape the rest of the pipeline expects.
 *
 * Why a Python sidecar: X now requires a computed anti-bot transaction-id header
 * on every API call. twscrape already implements (and maintains) that generator;
 * shelling out to it is far more robust than re-porting ~300 lines of crypto/SVG
 * code to Node and keeping it current against X's changes.
 */
export function collectViaTwscrape(query: string, limit: number): Promise<ApiPost[]> {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', ['collector.py', query, String(limit)], { env: { ...process.env } });
    let out = '';
    let err = '';
    py.stdout.on('data', (d) => (out += d));
    py.stderr.on('data', (d) => (err += d)); // twscrape logs go here; ignored unless it fails
    py.on('error', (e) => reject(new Error(`could not run collector.py (is python3 + twscrape installed?): ${e.message}`)));
    py.on('close', (code) => {
      if (code === 3) {
        return reject(new Error('AUTH_FAILED: X session rejected (401/ban) — refresh X_AUTH_TOKEN & X_CT0 in .env'));
      }
      if (code !== 0) {
        return reject(new Error(`collector.py exited ${code}: ${err.trim().slice(-400)}`));
      }
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '[]';
      try {
        const arr = JSON.parse(line) as ApiPost[] | { error: string };
        if (!Array.isArray(arr)) return reject(new Error(`collector error: ${(arr as any).error ?? line}`));
        resolve(arr);
      } catch {
        reject(new Error(`collector.py did not return JSON: ${out.slice(0, 200)}`));
      }
    });
  });
}
