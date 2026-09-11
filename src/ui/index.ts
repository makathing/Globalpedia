/**
 * Globalpedia UI module — header (search), info panel, tooltip, overlays, footer.
 * Public entry point: createUI(). Talks to other modules only via the EventBus.
 */
import '../styles/app.css';
import type { EventBus } from '../core/events';
import type { CountryImage, CountryRecord } from '../core/types';
import { renderHeader } from './header';
import { renderPanel } from './panel';
import { renderFooter } from './footer';
import { createTooltip } from './tooltip';
import { createHint, createLoading } from './overlay';
import { createThemeController } from './theme';

export interface UIHandle {
  /** Opens/updates the panel immediately with facts + content; photos start in the loading state. */
  showCountry(record: CountryRecord): void;
  /** Fills the photo strip. Ignored if iso3 is no longer the shown country. */
  setImages(iso3: string, images: CountryImage[]): void;
  /** Show fallback tiles for the strip. */
  setImagesFailed(iso3: string): void;
  close(): void;
  /** For search + neighbour names (also auto-called on data:ready). */
  setCountries(countries: Record<string, CountryRecord>): void;
  /** Global "Inflating the globe…" overlay. */
  setLoading(on: boolean, message?: string): void;
  dispose(): void;
}

export interface UIRoot {
  header: HTMLElement;
  panel: HTMLElement;
  footer: HTMLElement;
  stage: HTMLElement;
}

export function createUI(root: UIRoot, bus: EventBus): UIHandle {
  document.documentElement.classList.add('gp-ready');
  let countries: Record<string, CountryRecord> = {};
  const getCountries = () => countries;

  const navigate = (iso3: string): void => {
    bus.emit('ui:flyTo', { iso3 });
    bus.emit('globe:select', { iso3 });
  };

  // Built before the header so the picker can read the theme already applied.
  const theme = createThemeController(bus);
  const header = renderHeader(root.header, bus, { theme });
  const panel = renderPanel(root.panel, bus, { getCountries, onNavigate: navigate });
  const disposeFooter = renderFooter(root.footer);
  const tooltip = createTooltip(root.stage, bus, getCountries);
  const hint = createHint(root.stage, bus);
  const loading = createLoading(root.stage);

  // Single owner of the countries map: whichever path delivers it (the bus or an
  // explicit setCountries call), the header search index is fed the same way.
  const applyCountries = (map: Record<string, CountryRecord>): void => {
    countries = map;
    header.setCountries(map);
  };
  const offReady = bus.on('data:ready', ({ countries: map }) => applyCountries(map));

  // The panel opens itself from the bus; main.ts must not also call showCountry()
  // for the same event or the panel renders twice.
  const offSelect = bus.on('globe:select', ({ iso3 }) => {
    const record = countries[iso3];
    if (record) panel.show(record);
  });

  return {
    showCountry: (record) => panel.show(record),
    setImages: (iso3, images) => panel.setImages(iso3, images),
    setImagesFailed: (iso3) => panel.setImagesFailed(iso3),
    close: () => panel.close(),
    setCountries: applyCountries,
    setLoading: (on, message) => loading.set(on, message),
    dispose() {
      offReady();
      offSelect();
      header.dispose();
      theme.dispose();
      panel.dispose();
      disposeFooter();
      tooltip.dispose();
      hint.dispose();
      loading.dispose();
      document.documentElement.classList.remove('gp-ready');
    },
  };
}
