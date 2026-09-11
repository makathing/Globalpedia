/**
 * Header: brand mark + wordmark + tagline, and a typeahead country search
 * (ARIA combobox/listbox). Choosing a result emits ui:flyTo then globe:select.
 */
import type { EventBus } from '../core/events';
import type { CountryRecord } from '../core/types';
import { el, clear, svg, on } from './dom';
import { GLOBE_MARK, ICON_SEARCH } from './icons';

interface SearchEntry {
  iso3: string;
  name: string;
  officialName: string;
  capital: string;
  flagEmoji: string;
  independent: boolean;
  nameL: string;
  officialL: string;
  capitalL: string;
  iso3L: string;
}

export interface HeaderHandle {
  setCountries(countries: Record<string, CountryRecord>): void;
  dispose(): void;
}

const MAX_RESULTS = 8;

function score(entry: SearchEntry, q: string): number {
  // Lower is better. -1 = no match.
  if (entry.nameL.startsWith(q)) return 0;
  if (entry.nameL.split(/\s+/).some((w) => w.startsWith(q))) return 1;
  if (entry.iso3L.startsWith(q)) return 2;
  if (entry.capitalL.startsWith(q)) return 3;
  if (entry.nameL.includes(q)) return 4;
  if (entry.officialL.includes(q)) return 5;
  if (entry.capitalL.includes(q)) return 6;
  return -1;
}

export function renderHeader(container: HTMLElement, bus: EventBus): HeaderHandle {
  container.classList.add('gp-header');
  clear(container);

  let entries: SearchEntry[] = [];
  let results: SearchEntry[] = [];
  let activeIndex = -1;
  const disposers: Array<() => void> = [];

  // --- Brand -----------------------------------------------------------
  const brand = el(
    'a',
    { class: 'gp-brand', href: './', 'aria-label': 'Globalpedia home' },
    svg(GLOBE_MARK, 'gp-brand__mark'),
    el(
      'span',
      { class: 'gp-brand__text' },
      el('span', { class: 'gp-brand__name', text: 'Globalpedia' }),
      el('span', { class: 'gp-brand__tagline', text: 'Spin the world. Tap a country.' }),
    ),
  );

  // --- Search ----------------------------------------------------------
  const listId = 'gp-search-listbox';
  const input = el('input', {
    class: 'gp-search__input',
    type: 'search',
    placeholder: 'Find a country or capital…',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': listId,
    'aria-haspopup': 'listbox',
    'aria-label': 'Search countries',
    enterkeyhint: 'go',
  });
  const listbox = el('ul', { class: 'gp-search__list', id: listId, role: 'listbox', hidden: true, 'aria-label': 'Matching countries' });
  const search = el(
    'div',
    { class: 'gp-search' },
    el('label', { class: 'gp-search__field' }, svg(ICON_SEARCH, 'gp-search__icon'), input),
    listbox,
  );

  container.append(brand, search);

  function openList(): void {
    listbox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function closeList(): void {
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
    results = [];
    clear(listbox);
  }

  function setActive(index: number): void {
    const items = Array.from(listbox.children) as HTMLElement[];
    if (!items.length) return;
    activeIndex = ((index % items.length) + items.length) % items.length;
    items.forEach((li, i) => {
      const isActive = i === activeIndex;
      li.setAttribute('aria-selected', String(isActive));
      li.classList.toggle('is-active', isActive);
      if (isActive) {
        input.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function choose(entry: SearchEntry): void {
    input.value = entry.name;
    closeList();
    bus.emit('ui:flyTo', { iso3: entry.iso3 });
    bus.emit('globe:select', { iso3: entry.iso3 });
    input.blur();
  }

  function renderResults(): void {
    clear(listbox);
    if (!results.length) {
      listbox.append(el('li', { class: 'gp-search__empty', role: 'option', 'aria-disabled': 'true', text: 'No matching country' }));
      openList();
      return;
    }
    results.forEach((entry, i) => {
      const li = el(
        'li',
        { class: 'gp-search__option', role: 'option', id: `gp-search-opt-${i}`, 'aria-selected': 'false' },
        el('span', { class: 'gp-search__flag', 'aria-hidden': 'true', text: entry.flagEmoji }),
        el('span', { class: 'gp-search__name', text: entry.name }),
        entry.capital ? el('span', { class: 'gp-search__meta', text: entry.capital }) : null,
      );
      // pointerdown so the choice registers before the input blurs.
      li.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        choose(entry);
      });
      li.addEventListener('pointerenter', () => setActive(i));
      listbox.append(li);
    });
    openList();
    setActive(0);
  }

  function update(): void {
    const q = input.value.trim().toLowerCase();
    if (q.length < 1 || !entries.length) {
      closeList();
      return;
    }
    results = entries
      .map((entry) => ({ entry, s: score(entry, q) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => a.s - b.s || Number(b.entry.independent) - Number(a.entry.independent) || a.entry.name.localeCompare(b.entry.name))
      .slice(0, MAX_RESULTS)
      .map((r) => r.entry);
    renderResults();
  }

  disposers.push(on(input, 'input', update));
  disposers.push(
    on(input, 'focus', () => {
      if (input.value.trim()) update();
    }),
  );
  disposers.push(
    on(input, 'keydown', (ev) => {
      const isOpen = !listbox.hidden;
      switch (ev.key) {
        case 'ArrowDown':
          ev.preventDefault();
          if (!isOpen) update();
          else setActive(activeIndex + 1);
          break;
        case 'ArrowUp':
          ev.preventDefault();
          if (isOpen) setActive(activeIndex - 1);
          break;
        case 'Enter': {
          if (isOpen && results[activeIndex]) {
            ev.preventDefault();
            choose(results[activeIndex]);
          } else if (!isOpen) {
            update();
            if (results.length === 1) choose(results[0]);
          }
          break;
        }
        case 'Escape':
          if (isOpen) {
            ev.preventDefault();
            ev.stopPropagation(); // don't also close the panel
            closeList();
          } else if (input.value) {
            ev.stopPropagation();
            input.value = '';
          }
          break;
        default:
          break;
      }
    }),
  );
  disposers.push(
    on(input, 'blur', () => {
      // Delay so a pointerdown on an option wins.
      setTimeout(() => {
        if (document.activeElement !== input) closeList();
      }, 120);
    }),
  );

  // The countries map arrives via createUI(), which owns it — see src/ui/index.ts.

  function setCountries(countries: Record<string, CountryRecord>): void {
    entries = Object.values(countries).map((c) => ({
      iso3: c.iso3,
      name: c.name,
      officialName: c.officialName,
      capital: c.capital.join(', '),
      flagEmoji: c.flagEmoji,
      independent: c.independent,
      nameL: c.name.toLowerCase(),
      officialL: c.officialName.toLowerCase(),
      capitalL: c.capital.join(', ').toLowerCase(),
      iso3L: c.iso3.toLowerCase(),
    }));
    if (document.activeElement === input && input.value.trim()) update();
  }

  return {
    setCountries,
    dispose() {
      disposers.forEach((off) => off());
      clear(container);
      container.classList.remove('gp-header');
    },
  };
}
