/**
 * Shared data contracts for Globalpedia.
 * Every module (globe, ui, data) depends on this file and NOTHING else across modules.
 * Do not add module-specific types here.
 */

/** Facts assembled at build time by scripts/build-data.mjs (source: mledoze/countries + world-atlas). */
export interface CountryFacts {
  /** ISO 3166-1 alpha-3, e.g. "FRA". Primary key everywhere. */
  iso3: string;
  /** ISO 3166-1 alpha-2, e.g. "FR". May be "" for Kosovo-style entities. */
  iso2: string;
  /** ISO 3166-1 numeric as a zero-padded string, e.g. "250". "" when none. */
  ccn3: string;
  /** Common English name, e.g. "France". */
  name: string;
  /** Official English name, e.g. "French Republic". */
  officialName: string;
  /** Exact English Wikipedia article title, e.g. "Georgia (country)". */
  wikipediaTitle: string;
  capital: string[];
  /** Continent-level region, e.g. "Europe", "Africa", "Americas", "Asia", "Oceania". */
  region: string;
  subregion: string;
  /** Language names in English, e.g. ["French"]. */
  languages: string[];
  /** e.g. ["Euro (€)"]. */
  currencies: string[];
  /** Square kilometres. */
  area: number;
  /** Most recent population estimate, if a source was available. */
  population?: number;
  /** [latitude, longitude] label anchor / centre. */
  latlng: [number, number];
  landlocked: boolean;
  /** ISO3 codes of land neighbours. */
  borders: string[];
  /** e.g. "French". */
  demonym?: string;
  /** Flag emoji, e.g. "🇫🇷". */
  flagEmoji: string;
  /** Relative URL to the bundled SVG flag, e.g. "data/flags/FRA.svg". */
  flagSvg: string;
  /** True for the 194 independent states (+ Kosovo). Territories are false. */
  independent: boolean;
  /** e.g. "officially-assigned", "user-assigned". */
  status: string;
}

/** Kid-friendly encyclopedia text authored in content/countries/<ISO3>.json. */
export interface CountryContent {
  iso3: string;
  /** One line, max ~8 words, e.g. "Land of a thousand lakes". */
  tagline: string;
  /** 2–3 paragraphs, separated by "\n\n". */
  overview: string;
  /** 1–2 paragraphs. */
  landAndNature: string;
  /** 1–2 paragraphs. */
  peopleAndCulture: string;
  /** 1–2 paragraphs. */
  history: string;
  /** 4–6 short, surprising, true items. */
  funFacts: string[];
  /** Optional phonetic hint, e.g. "KEE-nyuh". */
  pronunciation?: string;
}

/** A photo fetched at runtime from Wikipedia / Wikimedia Commons. */
export interface CountryImage {
  /** Full-size (or large) URL. */
  url: string;
  /** ~900px-wide thumbnail URL for the strip. */
  thumbUrl: string;
  width: number;
  height: number;
  /** Human-readable title / caption, e.g. "Eiffel Tower at dusk". */
  title: string;
  /** Photographer / author, when known. */
  credit?: string;
  /** e.g. "CC BY-SA 4.0". */
  license?: string;
  /** Commons file page URL to link the credit to. */
  sourcePage: string;
}

/** What the UI renders: facts + (optional) authored content. */
export type CountryRecord = CountryFacts & { content?: CountryContent };

/** Shape of public/data/countries.json */
export interface CountriesFile {
  generatedAt: string;
  /** keyed by ISO3 */
  countries: Record<string, CountryRecord>;
}
