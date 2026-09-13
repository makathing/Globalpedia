/** Small download helpers for scripts/build-data.mjs (Node built-ins only). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch `url` unless a valid copy already sits at `cachePath`.
 * @param {string} url
 * @param {string} cachePath
 * @param {{ validate?: (buf: Buffer) => boolean, retries?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ buf: Buffer, cached: boolean }>}
 */
export async function fetchCached(url, cachePath, opts = {}) {
  const { validate, retries = 3, timeoutMs = 30_000 } = opts;
  if (existsSync(cachePath)) {
    const buf = readFileSync(cachePath);
    if (buf.length > 0 && (!validate || validate(buf))) return { buf, cached: true };
  }
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error(`Empty response for ${url}`);
      if (validate && !validate(buf)) throw new Error(`Downloaded content failed validation: ${url}`);
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, buf);
      return { buf, cached: false };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * attempt);
    }
  }
  throw lastErr;
}

/** Run `fn` over `items` with at most `limit` in flight; preserves order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Minimal RFC-4180-ish CSV parser (handles quoted fields with commas / doubled quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
