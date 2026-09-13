/**
 * Info panel: index-card slide-in (desktop) / bottom sheet (phone).
 * Shows flag + names, 5-slot photo strip, facts grid, article sections.
 * The panel never fetches; main.ts pushes data through showCountry/setImages.
 *
 * The sheet is a real two-detent sheet: `peek` (identity + a glimpse, the globe
 * keeps the majority of the stage) and `full` (reading height). It can be
 * dragged between them and flung down to dismiss, the grabber is a button so the
 * same thing works from a keyboard, and a tap on the globe outside it closes it.
 * Heights are percentages of #stage, not of the viewport, because the stage is
 * what the sheet actually shares with the globe — 62dvh left 106px of globe on a
 * 390x670 Safari window.
 *
 * Whoever owns the camera needs to know how much of the stage is covered so a
 * fly-to can aim above the sheet: `sheetCoverage()` / `onSheetCoverage()` report
 * it. `GlobeHandle.setViewOffset()` takes a fraction of the canvas height, and
 * the geometric ideal is `coverage / 2` — half, because that is how far the
 * centre of the *visible* band sits above the centre of the whole stage. The
 * globe agent's own note says the useful range runs out at about 0.24 on a
 * 390x844 phone, so the caller clamps; the UI's job is only to say, honestly,
 * how much is covered. Peek is ~0.48 and full ~0.88, so nothing should hard-code
 * a number read off one detent.
 */
import type { EventBus } from '../core/events';
import type { CountryImage, CountryRecord } from '../core/types';
import { el, clear, svg, on, append, prefersReducedMotion, type Child } from './dom';
import { formatArea, formatPopulation, formatInt, joinList, paragraphs, wikipediaUrl } from './format';
import { ICON_CAMERA, ICON_CHEVRON_UP, ICON_CLOSE, ICON_EXTERNAL } from './icons';
import { createLightbox } from './lightbox';

export interface PanelHandle {
  show(record: CountryRecord): void;
  setImages(iso3: string, images: CountryImage[]): void;
  setImagesFailed(iso3: string): void;
  close(): void;
  isOpen(): boolean;
  currentIso3(): string | null;
  /** 0–1: how much of #stage the bottom sheet covers right now (0 when closed or on desktop). */
  sheetCoverage(): number;
  /** Fires whenever that number settles (open, close, detent, rotate). Returns an unsubscribe. */
  onSheetCoverage(listener: (coverage: number) => void): () => void;
  dispose(): void;
}

export interface PanelOptions {
  /** Neighbour chips and announcements resolve names from here. */
  getCountries: () => Record<string, CountryRecord>;
  /** Called when the user picks a neighbour chip. */
  onNavigate: (iso3: string) => void;
  /** The panel's positioning context; also what a tap-outside listens on. */
  stage: HTMLElement;
}

const SLOT_COUNT = 5;
const ANIM_MS = 240;

/**
 * The sheet layout is live exactly when this matches — keep it in step with the
 * matching @media block in app.css. Short viewports are excluded on purpose: a
 * phone in landscape has no room for a sheet and gets the side card instead.
 */
const SHEET_QUERY = '(max-width: 720px) and (min-height: 481px)';

type Detent = 'peek' | 'full';

/** Past this much downward travel from `peek`, the release dismisses instead of settling. */
const DISMISS_RATIO = 0.45;
/** px per ms. A flick faster than this decides the detent on its own, wherever it was released. */
const FLING = 0.55;
/** A press that never travels further than this and ends quickly counts as a tap. */
const TAP_SLOP = 10;
const TAP_MS = 400;

export function renderPanel(container: HTMLElement, bus: EventBus, options: PanelOptions): PanelHandle {
  container.classList.add('gp-panel');
  container.dataset.open = 'false';
  container.dataset.detent = 'peek';
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
    closeBtn,
    el(
      'div',
      { class: 'gp-panel__ident' },
      el('div', { class: 'gp-panel__flagbox' }, flagImg),
      el('div', { class: 'gp-panel__names' }, title, official, tagline, pron),
    ),
  );

  // The grabber lives outside the scroller so a drag on it never fights the
  // article's own scrolling, and it is a button so "expand" is not gesture-only.
  const grip = el(
    'button',
    {
      class: 'gp-panel__grip',
      type: 'button',
      'aria-label': 'Expand details',
      'aria-expanded': 'false',
      'aria-controls': 'gp-panel-scroll',
    },
    el('span', { class: 'gp-panel__handle', 'aria-hidden': 'true' }),
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

  const scroll = el('div', { class: 'gp-card__scroll', id: 'gp-panel-scroll' }, head, body);

  // Sheet-only: the close control the desktop card puts in its top-right corner is
  // 500-odd px up from the bottom of a phone. This bar is the same button where a
  // thumb already is, and it carries the home-indicator inset for the whole sheet.
  const dismiss = el(
    'button',
    { class: 'gp-panel__dismiss', type: 'button' },
    svg(ICON_CLOSE, 'gp-panel__dismiss-icon'),
    el('span', { text: 'Close' }),
  );
  const expand = el(
    'button',
    { class: 'gp-panel__expand', type: 'button', 'aria-label': 'Expand details', 'aria-controls': 'gp-panel-scroll' },
    svg(ICON_CHEVRON_UP, 'gp-panel__expand-icon'),
  );
  const foot = el('div', { class: 'gp-panel__foot' }, expand, dismiss);

  const card = el(
    'article',
    { class: 'gp-card', 'aria-labelledby': 'gp-panel-title' },
    el('div', { class: 'gp-card__tape', 'aria-hidden': 'true' }),
    grip,
    scroll,
    foot,
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
            // The label and the icon are one flex row, so a wrap breaks between
            // words instead of flinging the icon to the far end of the next line.
            el('span', { class: 'gp-readmore__label', text: `Read more about ${record.name} on Wikipedia` }),
            svg(ICON_EXTERNAL, 'gp-readmore__icon'),
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
        ? el('p', { class: 'gp-tile__note' }, svg(ICON_CAMERA), el('span', { text: 'Photos load from Wikipedia' }))
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

  // --- The sheet -------------------------------------------------------
  const sheetMedia = typeof matchMedia === 'function' ? matchMedia(SHEET_QUERY) : null;
  const isSheet = (): boolean => (sheetMedia ? sheetMedia.matches : false);

  /** The detent a new country opens at. Peek, until the reader asks for more. */
  let preferred: Detent = 'peek';
  let detent: Detent = 'peek';
  const coverageListeners = new Set<(coverage: number) => void>();
  let lastCoverage = -1;

  /** Settled coverage — the drag's intermediate positions are not worth a camera move. */
  function sheetCoverage(): number {
    if (!isSheet() || !isOpen()) return 0;
    const stageH = options.stage.clientHeight;
    if (!stageH) return 0;
    return Math.min(1, container.offsetHeight / stageH);
  }

  function notifyCoverage(): void {
    const value = sheetCoverage();
    if (Math.abs(value - lastCoverage) < 0.005) return;
    lastCoverage = value;
    for (const listener of coverageListeners) listener(value);
  }

  function setDetent(next: Detent, remember = true): void {
    detent = next;
    container.dataset.detent = next;
    if (remember) preferred = next;
    const label = next === 'full' ? 'Collapse details' : 'Expand details';
    grip.setAttribute('aria-label', label);
    grip.setAttribute('aria-expanded', String(next === 'full'));
    expand.setAttribute('aria-label', label);
    expand.classList.toggle('is-up', next === 'peek');
    notifyCoverage();
  }

  /** Both detent heights in px. Costs two layouts, so only at the start of a drag. */
  function detentHeights(): { peek: number; full: number } {
    const before = container.dataset.detent;
    container.dataset.detent = 'peek';
    const peek = container.offsetHeight;
    container.dataset.detent = 'full';
    const full = container.offsetHeight;
    if (before) container.dataset.detent = before;
    return { peek, full };
  }

  interface Drag {
    pointer: number;
    /** Only a press that began on the grabber treats a no-move release as a toggle. */
    fromGrip: boolean;
    y0: number;
    t0: number;
    /** Offset that makes the full-height sheet look exactly as it did at drag start. */
    base: number;
    peek: number;
    full: number;
    y: number;
    lastY: number;
    lastT: number;
    moved: boolean;
    target: HTMLElement;
  }
  let drag: Drag | null = null;

  function beginDrag(ev: PointerEvent): void {
    if (!isSheet() || !isOpen() || drag) return;
    // A press on a control inside the header is that control's, not the sheet's.
    if ((ev.target as Element | null)?.closest('button, a')) {
      if (ev.currentTarget !== grip) return;
    }
    const { peek, full } = detentHeights();
    const base = detent === 'full' ? 0 : full - peek;
    // Hold the sheet at full height for the whole gesture and move it with a
    // transform: that is the only way a drag *up* can reveal content that the
    // peek height had cropped, and it stays on the compositor.
    container.classList.add('is-dragging');
    container.dataset.detent = 'full';
    container.style.transform = `translateY(${base}px)`;
    const target = ev.currentTarget as HTMLElement;
    drag = {
      pointer: ev.pointerId,
      fromGrip: target === grip,
      y0: ev.clientY,
      t0: ev.timeStamp,
      base,
      peek,
      full,
      y: base,
      lastY: ev.clientY,
      lastT: ev.timeStamp,
      moved: false,
      target,
    };
    try { target.setPointerCapture(ev.pointerId); } catch { /* the pointer is already gone */ }
  }

  function moveDrag(ev: PointerEvent): void {
    if (!drag || ev.pointerId !== drag.pointer) return;
    const dy = ev.clientY - drag.y0;
    if (Math.abs(dy) > TAP_SLOP) drag.moved = true;
    // Downwards is unbounded (it becomes a dismiss); upwards stops at full height
    // with a little rubber so the sheet does not feel nailed down.
    const raw = drag.base + dy;
    drag.y = raw < 0 ? raw / 3 : raw;
    container.style.transform = `translateY(${drag.y}px)`;
    drag.lastY = ev.clientY;
    drag.lastT = ev.timeStamp;
  }

  function endDrag(ev: PointerEvent): void {
    if (!drag || ev.pointerId !== drag.pointer) return;
    const d = drag;
    drag = null;
    try { d.target.releasePointerCapture(d.pointer); } catch { /* already released */ }
    container.style.transform = '';
    container.classList.remove('is-dragging');

    const dt = Math.max(1, ev.timeStamp - d.lastT || ev.timeStamp - d.t0);
    const velocity = (ev.clientY - d.lastY) / dt;
    const peekY = d.full - d.peek;

    if (!d.moved && ev.timeStamp - d.t0 < TAP_MS) {
      // Tapping the grabber toggles; tapping the country's name does nothing,
      // because a tap there is a tap on the content, not on a control.
      if (d.fromGrip) setDetent(detent === 'full' ? 'peek' : 'full');
      else setDetent(detent, false);
      return;
    }

    let target: Detent | 'closed';
    if (velocity > FLING) target = d.y > peekY * 0.5 ? 'closed' : 'peek';
    else if (velocity < -FLING) target = 'full';
    else if (d.y > peekY + d.peek * DISMISS_RATIO) target = 'closed';
    else target = d.y > peekY / 2 ? 'peek' : 'full';

    if (target === 'closed') {
      // Leave the height where the gesture left it so the slide-out starts from
      // under the thumb; the detent is put back when the sheet is finally hidden.
      close();
      return;
    }
    setDetent(target);
  }

  // The grabber and the sheet's own header are both grab areas: a 36px bar alone
  // is a thin thing to find with a thumb.
  for (const surface of [grip, head]) {
    disposers.push(on(surface, 'pointerdown', beginDrag));
    disposers.push(on(surface, 'pointermove', moveDrag));
    disposers.push(on(surface, 'pointerup', endDrag));
    disposers.push(on(surface, 'pointercancel', endDrag));
  }
  // Keyboard/AT: the grip is a button, and Enter/Space fire a click with no drag.
  disposers.push(
    on(grip, 'click', (ev) => {
      if (ev.detail !== 0) return; // pointer taps are already handled by endDrag
      setDetent(detent === 'full' ? 'peek' : 'full');
    }),
  );
  disposers.push(on(expand, 'click', () => setDetent(detent === 'full' ? 'peek' : 'full')));

  // Tap the globe to put the sheet away. Only a genuine tap that selected nothing:
  // a drag is a spin, and a tap that hit a country has already opened that country.
  let selectedAt = 0;
  disposers.push(bus.on('globe:select', () => { selectedAt = performance.now(); }));
  let outside: { x: number; y: number; t: number } | null = null;
  disposers.push(
    on(options.stage, 'pointerdown', (ev) => {
      outside = !isSheet() || !isOpen() || container.contains(ev.target as Node) ? null : { x: ev.clientX, y: ev.clientY, t: performance.now() };
    }, { capture: true }),
  );
  disposers.push(
    on(options.stage, 'pointerup', (ev) => {
      const start = outside;
      outside = null;
      if (!start || !isSheet() || !isOpen() || lightbox.isOpen()) return;
      if (Math.abs(ev.clientX - start.x) > TAP_SLOP || Math.abs(ev.clientY - start.y) > TAP_SLOP) return;
      const now = performance.now();
      if (now - start.t > TAP_MS) return;
      if (selectedAt >= start.t) return; // the tap landed on a country; it is opening, not closing
      close();
    }, { capture: true }),
  );

  const onViewportChange = (): void => {
    if (!isSheet() && container.classList.contains('is-dragging')) {
      container.classList.remove('is-dragging');
      container.style.transform = '';
      drag = null;
    }
    notifyCoverage();
  };
  if (sheetMedia?.addEventListener) {
    sheetMedia.addEventListener('change', onViewportChange);
    disposers.push(() => sheetMedia.removeEventListener('change', onViewportChange));
  }
  // resize covers rotation too: the visual viewport changes either way.
  disposers.push(on(window, 'resize', onViewportChange));

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
      // A fresh country arrives at the detent this reader last settled on.
      setDetent(preferred, false);
      container.hidden = false;
      container.removeAttribute('aria-hidden');
      // force a frame so the transition plays from the closed state
      void container.offsetWidth;
      container.dataset.open = 'true';
      notifyCoverage();
    }
    if (!sameCountry) {
      scroll.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
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
    notifyCoverage();
    const restore = previousFocus;
    previousFocus = null;
    if (restore && restore.isConnected && !container.contains(restore)) restore.focus({ preventScroll: true });
    else if (document.activeElement && container.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    const delay = prefersReducedMotion() ? 0 : ANIM_MS;
    hideTimer = window.setTimeout(() => {
      if (!isOpen()) {
        container.hidden = true;
        setDetent(preferred, false);
      }
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
  disposers.push(on(dismiss, 'click', close));
  disposers.push(
    on(document, 'keydown', (ev) => {
      if (ev.key === 'Escape' && isOpen() && !lightbox.isOpen() && !ev.defaultPrevented) close();
    }),
  );
  setDetent('peek', false);

  return {
    show,
    setImages,
    setImagesFailed,
    close,
    isOpen,
    currentIso3: () => current?.iso3 ?? null,
    sheetCoverage,
    onSheetCoverage(listener) {
      coverageListeners.add(listener);
      listener(sheetCoverage());
      return () => coverageListeners.delete(listener);
    },
    dispose() {
      disposers.forEach((off) => off());
      coverageListeners.clear();
      window.clearTimeout(hideTimer);
      lightbox.dispose();
      clear(container);
      container.classList.remove('gp-panel');
      delete container.dataset.open;
      delete container.dataset.detent;
    },
  };
}
