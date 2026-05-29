import type { Page } from 'patchright';

/**
 * Human-behaviour primitives for the scroll loop. The point is not perfection —
 * it is to avoid uniform timing, the dead giveaway of naive automation. Pauses
 * and scrolls use randomised / log-normal delays.
 */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const rand = (min: number, max: number) => Math.random() * (max - min) + min;
export const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));

/** Standard normal (Box–Muller). */
export function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Log-normal sample in ms — human inter-action delays follow this, not uniform. */
export function lognormalMs(median: number, sigma = 0.5, cap = Infinity): number {
  return Math.min(cap, Math.max(20, Math.round(median * Math.exp(sigma * gaussian()))));
}

/** A short human pause, log-normal around the midpoint. */
export const humanPause = (min = 350, max = 1100) => sleep(lognormalMs((min + max) / 2, 0.4, max * 3));

export async function humanScroll(page: Page, totalY: number, steps = randInt(6, 12)): Promise<void> {
  const per = totalY / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, per + rand(-40, 40));
    await sleep(rand(180, 520));
  }
}
