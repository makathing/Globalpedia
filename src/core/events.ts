/**
 * Typed event bus. The ONLY channel between globe, ui and data modules.
 *
 *  globe:select  – user clicked a country / label on the globe
 *  globe:hover   – pointer is over a country (null when leaving)
 *  ui:flyTo      – UI asks the globe to rotate to a country (search, neighbour chip)
 *  ui:close      – the info panel closed (globe may resume auto-rotate)
 *  data:ready    – country data has loaded
 *  ui:theme      – the viewer picked a theme; the globe repaints itself
 */
import type { CountryRecord } from './types';
import type { ThemeId } from './themes';

export interface EventMap {
  'globe:select': { iso3: string };
  'globe:hover': { iso3: string | null };
  'ui:flyTo': { iso3: string };
  'ui:close': Record<string, never>;
  'data:ready': { countries: Record<string, CountryRecord> };
  'ui:theme': { id: ThemeId };
}

export type EventName = keyof EventMap;

export class EventBus {
  private target = new EventTarget();

  emit<K extends EventName>(name: K, detail: EventMap[K]): void {
    this.target.dispatchEvent(new CustomEvent(name, { detail }));
  }

  on<K extends EventName>(name: K, handler: (detail: EventMap[K]) => void): () => void {
    const listener = (e: Event) => handler((e as CustomEvent<EventMap[K]>).detail);
    this.target.addEventListener(name, listener);
    return () => this.target.removeEventListener(name, listener);
  }

  once<K extends EventName>(name: K, handler: (detail: EventMap[K]) => void): void {
    const off = this.on(name, (d) => {
      off();
      handler(d);
    });
  }
}

/** Shared singleton. Modules may also accept a bus via their factory for testing. */
export const bus = new EventBus();
