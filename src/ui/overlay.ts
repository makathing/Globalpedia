/** Stage overlays: the loading card and the first-use hint caption. */
import type { EventBus } from '../core/events';
import { el, svg } from './dom';
import { GLOBE_SPINNER } from './icons';

export interface LoadingHandle {
  set(on: boolean, message?: string): void;
  dispose(): void;
}

export function createLoading(stage: HTMLElement): LoadingHandle {
  const message = el('p', { class: 'gp-loading__text', text: 'Inflating the globe…' });
  const box = el(
    'div',
    { class: 'gp-loading', role: 'status', 'aria-live': 'polite', hidden: true },
    el('div', { class: 'gp-loading__card' }, svg(GLOBE_SPINNER, 'gp-spinner'), message),
  );
  stage.append(box);
  let timer = 0;

  return {
    set(on, text) {
      window.clearTimeout(timer);
      if (text) message.textContent = text;
      if (on) {
        box.hidden = false;
        // next frame so the transition runs
        requestAnimationFrame(() => box.classList.add('is-visible'));
      } else {
        box.classList.remove('is-visible');
        timer = window.setTimeout(() => {
          box.hidden = true;
        }, 300);
      }
    },
    dispose() {
      window.clearTimeout(timer);
      box.remove();
    },
  };
}

export interface HintHandle {
  dispose(): void;
}

export function createHint(stage: HTMLElement, bus: EventBus): HintHandle {
  const hint = el(
    'p',
    { class: 'gp-hint' },
    el('span', { text: 'Drag to spin' }),
    el('span', { class: 'gp-hint__dot', 'aria-hidden': 'true', text: '·' }),
    el('span', { text: 'Scroll to zoom' }),
    el('span', { class: 'gp-hint__dot', 'aria-hidden': 'true', text: '·' }),
    el('span', { text: 'Tap a country name' }),
  );
  stage.append(hint);
  let timer = 0;

  const off = bus.on('globe:select', () => {
    off();
    hint.classList.add('is-hidden');
    timer = window.setTimeout(() => hint.remove(), 600);
  });

  return {
    dispose() {
      off();
      window.clearTimeout(timer);
      hint.remove();
    },
  };
}
