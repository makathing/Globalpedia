/**
 * Theme picker: a header button that opens a small pinned index card with one
 * row per theme (split-circle swatch, name, blurb).
 *
 * It owns no theme state — it reads the current theme from the controller, calls
 * `set()` on a choice, and re-syncs from the `ui:theme` event, so a theme changed
 * from anywhere else (the OS preference flipping, the console) still updates the
 * label and the checkmark.
 *
 * Menu-button keyboard contract (WAI-ARIA): the button opens with Enter/Space or
 * either arrow and moves focus onto the checked row; inside, Up/Down wrap,
 * Home/End jump, Enter/Space choose, Esc closes and restores focus to the button,
 * and Tab or a click outside closes it.
 */
import type { EventBus } from '../core/events';
import { THEMES, type ThemeId } from '../core/themes';
import { el, on, svg } from './dom';
import { ICON_THEME } from './icons';
import type { ThemeController } from './theme';

export interface ThemeToggleHandle {
  /** The wrapper to place in the header; the popover is positioned against it. */
  element: HTMLElement;
  dispose(): void;
}

export function createThemeToggle(bus: EventBus, theme: ThemeController): ThemeToggleHandle {
  const disposers: Array<() => void> = [];

  const btn = el(
    'button',
    {
      class: 'gp-theme__btn',
      type: 'button',
      'aria-label': 'Change theme',
      'aria-expanded': 'false',
      'aria-haspopup': 'true',
      'data-gp-theme-toggle': true,
    },
    svg(ICON_THEME, 'gp-theme__icon'),
  );

  const heading = el('p', { class: 'gp-theme__heading', id: 'gp-theme-heading', text: 'Theme' });
  const list = el('ul', { class: 'gp-theme__list', role: 'menu', 'aria-labelledby': 'gp-theme-heading' });

  const rows = THEMES.map((t) => {
    const chip = el('span', { class: 'gp-theme__chip', 'aria-hidden': 'true' });
    chip.style.setProperty('--gp-swatch-a', t.swatch[0]);
    chip.style.setProperty('--gp-swatch-b', t.swatch[1]);
    return el(
      'li',
      {
        class: 'gp-theme__row',
        role: 'menuitemradio',
        'aria-checked': 'false',
        tabindex: '-1',
        'data-gp-theme': t.id,
      },
      chip,
      el(
        'span',
        { class: 'gp-theme__meta' },
        el('span', { class: 'gp-theme__name', text: t.name }),
        el('span', { class: 'gp-theme__blurb', text: t.blurb }),
      ),
      el('span', { class: 'gp-theme__tick', 'aria-hidden': 'true', text: '✓' }),
    );
  });
  list.append(...rows);

  const pop = el('div', { class: 'gp-theme__pop', hidden: true }, heading, list);
  const element = el('div', { class: 'gp-theme' }, btn, pop);

  const isOpen = (): boolean => !pop.hidden;

  function checkedRow(): HTMLLIElement {
    return rows.find((r) => r.getAttribute('aria-checked') === 'true') ?? rows[0];
  }

  function sync(id: ThemeId): void {
    let name = '';
    for (const row of rows) {
      const match = row.dataset.gpTheme === id;
      row.setAttribute('aria-checked', String(match));
      if (match) name = row.querySelector('.gp-theme__name')?.textContent ?? '';
    }
    btn.setAttribute('aria-label', name ? `Theme: ${name}. Change theme.` : 'Change theme');
  }

  function open(): void {
    if (isOpen()) return;
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    checkedRow().focus();
  }

  function close(restoreFocus = true): void {
    if (!isOpen()) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) btn.focus();
  }

  function focusRow(index: number): void {
    const i = ((index % rows.length) + rows.length) % rows.length;
    rows[i].focus();
  }

  function move(delta: number): void {
    const from = rows.indexOf(document.activeElement as HTMLLIElement);
    focusRow(from < 0 ? 0 : from + delta);
  }

  function choose(row: HTMLLIElement): void {
    const id = row.dataset.gpTheme;
    if (id) theme.set(id as ThemeId);
    close();
  }

  disposers.push(
    on(btn, 'click', () => {
      if (isOpen()) close();
      else open();
    }),
  );

  disposers.push(
    on(btn, 'keydown', (ev) => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      ev.preventDefault();
      open();
      if (ev.key === 'ArrowUp') focusRow(rows.length - 1);
    }),
  );

  for (const row of rows) {
    disposers.push(on(row, 'click', () => choose(row)));
  }

  disposers.push(
    on(element, 'keydown', (ev) => {
      if (!isOpen()) return;
      switch (ev.key) {
        case 'Escape':
          ev.preventDefault();
          ev.stopPropagation(); // don't also close the info panel
          close();
          break;
        case 'Tab':
          // Let the browser move on from the button, but don't leave the card open.
          close();
          break;
        case 'ArrowDown':
          ev.preventDefault();
          move(1);
          break;
        case 'ArrowUp':
          ev.preventDefault();
          move(-1);
          break;
        case 'Home':
          ev.preventDefault();
          focusRow(0);
          break;
        case 'End':
          ev.preventDefault();
          focusRow(rows.length - 1);
          break;
        case 'Enter':
        case ' ': {
          const row = rows.find((r) => r === document.activeElement);
          if (!row) break;
          ev.preventDefault();
          choose(row);
          break;
        }
        default:
          break;
      }
    }),
  );

  // Click-outside. pointerdown (not click) so it also closes when the press lands
  // on the globe canvas, which swallows the click to start a drag.
  disposers.push(
    on(document, 'pointerdown', (ev) => {
      if (!isOpen()) return;
      if (!element.contains(ev.target as Node)) close(false);
    }),
  );

  disposers.push(bus.on('ui:theme', ({ id }) => sync(id)));
  sync(theme.current().id);

  return {
    element,
    dispose() {
      disposers.forEach((off) => off());
      element.remove();
    },
  };
}
