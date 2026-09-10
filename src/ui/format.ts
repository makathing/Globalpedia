/** Number / text formatting used by the info panel. Nothing country-specific here. */

const intFmt = new Intl.NumberFormat('en-US');

export function formatInt(n: number): string {
  return intFmt.format(Math.round(n));
}

/** "about 68 million", "about 340,000", "9,600". */
export function formatPopulation(n: number): string {
  if (n >= 1_000_000) {
    const compact = new Intl.NumberFormat('en-US', {
      notation: 'compact',
      compactDisplay: 'long',
      maximumFractionDigits: n >= 10_000_000 ? 0 : 1,
    }).format(n);
    return `about ${compact}`;
  }
  if (n >= 10_000) return `about ${intFmt.format(Math.round(n / 1000) * 1000)}`;
  return intFmt.format(n);
}

export function formatArea(km2: number): string {
  return `${intFmt.format(Math.round(km2))} km²`;
}

export function wikipediaUrl(title: string): string {
  return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.trim().replace(/ /g, '_'));
}

export function joinList(items: string[], fallback = '—'): string {
  return items.length ? items.join(', ') : fallback;
}

/** Split authored text on blank lines into trimmed paragraphs. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
