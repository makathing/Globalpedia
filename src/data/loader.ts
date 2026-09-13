/**
 * Loads the build-time data bundles (public/data/*) relative to the deployed
 * base URL, so it works at "/" and under GitHub Pages sub-paths alike.
 */
import type { Topology } from 'topojson-specification';
import type { CountriesFile, CountryRecord } from '../core/types';
import type { EventBus } from '../core/events';

export const WORLD_FILE = 'data/world-50m.json';
export const COUNTRIES_FILE = 'data/countries.json';

/** Absolute URL for a file under public/, honouring Vite's `base`. */
export function dataUrl(relativePath: string): string {
  let base: string = import.meta.env?.BASE_URL ?? './';
  if (!base.endsWith('/')) base += '/';
  const path = relativePath.replace(/^\/+/, '');
  return new URL(base + path, document.baseURI).href;
}

async function fetchJson<T>(url: string, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`Network error while loading ${what} from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new Error(`Failed to load ${what}: ${url} responded ${res.status} ${res.statusText}. Did \`npm run build:data\` run?`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new Error(`${what} at ${url} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** TopoJSON topology with `objects.countries` (geometry ids = ISO3) and `objects.land`. */
export async function loadWorld(): Promise<Topology> {
  const url = dataUrl(WORLD_FILE);
  const topo = await fetchJson<Topology>(url, 'world topology');
  if (!topo || topo.type !== 'Topology' || !topo.objects || !('countries' in topo.objects)) {
    throw new Error(`World topology at ${url} is missing objects.countries`);
  }
  return topo;
}

/** The full countries file including `generatedAt`. */
export async function loadCountriesFile(): Promise<CountriesFile> {
  const url = dataUrl(COUNTRIES_FILE);
  const file = await fetchJson<CountriesFile>(url, 'country data');
  if (!file || typeof file.countries !== 'object' || file.countries === null) {
    throw new Error(`Country data at ${url} has no \`countries\` map`);
  }
  return file;
}

/** Country records keyed by ISO3. */
export async function loadCountries(): Promise<Record<string, CountryRecord>> {
  return (await loadCountriesFile()).countries;
}

export interface LoadedData {
  world: Topology;
  countries: Record<string, CountryRecord>;
}

/** Load both bundles in parallel and announce `data:ready` on the bus. */
export async function loadAll(bus: EventBus): Promise<LoadedData> {
  const [world, countries] = await Promise.all([loadWorld(), loadCountries()]);
  bus.emit('data:ready', { countries });
  return { world, countries };
}
