/**
 * Runtime photo client: English Wikipedia MediaWiki API (CORS via origin=*).
 * Wikimedia is fetched in the visitor's browser only — never at build time.
 */
import type { CountryImage, CountryRecord } from '../core/types';
import { mergeImages, selectImages, type MwPage, type MwQueryResponse } from './image-filter';

export const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
export const IMAGE_TIMEOUT_MS = 8000;
const THUMB_WIDTH = 900;
const CACHE_PREFIX = 'gp:img:';

export interface FetchCountryImagesOptions {
  signal?: AbortSignal;
  /** How many photos to return (default 5). */
  count?: number;
}

function buildQueryUrl(title: string, cont?: Record<string, string>): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    titles: title,
    redirects: '1',
    generator: 'images',
    gimlimit: '100',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(THUMB_WIDTH),
    iiextmetadatafilter: 'ObjectName|ImageDescription|Artist|LicenseShortName',
    ...(cont ?? {}),
  });
  return `${WIKIPEDIA_API}?${params}`;
}

async function fetchJson(url: string, signal: AbortSignal): Promise<MwQueryResponse> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Wikipedia API responded ${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as MwQueryResponse;
}

/** All File: pages linked from `title`, following `continue` once at most. */
export async function queryArticleImages(title: string, signal: AbortSignal): Promise<MwPage[]> {
  const first = await fetchJson(buildQueryUrl(title), signal);
  const pages: MwPage[] = [...(first.query?.pages ?? [])];
  if (first.continue) {
    try {
      const second = await fetchJson(buildQueryUrl(title, first.continue), signal);
      pages.push(...(second.query?.pages ?? []));
    } catch (err) {
      if (signal.aborted) throw err; // partial page is fine, an abort is not
    }
  }
  return pages;
}

function readCache(iso3: string): CountryImage[] | undefined {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + iso3);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CountryImage[]) : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(iso3: string, images: CountryImage[]): void {
  try {
    sessionStorage.setItem(CACHE_PREFIX + iso3, JSON.stringify(images));
  } catch {
    /* quota / privacy mode — ignore */
  }
}

/** AbortSignal that fires on timeout or when `outer` aborts. */
function timeoutSignal(ms: number, outer?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`Timed out after ${ms} ms`, 'TimeoutError')), ms);
  const onAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Fetch up to `count` representative photos for a country: the country's
 * Wikipedia article first, topped up from the capital's article. Results are
 * cached per session. Throws when nothing usable could be fetched; returns
 * a shorter list rather than throwing when only some photos are available.
 */
export async function fetchCountryImages(
  record: CountryRecord,
  opts: FetchCountryImagesOptions = {},
): Promise<CountryImage[]> {
  const count = opts.count ?? 5;
  const cached = readCache(record.iso3);
  if (cached && cached.length >= count) return cached.slice(0, count);

  const { signal, dispose } = timeoutSignal(IMAGE_TIMEOUT_MS, opts.signal);
  try {
    let images: CountryImage[];
    try {
      images = selectImages(await queryArticleImages(record.wikipediaTitle, signal), count);
    } catch (err) {
      if (cached && cached.length > 0) return cached; // stale-but-something beats nothing
      throw new Error(`Could not load photos for ${record.name} (${record.wikipediaTitle}): ${describe(err)}`);
    }

    const capital = record.capital[0];
    if (images.length < count && capital) {
      try {
        const extra = selectImages(await queryArticleImages(capital, signal), count);
        images = mergeImages(images, extra).slice(0, count);
      } catch {
        /* partial results are fine */
      }
    }

    if (images.length === 0) {
      throw new Error(`No suitable photos found on Wikipedia for ${record.name} (${record.wikipediaTitle})`);
    }
    writeCache(record.iso3, images);
    return images;
  } finally {
    dispose();
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.name === 'AbortError' || err.name === 'TimeoutError' ? `${err.name}: ${err.message}` : err.message;
  return String(err);
}
