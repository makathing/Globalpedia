/**
 * App entry. Wires data → globe → ui through the event bus.
 * Module agents export factories; this file is the only place they meet.
 */
import { bus } from './core/events';
import type { CountryRecord } from './core/types';
import { loadAll } from './data';
import { fetchCountryImages } from './data';
import { createGlobe, type GlobeHandle } from './globe';
import { createUI } from './ui';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el;
}

async function boot(): Promise<void> {
  const ui = createUI(
    { header: $('header'), panel: $('panel'), footer: $('footer'), stage: $('stage') },
    bus,
  );
  ui.setLoading(true, 'Inflating the globe…');

  let countries: Record<string, CountryRecord> = {};
  let globe: GlobeHandle | null = null;

  try {
    const data = await loadAll(bus);
    countries = data.countries;
    ui.setCountries(countries);
    globe = createGlobe($('globe'), data.world, countries, bus, { autoRotate: true });
  } catch (err) {
    console.error(err);
    ui.setLoading(true, 'Sorry — the globe could not load. Please refresh.');
    return;
  } finally {
    if (globe) ui.setLoading(false);
  }

  // Selection → panel + photos. One in-flight image request at a time.
  let imageAbort: AbortController | null = null;
  bus.on('globe:select', ({ iso3 }) => {
    const record = countries[iso3];
    if (!record) return;
    globe?.setSelected(iso3);
    ui.showCountry(record);

    imageAbort?.abort();
    const ac = new AbortController();
    imageAbort = ac;
    fetchCountryImages(record, { signal: ac.signal, count: 5 })
      .then((images) => {
        if (ac.signal.aborted) return;
        if (images.length) ui.setImages(iso3, images);
        else ui.setImagesFailed(iso3);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        console.warn('Image fetch failed', e);
        ui.setImagesFailed(iso3);
      });
  });

  bus.on('ui:flyTo', ({ iso3 }) => {
    void globe?.flyTo(iso3);
  });

  bus.on('ui:close', () => {
    imageAbort?.abort();
    globe?.setSelected(null);
  });

  // Deep link: #FRA opens France on load.
  const hash = location.hash.replace('#', '').toUpperCase();
  if (hash && countries[hash]) {
    bus.emit('ui:flyTo', { iso3: hash });
    bus.emit('globe:select', { iso3: hash });
  }
  bus.on('globe:select', ({ iso3 }) => history.replaceState(null, '', `#${iso3}`));
  bus.on('ui:close', () => history.replaceState(null, '', location.pathname + location.search));
}

// Expose the bus for the smoke test / console tinkering.
declare global {
  interface Window { __gp?: { bus: typeof bus } }
}
window.__gp = { bus };

boot().catch((e) => console.error('Globalpedia failed to start', e));
