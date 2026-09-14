/**
 * App entry. Constructs the three modules and owns only the wiring that no single
 * module can do by itself: fetching photos for the selected country, deep links,
 * and the startup overlay.
 *
 * Everything else is handled inside the modules, which talk over the event bus:
 *   globe  listens to ui:flyTo (fly + highlight) and ui:close (clear highlight)
 *   ui     listens to globe:select (open the panel) and data:ready (search index)
 * Do not re-handle those here — duplicate handlers cause double camera flights
 * and double panel renders.
 */
import { bus } from './core/events';
import type { CountryRecord } from './core/types';
import { loadAll, fetchCountryImages } from './data';
import { createGlobe, type GlobeHandle } from './globe';
import { isThemeId } from './core/themes';
import { createUI } from './ui';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el;
}

/** Open a country from the outside (deep link): fly there and select it. */
function navigate(iso3: string): void {
  bus.emit('ui:flyTo', { iso3 });
  bus.emit('globe:select', { iso3 });
}

async function boot(): Promise<void> {
  const ui = createUI(
    { header: $('header'), panel: $('panel'), footer: $('footer'), stage: $('stage') },
    bus,
  );
  ui.setLoading(true, 'Inflating the globe…');

  const fromHash = (): string => location.hash.replace('#', '').toUpperCase();
  const initial = fromHash();

  let countries: Record<string, CountryRecord> = {};
  let globe: GlobeHandle | null = null;
  let booted = false;

  try {
    const data = await loadAll(bus);
    countries = data.countries;
    ui.setCountries(countries);
    // A deep-linked country is framed at construction, so the page never flies from
    // the default pose on load.
    // The pre-paint script in index.html has already resolved and stamped the theme,
    // so boot the globe in it rather than in the default and re-theming a frame later.
    const stamped = document.documentElement.dataset.theme;
    globe = await createGlobe($('globe'), data.world, countries, bus, {
      // Say what is happening. Building the map is seconds of real work, and a card that
      // sits on one line for all of it reads as hung rather than busy.
      //
      // Only until the globe is up, though: the pick index is refined after it is already on
      // screen and interactive, and those phases report too. Re-opening the card for them
      // would hide a working globe behind a spinner that never goes away.
      onProgress: ({ label, phase }) => {
        if (!booted && phase !== 'ready') ui.setLoading(true, label);
      },
      autoRotate: true,
      initialIso3: countries[initial] ? initial : undefined,
      theme: isThemeId(stamped) ? stamped : undefined,
    });
  } catch (err) {
    console.error('Globalpedia could not load', err);
    ui.setLoading(true, 'Sorry — the globe could not load. Please refresh the page.');
    return;
  }
  booted = true;
  ui.setLoading(false);
  // Exposed so tests can hold the globe still; auto-rotate resuming on its own timer
  // otherwise makes "did anything move?" checks racy.
  if (window.__gp) window.__gp.globe = globe;

  // Photos: fetched live from Wikipedia, one request in flight at a time.
  let imageAbort: AbortController | null = null;
  bus.on('globe:select', ({ iso3 }) => {
    const record = countries[iso3];
    if (!record) return;

    imageAbort?.abort();
    const ac = new AbortController();
    imageAbort = ac;
    fetchCountryImages(record, { signal: ac.signal, count: 5 })
      .then((images) => {
        if (ac.signal.aborted) return;
        if (images.length) ui.setImages(iso3, images);
        else ui.setImagesFailed(iso3);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        console.warn('Photo fetch failed', err);
        ui.setImagesFailed(iso3);
      });

    history.replaceState(null, '', `#${iso3}`);
  });

  /**
   * Lift the globe so the country you just chose is not flown underneath the sheet.
   *
   * The sheet reports how much of the stage it covers; half of that is how far the centre
   * of the remaining band sits above the centre of the stage, which is exactly the shift
   * the camera needs. Capped below the point where the globe's top would leave the canvas,
   * so the full detent — where the globe is hidden anyway — cannot push it off screen.
   */
  const MAX_LIFT = 0.22;
  ui.onSheetCoverage((coverage) => globe?.setViewOffset(Math.min(coverage / 2, MAX_LIFT)));

  bus.on('ui:close', () => {
    imageAbort?.abort();
    history.replaceState(null, '', location.pathname + location.search);
  });

  // Deep link: /#FRA opens France on load; back/forward navigates.
  if (initial && countries[initial]) bus.emit('globe:select', { iso3: initial });

  window.addEventListener('hashchange', () => {
    const iso3 = fromHash();
    if (iso3 && countries[iso3]) navigate(iso3);
  });
}

// Exposed for the smoke test and for tinkering in the console.
declare global {
  interface Window {
    __gp?: { bus: typeof bus; globe?: GlobeHandle | null };
  }
}
window.__gp = { bus };

boot().catch((err) => console.error('Globalpedia failed to start', err));
