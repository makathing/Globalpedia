/**
 * Info panel: index-card slide-in (desktop) / bottom sheet (mobile).
 * Shows flag + names, 5-slot photo strip, facts grid, article sections.
 * The panel never fetches; main.ts pushes data through showCountry/setImages.
 */
import type { EventBus } from '../core/events';
import type { CountryImage, CountryRecord } from '../core/types';
import { el, clear, svg, on, append, prefersReducedMotion, type Child } from './dom';
import { formatArea, formatPopulation, formatInt, joinList, paragraphs, wikipediaUrl } from './format';
import { ICON_CAMERA, ICON_CLOSE, ICON_EXTERNAL } from './icons';
import { createLightbox } from './lightbox';

export interface PanelHandle {
  show(record: CountryRecord): void;
  setImages(iso3: string, images: CountryImage[]): void;
  setImagesFailed(iso3: string): void;
  close(): void;
  isOpen(): boolean;
  currentIso3(): string | null;
  dispose(): void;
}

export interface PanelOptions {
  /** Neighbour chips and announcements resolve names from here. */
  getCountries: () => Record<string, CountryRecord>;
  /** Called when the user picks a neighbour chip. */
  onNavigate: (iso3: string) => void;
}

const SLOT_COUNT = 5;
const ANIM_MS = 240;

export function renderPanel(container: HTMLElement, bus: EventBus, options: PanelOptions): PanelHandle {
  container.classList.add('gp-panel');
  container.dataset.open = 'false';
  // We announce through our own status region; the raw panel content would be too chatty.
  container.removeAttribute('aria-live');
  container.setAttribute('aria-hidden', 'true');
  clear(container);

  const disposers: Array<() => void> = [];
  const lightbox = createLightbox();

  let current: CountryRecord | null = null;
  let previousFocus: HTMLElement | null = null;
  let hideTimer = 0;
  let imageState: { iso3: string; images: CountryImage[] | null; failed: boolean } | null = null;

  // --- Skeleton --------------------------------------------------------
  const closeBtn = el('button', { class: 'gp-panel__close', type: 'button', 'aria-label': 'Close' }, svg(ICON_CLOSE));
  const flagImg = el('img', { class: 'gp-panel__flag', alt: '', width: '64', height: '43', decoding: 'async' });
  const title = el('h2', { class: 'gp-panel__title', id: 'gp-panel-title', tabindex: '-1' });
  const official = el('p', { class: 'gp-panel__official' });
  const tagline = el('p', { class: 'gp-panel__tagline' });
  const pron = el('p', { class: 'gp-panel__pron' });

  const head = el(
    'header',
    { class: 'gp-panel__head' },
    el('div', { class: 'gp-panel__handle', 'aria-hidden': 'true' }),
    closeBtn,
    el(
      'div',
      { class: 'gp-panel__ident' },
      el('div', { class: 'gp-panel__flagbox' }, flagImg),
      el('div', { class: 'gp-panel__names' }, title, official, tagline, pron),
    ),
  );

  const strip = el('div', { class: 'gp-strip', role: 'list', 'aria-label': 'Photos' });
  const facts = el('dl', { class: 'gp-facts' });
  const article = el('div', { class: 'gp-article' });
  const status = el('div', { class: 'gp-visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });

  const body = el(
    'div',
    { class: 'gp-panel__body' },
    el('section', { class: 'gp-panel__section gp-panel__section--photos', 'aria-label': 'Photos' }, strip),
    el('section', { class: 'gp-panel__section', 'aria-label': 'Key facts' }, el('h3', { class: 'gp-h3', text: 'Key facts' }), facts),
    article,
  );

  const card = el(
    'article',
    { class: 'gp-card', 'aria-labelledby': 'gp-panel-title' },
    el('div', { class: 'gp-card__tape', 'aria-hidden': 'true' }),
    el('div', { class: 'gp-card__scroll' }, head, body),
  );
  container.append(card, status);

  // --- Helpers ---------------------------------------------------------
  function fact(label: string, value: Child, extraClass = ''): HTMLElement {
    return el('div', { class: `gp-fact ${extraClass}`.trim() }, el('dt', { class: 'gp-fact__label', text: label }), el('dd', { class: 'gp-fact__value' }, value));
  }

  function renderFacts(record: CountryRecord): void {
    clear(facts);
    const countries = options.getCountries();
    const region = record.subregion && record.subregion !== record.region ? `${record.region} · ${record.subregion}` : record.region;

    facts.append(fact('Capital', joinList(record.capital)));
    facts.append(fact('Continent', region || '—'));
    if (typeof record.population === 'number' && record.population > 0) {
      facts.append(fact('Population', el('span', { title: `${formatInt(record.population)} people`, text: formatPopulation(record.population) })));
    }
    if (record.area > 0) facts.append(fact('Area', formatArea(record.area)));
    facts.append(fact('Languages', joinList(record.languages)));
    facts.append(fact('Currency', joinList(record.currencies)));
    if (record.demonym) facts.append(fact('People are called', record.demonym));
    if (record.landlocked) facts.append(fact('Landlocked', 'Yes — no coastline'));

    if (record.borders.length) {
      const chips = el('div', { class: 'gp-chips' });
      const neighbours = record.borders
        .map((iso3) => ({ iso3, name: countries[iso3]?.name ?? iso3, emoji: countries[iso3]?.flagEmoji ?? '' }))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const n of neighbours) {
        const chip = el(
          'button',
          { class: 'gp-chip', type: 'button', 'data-iso3': n.iso3 },
          n.emoji ? el('span', { class: 'gp-chip__flag', 'aria-hidden': 'true', text: n.emoji }) : null,
          el('span', { text: n.name }),
        );
        chip.addEventListener('click', () => options.onNavigate(n.iso3));
        chips.append(chip);
      }
      facts.append(fact('Neighbours', chips, 'gp-fact--wide'));
    } else {
      facts.append(fact('Neighbours', record.landlocked ? '—' : 'None — surrounded by sea', 'gp-fact--wide'));
    }
  }

  function section(heading: string, text: string): HTMLElement | null {
    const paras = paragraphs(text);
    if (!paras.length) return null;
    return el(
      'section',
      { class: 'gp-panel__section' },
      el('h3', { class: 'gp-h3', text: heading }),
      ...paras.map((p) => el('p', { class: 'gp-article__p', text: p })),
    );
  }

  function renderArticle(record: CountryRecord): void {
    clear(article);
    const content = record.content;
    if (content) {
      append(article, [
        section('Overview', content.overview),
        section('Land & nature', content.landAndNature),
        section('People & culture', content.peopleAndCulture),
        section('History', content.history),
      ]);
      if (content.funFacts.length) {
        article.append(
          el(
            'section',
            { class: 'gp-panel__section' },
            el('h3', { class: 'gp-h3', text: 'Fun facts' }),
            el('ul', { class: 'gp-funfacts' }, ...content.funFacts.map((f) => el('li', { class: 'gp-funfacts__item', text: f }))),
          ),
        );
      }
    } else {
      article.append(
        el(
          'section',
          { class: 'gp-panel__section' },
          el('p', { class: 'gp-notice', text: `We don't have a full article for ${record.name} yet.` }),
        ),
      );
    }
    if (record.wikipediaTitle) {
      article.append(
        el(
          'p',
          { class: 'gp-readmore' },
          el(
            'a',
            { class: 'gp-readmore__link', href: wikipediaUrl(record.wikipediaTitle), target: '_blank', rel: 'noopener noreferrer' },
            `Read more about ${record.name} on Wikipedia `,
            svg(ICON_EXTERNAL),
          ),
        ),
      );
    }
  }

  // --- Photo strip -----------------------------------------------------
  function skeletonTile(i: number): HTMLElement {
    return el('div', { class: `gp-tile gp-tile--skeleton${i === 0 ? ' gp-tile--big' : ''}`, role: 'listitem', 'aria-label': 'Loading photo' });
  }

  function fallbackTile(record: CountryRecord, i: number, big: boolean): HTMLElement {
    return el(
      'div',
      { class: `gp-tile gp-tile--fallback${big ? ' gp-tile--big' : ''}`, role: 'listitem' },
      el('img', { class: 'gp-tile__flag', src: record.flagSvg, alt: `Flag of ${record.name}`, loading: 'lazy', decoding: 'async', width: '96', height: '64' }),
      i === 0 || big
        ? el('p', { class: 'gp-tile__note' }, svg(ICON_CAMERA), el('span', { text: 'Photos load from Wikipedia when you’re online' }))
        : el('span', { class: 'gp-visually-hidden', text: 'No photo available' }),
    );
  }

  function photoTile(record: CountryRecord, images: CountryImage[], i: number): HTMLElement {
    const image = images[i];
    const big = i === 0;
    const img = el('img', {
      class: 'gp-tile__img',
      src: image.thumbUrl,
      alt: image.title,
      loading: i < 2 ? 'eager' : 'lazy',
      decoding: 'async',
      width: String(image.width || 900),
      height: String(image.height || 600),
    });
    const btn = el('button', { class: 'gp-tile__btn', type: 'button', 'aria-label': `Open photo: ${image.title}` }, img);
    btn.addEventListener('click', () => lightbox.open(images, i, btn));
    const credit = el('small', { class: 'gp-tile__credit' });
    const bits = [image.credit, image.license].filter((b): b is string => Boolean(b));
    if (bits.length || image.sourcePage) {
      credit.append(el('a', { href: image.sourcePage, target: '_blank', rel: 'noopener noreferrer', text: bits.length ? bits.join(' · ') : 'Source' }));
    }
    return el(
      'figure',
      { class: `gp-tile gp-tile--photo${big ? ' gp-tile--big' : ''}`, role: 'listitem', 'data-country': record.iso3 },
      btn,
      el('figcaption', { class: 'gp-tile__cap' }, el('span', { class: 'gp-tile__title', text: image.title }), credit),
    );
  }

  function renderStrip(): void {
    if (!current) return;
    clear(strip);
    const state = imageState && imageState.iso3 === current.iso3 ? imageState : null;
    if (!state || (state.images === null && !state.failed)) {
      for (let i = 0; i < SLOT_COUNT; i++) strip.append(skeletonTile(i));
      strip.setAttribute('aria-busy', 'true');
      return;
    }
    strip.removeAttribute('aria-busy');
    const images = state.images ?? [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      strip.append(i < images.length ? photoTile(current, images, i) : fallbackTile(current, i, i === 0));
    }
    strip.scrollLeft = 0;
  }

  // --- Open / close ----------------------------------------------------
  function isOpen(): boolean {
    return container.dataset.open === 'true';
  }

  function show(record: CountryRecord): void {
    window.clearTimeout(hideTimer);
    const sameCountry = current?.iso3 === record.iso3;
    const wasOpen = isOpen();
    current = record;
    if (!sameCountry) imageState = { iso3: record.iso3, images: null, failed: false };

    // Identity
    flagImg.src = record.flagSvg;
    flagImg.alt = `Flag of ${record.name}`;
    clear(title);
    append(title, [el('span', { text: record.name }), record.flagEmoji ? el('span', { class: 'gp-panel__emoji', 'aria-hidden': 'true', text: ` ${record.flagEmoji}` }) : null]);
    official.textContent = record.officialName && record.officialName !== record.name ? record.officialName : '';
    official.hidden = !official.textContent;
    tagline.textContent = record.content?.tagline ?? '';
    tagline.hidden = !tagline.textContent;
    const p = record.content?.pronunciation;
    pron.textContent = p ? `Say it: ${p}` : '';
    pron.hidden = !p;

    renderStrip();
    renderFacts(record);
    renderArticle(record);

    if (!wasOpen) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      container.hidden = false;
      container.removeAttribute('aria-hidden');
      // force a frame so the transition plays from the closed state
      void container.offsetWidth;
      container.dataset.open = 'true';
    }
    if (!sameCountry) {
      card.querySelector<HTMLElement>('.gp-card__scroll')?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
    focusTitle();
    status.textContent = `Showing ${record.name}`;
  }

  function focusTitle(): void {
    title.focus({ preventScroll: true });
    if (document.activeElement !== title) {
      // Styles may not have flushed yet on the very first open; try once more next frame.
      requestAnimationFrame(() => {
        if (isOpen() && !lightbox.isOpen()) title.focus({ preventScroll: true });
      });
    }
  }

  function close(): void {
    if (!isOpen()) return;
    container.dataset.open = 'false';
    container.setAttribute('aria-hidden', 'true');
    const restore = previousFocus;
    previousFocus = null;
    if (restore && restore.isConnected && !container.contains(restore)) restore.focus({ preventScroll: true });
    else if (document.activeElement && container.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    const delay = prefersReducedMotion() ? 0 : ANIM_MS;
    hideTimer = window.setTimeout(() => {
      if (!isOpen()) container.hidden = true;
    }, delay);
    bus.emit('ui:close', {});
  }

  function setImages(iso3: string, images: CountryImage[]): void {
    if (!current || current.iso3 !== iso3) return;
    imageState = { iso3, images: images.slice(0, SLOT_COUNT), failed: false };
    renderStrip();
  }

  function setImagesFailed(iso3: string): void {
    if (!current || current.iso3 !== iso3) return;
    imageState = { iso3, images: [], failed: true };
    renderStrip();
  }

  container.hidden = true;
  disposers.push(on(closeBtn, 'click', close));
  disposers.push(
    on(document, 'keydown', (ev) => {
      if (ev.key === 'Escape' && isOpen() && !lightbox.isOpen() && !ev.defaultPrevented) close();
    }),
  );

  return {
    show,
    setImages,
    setImagesFailed,
    close,
    isOpen,
    currentIso3: () => current?.iso3 ?? null,
    dispose() {
      disposers.forEach((off) => off());
      window.clearTimeout(hideTimer);
      lightbox.dispose();
      clear(container);
      container.classList.remove('gp-panel');
      delete container.dataset.open;
    },
  };
}
