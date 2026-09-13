/** Stage overlays: the loading card and the first-use hint caption. */
import type { EventBus } from '../core/events';
import { el, svg, type Child } from './dom';
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
  let frame = 0;

  return {
    set(on, text) {
      window.clearTimeout(timer);
      // Cancel the pending reveal too: a set(true) immediately followed by
      // set(false) used to let the queued frame re-add `is-visible` after the
      // removal, leaving a dismissed overlay claiming pointer events.
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (text) message.textContent = text;
      if (on) {
        box.hidden = false;
        // next frame so the transition runs
        frame = requestAnimationFrame(() => {
          frame = 0;
          box.classList.add('is-visible');
        });
      } else {
        box.classList.remove('is-visible');
        timer = window.setTimeout(() => {
          box.hidden = true;
        }, 300);
      }
    },
    dispose() {
      window.clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      box.remove();
    },
  };
}

export interface HintHandle {
  dispose(): void;
}

export function createHint(stage: HTMLElement, bus: EventBus): HintHandle {
  // "Scroll to zoom" is a lie on a phone, and so is "click". Ask the pointer.
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const steps = coarse
    ? ['Drag to spin', 'Pinch to zoom', 'Tap a country']
    : ['Drag to spin', 'Scroll to zoom', 'Click a country name'];

  const parts: Child[] = [];
  steps.forEach((step, i) => {
    if (i) parts.push(el('span', { class: 'gp-hint__dot', 'aria-hidden': 'true', text: '·' }));
    parts.push(el('span', { class: 'gp-hint__step', text: step }));
  });
  const hint = el('p', { class: 'gp-hint' }, ...parts);
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
