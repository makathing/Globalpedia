/**
 * Theme controller — the single owner of `<html data-theme>` and of the inline
 * custom properties that carry a theme onto the document element.
 *
 * `src/core/themes.ts` is the source of truth: nothing here hand-writes a color.
 * `set()` walks the chosen theme's `css` map and calls setProperty() for each
 * entry, so app.css only ever has to name tokens, never enumerate themes.
 *
 * Two things this module must not do:
 *  1. apply --gp-margin-x / --gp-gutter / --gp-panel-w — they are responsive in
 *     app.css and an inline value on <html> would beat the media queries. The
 *     table already omits them; RESPONSIVE below is a belt-and-braces guard.
 *  2. disagree with the pre-paint script in index.html, which has already read
 *     `gp:theme` and stamped data-theme before first paint. On startup an
 *     already-set data-theme is taken as authoritative and the full token set is
 *     applied over the top, so there is no flash and no second resolution.
 */
import type { EventBus } from '../core/events';
import {
  DEFAULT_DARK_THEME,
  DEFAULT_THEME,
  isThemeId,
  themeById,
  type Theme,
  type ThemeId,
} from '../core/themes';
import { el } from './dom';

/** Same `gp:` namespace as the photo cache in src/data/images.ts. */
const STORAGE_KEY = 'gp:theme';

/** Set responsively in app.css — never applied inline. See the note above. */
const RESPONSIVE = new Set(['--gp-margin-x', '--gp-gutter', '--gp-panel-w']);

export interface ThemeController {
  /** The theme currently painted on the document. */
  current(): Theme;
  /**
   * Apply a theme: inline properties on <html>, `ui:theme` on the bus (the globe
   * repaints from it) and a live-region announcement. `persist: false` applies
   * without remembering the choice — used for the startup pass and for following
   * the OS. Idempotent: calling it with the theme already showing is a no-op
   * beyond re-asserting the properties.
   */
  set(id: ThemeId, opts?: { persist?: boolean }): void;
  dispose(): void;
}

/** localStorage throws outright in some privacy modes — never let that bubble. */
function readSaved(): ThemeId | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isThemeId(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeSaved(id: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* quota / privacy mode — the theme still applies for this visit */
  }
}

export function createThemeController(bus: EventBus): ThemeController {
  const root = document.documentElement;
  const disposers: Array<() => void> = [];

  const status = el('div', {
    class: 'gp-visually-hidden',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });
  document.body.appendChild(status);

  let currentId: ThemeId | null = null;
  /** Property names applied last time, so a theme with fewer keys cleans up. */
  let applied: string[] = [];

  function paint(theme: Theme): void {
    const next: string[] = [];
    for (const [name, value] of Object.entries(theme.css)) {
      if (RESPONSIVE.has(name)) continue;
      root.style.setProperty(name, value);
      next.push(name);
    }
    for (const name of applied) {
      if (!next.includes(name)) root.style.removeProperty(name);
    }
    applied = next;
    root.setAttribute('data-theme', theme.id);
    // index.html paints <html> with the paper color before first paint so there is
    // no flash; keep it in step or it would be stale from the second theme on.
    const paper = theme.css['--gp-paper'];
    if (paper) root.style.backgroundColor = paper;
  }

  function set(id: ThemeId, opts?: { persist?: boolean }): void {
    const persist = opts?.persist !== false;
    const theme = themeById(id);
    const previous = currentId;

    paint(theme);
    if (persist) {
      writeSaved(theme.id);
      stopFollowingSystem();
    }
    currentId = theme.id;
    bus.emit('ui:theme', { id: theme.id });
    // Silent on the startup pass — only a real change is worth announcing.
    if (previous !== null && previous !== theme.id) status.textContent = `${theme.name} theme`;
  }

  // --- startup resolution ------------------------------------------------
  // A saved choice wins; then whatever the pre-paint script settled on; then the
  // OS preference. `following` stays true only while the viewer has never chosen.
  const saved = readSaved();
  const preset = root.getAttribute('data-theme');
  const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

  let following = saved === null;
  let stopFollowing: (() => void) | null = null;

  function stopFollowingSystem(): void {
    following = false;
    stopFollowing?.();
    stopFollowing = null;
  }

  const initial: ThemeId = saved
    ? saved
    : isThemeId(preset)
      ? preset
      : query?.matches
        ? DEFAULT_DARK_THEME
        : DEFAULT_THEME;

  set(initial, { persist: false });

  if (following && query && typeof query.addEventListener === 'function') {
    const onChange = (ev: MediaQueryListEvent): void => {
      if (!following) return;
      set(ev.matches ? DEFAULT_DARK_THEME : DEFAULT_THEME, { persist: false });
    };
    query.addEventListener('change', onChange);
    stopFollowing = () => query.removeEventListener('change', onChange);
    disposers.push(() => stopFollowing?.());
  }

  return {
    current: () => themeById(currentId),
    set,
    dispose() {
      disposers.forEach((off) => off());
      status.remove();
      // The applied properties stay put: tearing them off would snap a dark page
      // back to Classroom, which is worse than leaving the document styled.
    },
  };
}
