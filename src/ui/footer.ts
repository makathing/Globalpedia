/**
 * Footer credits. Two shapes of the same information:
 *
 *  - wide: the full sentence, "Borders: Natural Earth · Facts: …".
 *  - narrow: just the four sources, short-named, each a 44px touch target on one
 *    line. The full sentence wraps to two 14px-tall lines on a phone, which is
 *    both unhittable and the tallest thing in the footer's gesture strip.
 *
 * The licence line (CC BY-SA) is in both: it is an attribution requirement, not
 * decoration, so it never gets dropped.
 */
import { el, clear } from './dom';

interface Source {
  href: string;
  /** Wide label. */
  name: string;
  /** Narrow label. */
  short: string;
  /** The "Borders:" style lead-in, wide only. */
  lead?: string;
}

const SOURCES: Source[] = [
  { href: 'https://www.naturalearthdata.com/', name: 'Natural Earth', short: 'Natural Earth', lead: 'Borders' },
  { href: 'https://github.com/mledoze/countries', name: 'mledoze/countries', short: 'mledoze', lead: 'Facts' },
  { href: 'https://www.wikipedia.org/', name: 'Wikipedia', short: 'Wikipedia', lead: 'Photos & text links' },
  { href: 'https://commons.wikimedia.org/', name: 'Wikimedia Commons', short: 'Commons' },
];

const NARROW_QUERY = '(max-width: 720px)';

export function renderFooter(container: HTMLElement): () => void {
  container.classList.add('gp-footer');

  const media = typeof matchMedia === 'function' ? matchMedia(NARROW_QUERY) : null;

  function build(narrow: boolean): void {
    clear(container);
    const credits = el('p', { class: 'gp-footer__credits' });
    SOURCES.forEach((source, i) => {
      if (i) credits.append(el('span', { class: 'gp-footer__sep', 'aria-hidden': 'true', text: '·' }));
      if (!narrow && source.lead) credits.append(el('span', { class: 'gp-footer__lead', text: `${source.lead}:` }));
      credits.append(
        el('a', {
          class: 'gp-footer__link',
          href: source.href,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: narrow ? source.short : source.name,
        }),
      );
    });
    credits.append(el('span', { class: 'gp-footer__licence', text: 'CC BY-SA' }));
    container.append(credits, el('p', { class: 'gp-footer__note', text: 'Made for curious kids' }));
  }

  build(media ? media.matches : false);

  const offs: Array<() => void> = [];
  if (media?.addEventListener) {
    const onChange = (): void => build(media.matches);
    media.addEventListener('change', onChange);
    offs.push(() => media.removeEventListener('change', onChange));
  }

  return () => {
    offs.forEach((off) => off());
    clear(container);
    container.classList.remove('gp-footer');
  };
}
