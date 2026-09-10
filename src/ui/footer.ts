/** One-line footer with data credits. */
import { el, clear } from './dom';

export function renderFooter(container: HTMLElement): () => void {
  container.classList.add('gp-footer');
  clear(container);
  container.append(
    el(
      'p',
      { class: 'gp-footer__credits' },
      'Borders: ',
      el('a', { href: 'https://www.naturalearthdata.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Natural Earth' }),
      ' · Facts: ',
      el('a', { href: 'https://github.com/mledoze/countries', target: '_blank', rel: 'noopener noreferrer', text: 'mledoze/countries' }),
      ' · Photos & text links: ',
      el('a', { href: 'https://www.wikipedia.org/', target: '_blank', rel: 'noopener noreferrer', text: 'Wikipedia' }),
      ' / ',
      el('a', { href: 'https://commons.wikimedia.org/', target: '_blank', rel: 'noopener noreferrer', text: 'Wikimedia Commons' }),
      ' (CC BY-SA)',
    ),
    el('p', { class: 'gp-footer__note', text: 'Made for curious kids' }),
  );
  return () => {
    clear(container);
    container.classList.remove('gp-footer');
  };
}
