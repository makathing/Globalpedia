/** Paper-tag hover tooltip following the pointer over the globe. */
import type { EventBus } from '../core/events';
import type { CountryRecord } from '../core/types';
import { el, on } from './dom';

export interface TooltipHandle {
  dispose(): void;
}

export function createTooltip(
  stage: HTMLElement,
  bus: EventBus,
  getCountries: () => Record<string, CountryRecord>,
): TooltipHandle {
  const flag = el('span', { class: 'gp-tooltip__flag', 'aria-hidden': 'true' });
  const name = el('span', { class: 'gp-tooltip__name' });
  const tip = el('div', { class: 'gp-tooltip', role: 'presentation', 'aria-hidden': 'true' }, flag, name);
  stage.append(tip);

  let x = 0;
  let y = 0;
  let visible = false;
  let raf = 0;
  let pending = false;
  let hideTimer = 0;

  function place(): void {
    raf = 0;
    if (!visible) return;
    const rect = stage.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = x - rect.left + 16;
    let top = y - rect.top + 18;
    if (left + w > rect.width - 8) left = x - rect.left - w - 12;
    if (top + h > rect.height - 8) top = y - rect.top - h - 12;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function schedule(): void {
    if (!raf) raf = requestAnimationFrame(place);
  }

  const offMove = on(stage, 'pointermove', (ev) => {
    x = ev.clientX;
    y = ev.clientY;
    if (visible) schedule();
  });

  const offLeave = on(stage, 'pointerleave', () => hide());

  function show(record: CountryRecord): void {
    window.clearTimeout(hideTimer);
    flag.textContent = record.flagEmoji;
    name.textContent = record.name;
    if (!visible) {
      visible = true;
      tip.classList.add('is-visible');
    }
    schedule();
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    tip.classList.remove('is-visible');
  }

  const offHover = bus.on('globe:hover', ({ iso3 }) => {
    // Debounce: coalesce bursts of hover events into one frame.
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (!iso3) {
        hideTimer = window.setTimeout(hide, 60);
        return;
      }
      const record = getCountries()[iso3];
      if (record) show(record);
      else hide();
    });
  });

  // Hide while a country is opened so the tag doesn't sit under the panel.
  const offSelect = bus.on('globe:select', () => hide());

  return {
    dispose() {
      offMove();
      offLeave();
      offHover();
      offSelect();
      if (raf) cancelAnimationFrame(raf);
      tip.remove();
    },
  };
}
