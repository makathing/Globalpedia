/**
 * Pure filtering / ranking / mapping of MediaWiki `imageinfo` results into
 * `CountryImage`s. No DOM, no fetch — unit-tested from tests/ts/.
 */
import type { CountryImage } from '../core/types';

export interface MwExtMetaValue {
  value: string;
  source?: string;
}

export interface MwImageInfo {
  url?: string;
  descriptionurl?: string;
  descriptionshorturl?: string;
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  width?: number;
  height?: number;
  size?: number;
  mime?: string;
  extmetadata?: Record<string, MwExtMetaValue | undefined>;
}

export interface MwPage {
  pageid?: number;
  ns?: number;
  title: string;
  missing?: boolean;
  imageinfo?: MwImageInfo[];
}

export interface MwQueryResponse {
  batchcomplete?: boolean;
  continue?: Record<string, string>;
  query?: { pages?: MwPage[] };
}

/** File titles / captions that are not photographs of the place. */
export const EXCLUDE_RE =
  /\b(flag|coat of arms|coa|arms|map|locator|location|logo|icon|seal|emblem|orthographic|diagram|chart|graph|plot|svg|symbol|banner|sign|stamp|coin|banknote|currency|topographic|topography|climate|population|density|pyramid|gdp|election|treemap|köppen|koppen|animation|blank|outline|wordmark|montage|collage)\b/i;

const EXCLUDED_EXT_RE = /\.(gif|tiff?|svg|webm|ogv|ogg|pdf|djvu)$/i;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png']);
export const MIN_WIDTH = 640;
export const MIN_HEIGHT = 400;
export const TITLE_MAX = 90;
export const CREDIT_MAX = 60;

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
};

/** Remove HTML tags/entities and collapse whitespace. */
export function stripHtml(html: string | undefined | null): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cap to `max` characters, cutting at a word boundary and appending "…". */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.5) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.\-–—(]+$/, '') + '…';
}

/** "File:Eiffel_Tower_at_dusk.jpg" → "Eiffel Tower at dusk". */
export function cleanFileTitle(title: string): string {
  return title
    .replace(/^(File|Image|Fichier|Datei):/i, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstInfo(page: MwPage): MwImageInfo | undefined {
  return page.imageinfo?.[0];
}

function dims(info: MwImageInfo): { w: number; h: number } {
  return { w: info.width ?? info.thumbwidth ?? 0, h: info.height ?? info.thumbheight ?? 0 };
}

/** True when the page looks like a real photograph worth showing. */
export function isCandidate(page: MwPage): boolean {
  const info = firstInfo(page);
  if (!info || page.missing || !info.url) return false;
  if (!info.mime || !ALLOWED_MIME.has(info.mime.toLowerCase())) return false;
  if (EXCLUDED_EXT_RE.test(page.title) || EXCLUDED_EXT_RE.test(info.url)) return false;
  const { w, h } = dims(info);
  if (w < MIN_WIDTH || h < MIN_HEIGHT) return false;
  const meta = info.extmetadata ?? {};
  const haystack = [
    cleanFileTitle(page.title),
    stripHtml(meta.ObjectName?.value),
    stripHtml(meta.ImageDescription?.value),
  ].join(' \n ');
  return !EXCLUDE_RE.test(haystack);
}

/** Filter to candidates and drop duplicates (same file URL or title). */
export function filterImages(pages: readonly MwPage[]): MwPage[] {
  const seen = new Set<string>();
  const out: MwPage[] = [];
  for (const page of pages) {
    if (!isCandidate(page)) continue;
    const key = (firstInfo(page)?.url ?? page.title).toLowerCase();
    const tkey = page.title.toLowerCase();
    if (seen.has(key) || seen.has(tkey)) continue;
    seen.add(key);
    seen.add(tkey);
    out.push(page);
  }
  return out;
}

export function isLandscape(w: number, h: number): boolean {
  if (!w || !h) return false;
  const r = w / h;
  return r >= 1.2 && r <= 2.2;
}

/**
 * Rank: landscape orientation first, then larger pixel count, then original
 * position (stable) so ties keep article order.
 */
export function rankImages(pages: readonly MwPage[]): MwPage[] {
  const scored = pages.map((page, index) => {
    const { w, h } = dims(firstInfo(page) ?? {});
    return { page, index, landscape: isLandscape(w, h) ? 1 : 0, pixels: w * h };
  });
  scored.sort((a, b) => b.landscape - a.landscape || b.pixels - a.pixels || a.index - b.index);
  return scored.map((s) => s.page);
}

/** Map one MediaWiki file page to the UI contract. */
export function toCountryImage(page: MwPage): CountryImage {
  const info = firstInfo(page) ?? {};
  const meta = info.extmetadata ?? {};
  const url = info.url ?? '';
  const objectName = stripHtml(meta.ObjectName?.value);
  const description = stripHtml(meta.ImageDescription?.value);
  const fileTitle = cleanFileTitle(page.title);
  // ObjectName is often just the file name; prefer a real caption when we have one.
  const rawTitle = (objectName && objectName !== fileTitle ? objectName : '') || description || objectName || fileTitle;
  const credit = truncate(stripHtml(meta.Artist?.value), CREDIT_MAX);
  const license = stripHtml(meta.LicenseShortName?.value);
  const image: CountryImage = {
    url,
    thumbUrl: info.thumburl ?? url,
    width: info.thumbwidth ?? info.width ?? 0,
    height: info.thumbheight ?? info.height ?? 0,
    title: truncate(rawTitle, TITLE_MAX),
    sourcePage: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
  };
  if (credit) image.credit = credit;
  if (license) image.license = license;
  return image;
}

/** filter → rank → take `count` → map. */
export function selectImages(pages: readonly MwPage[], count = 5): CountryImage[] {
  return rankImages(filterImages(pages)).slice(0, Math.max(0, count)).map(toCountryImage);
}

/** Merge image lists, dropping later duplicates (by url). */
export function mergeImages(...lists: readonly CountryImage[][]): CountryImage[] {
  const seen = new Set<string>();
  const out: CountryImage[] = [];
  for (const list of lists) {
    for (const img of list) {
      if (seen.has(img.url)) continue;
      seen.add(img.url);
      out.push(img);
    }
  }
  return out;
}
