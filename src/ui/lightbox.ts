/** Photo lightbox: <dialog>, ← → navigation, Esc / click-outside close, focus restore. */
import type { CountryImage } from '../core/types';
import { el, clear, svg, on } from './dom';
import { ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT, ICON_CLOSE, ICON_EXTERNAL } from './icons';

export interface LightboxHandle {
  open(images: CountryImage[], index: number, returnFocusTo?: HTMLElement | null): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function createLightbox(): LightboxHandle {
  let images: CountryImage[] = [];
  let index = 0;
  let returnFocus: HTMLElement | null = null;
  const disposers: Array<() => void> = [];

  const img = el('img', { class: 'gp-lightbox__img', alt: '', decoding: 'async' });
  const caption = el('p', { class: 'gp-lightbox__caption' });
  const credit = el('p', { class: 'gp-lightbox__credit' });
  const counter = el('span', { class: 'gp-lightbox__counter' });

  const prevBtn = el('button', { class: 'gp-lightbox__nav gp-lightbox__nav--prev', type: 'button', 'aria-label': 'Previous photo' }, svg(ICON_CHEVRON_LEFT));
  const nextBtn = el('button', { class: 'gp-lightbox__nav gp-lightbox__nav--next', type: 'button', 'aria-label': 'Next photo' }, svg(ICON_CHEVRON_RIGHT));
  const closeBtn = el('button', { class: 'gp-lightbox__close', type: 'button', 'aria-label': 'Close photo' }, svg(ICON_CLOSE));

  const figure = el(
    'figure',
    { class: 'gp-lightbox__figure' },
    el('div', { class: 'gp-lightbox__stage' }, img),
    el('figcaption', { class: 'gp-lightbox__info' }, caption, credit, counter),
  );

  const dialog = el('dialog', { class: 'gp-lightbox', 'aria-label': 'Photo viewer' }, closeBtn, prevBtn, figure, nextBtn);
  document.body.append(dialog);

  /** Size the image box up front from width/height so nothing jumps when it loads. */
  function fit(): void {
    const image = images[index];
    if (!image || !dialog.open) return;
    const maxW = window.innerWidth * 0.92;
    const maxH = window.innerHeight * 0.76;
    const ratio = image.width > 0 && image.height > 0 ? image.width / image.height : 3 / 2;
    let w = Math.min(maxW, image.width > 0 ? Math.max(image.width, 320) : maxW);
    let h = w / ratio;
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }
    img.style.width = `${Math.round(w)}px`;
    img.style.height = `${Math.round(h)}px`;
  }

  function render(): void {
    const image = images[index];
    if (!image) return;
    img.src = image.url || image.thumbUrl;
    img.alt = image.title;
    fit();
    caption.textContent = image.title;
    clear(credit);
    const bits: string[] = [];
    if (image.credit) bits.push(image.credit);
    if (image.license) bits.push(image.license);
    if (bits.length || image.sourcePage) {
      credit.append(
        el('a', { href: image.sourcePage, target: '_blank', rel: 'noopener noreferrer' }, bits.length ? bits.join(' · ') : 'Source', ' ', svg(ICON_EXTERNAL)),
      );
    }
    counter.textContent = images.length > 1 ? `${index + 1} / ${images.length}` : '';
    const multi = images.length > 1;
    prevBtn.hidden = !multi;
    nextBtn.hidden = !multi;
  }

  function step(delta: number): void {
    if (!images.length) return;
    index = (index + delta + images.length) % images.length;
    render();
  }

  function isOpen(): boolean {
    return dialog.open;
  }

  function close(): void {
    if (dialog.open) dialog.close();
  }

  function open(list: CountryImage[], start: number, returnFocusTo?: HTMLElement | null): void {
    images = list.filter((i) => i && (i.url || i.thumbUrl));
    if (!images.length) return;
    index = Math.min(Math.max(start, 0), images.length - 1);
    returnFocus = returnFocusTo ?? (document.activeElement as HTMLElement | null);
    render();
    if (!dialog.open) dialog.showModal();
    fit();
    closeBtn.focus();
  }

  disposers.push(on(window, 'resize', fit));
  disposers.push(on(prevBtn, 'click', () => step(-1)));
  disposers.push(on(nextBtn, 'click', () => step(1)));
  disposers.push(on(closeBtn, 'click', close));

  // Click on the backdrop (the dialog element itself, outside the figure) closes.
  disposers.push(
    on(dialog, 'click', (ev) => {
      if (ev.target === dialog) close();
    }),
  );

  disposers.push(
    on(dialog, 'keydown', (ev) => {
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        step(-1);
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        step(1);
      } else if (ev.key === 'Tab') {
        // Trap focus inside the dialog.
        const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => !n.hidden && n.offsetParent !== null);
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (ev.shiftKey && document.activeElement === first) {
          ev.preventDefault();
          last.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
          ev.preventDefault();
          first.focus();
        }
      }
      // Esc is handled natively by <dialog> (cancel → close). Stop it reaching the panel.
      if (ev.key === 'Escape') ev.stopPropagation();
    }),
  );

  disposers.push(
    on(dialog, 'close', () => {
      img.removeAttribute('src');
      const target = returnFocus;
      returnFocus = null;
      if (target && target.isConnected) target.focus();
    }),
  );

  return {
    open,
    close,
    isOpen,
    dispose() {
      disposers.forEach((off) => off());
      close();
      dialog.remove();
    },
  };
}
