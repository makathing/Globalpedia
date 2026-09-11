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
import { createGlobe } from './globe';
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

  try {
    const data = await loadAll(bus);
    countries = data.countries;
    ui.setCountries(countries);
    // A deep-linked country is framed at construction, so the page never flies from
    // the default pose on load.
    createGlobe($('globe'), data.world, countries, bus, {
      autoRotate: true,
      initialIso3: countries[initial] ? initial : undefined,
    });
  } catch (err) {
    console.error('Globalpedia could not load', err);
    ui.setLoading(true, 'Sorry — the globe could not load. Please refresh the page.');
    return;
  }
  ui.setLoading(false);

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
    __gp?: { bus: typeof bus };
  }
}
window.__gp = { bus };

boot().catch((err) => console.error('Globalpedia failed to start', err));
