/** Constant inline SVG markup. Only these strings may be passed to dom.svg(). */

/** Hand-drawn style school globe on a stand (header mark). */
export const GLOBE_MARK = `
<svg viewBox="0 0 48 48" width="40" height="40" xmlns="http://www.w3.org/2000/svg">
  <circle cx="24" cy="20" r="15" fill="var(--gp-ocean)" stroke="var(--gp-ink)" stroke-width="1.8"/>
  <path d="M11 15c5-4 9 2 14 0s7-4 12-1" fill="none" stroke="var(--gp-ink)" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M9.5 23c6 3 11-2 15 1s9 3 14-1" fill="none" stroke="var(--gp-ink)" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M14 30c4 2 8-1 12 1s6 1 9-1" fill="none" stroke="var(--gp-ink)" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M16 11c2 3 3 6 2 9s-3 4-2 8" fill="var(--gp-land)" stroke="var(--gp-ink)" stroke-width="1.1" stroke-linejoin="round"/>
  <path d="M28 9c3 1 6 4 5 7s-4 4-3 7 3 4 1 7" fill="var(--gp-land)" stroke="var(--gp-ink)" stroke-width="1.1" stroke-linejoin="round"/>
  <path d="M24 5.5v-2M24 34.5v2.5" stroke="var(--gp-ink)" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M9 20a15 15 0 0 0 4 19" fill="none" stroke="var(--gp-brass)" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M13 39c2.5 3 6 4.5 11 4.5s8.5-1.5 11-4.5" fill="none" stroke="var(--gp-ink)" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M24 37v6.5" stroke="var(--gp-ink)" stroke-width="1.8" stroke-linecap="round"/>
  <ellipse cx="24" cy="45" rx="9" ry="1.8" fill="var(--gp-brass)" stroke="var(--gp-ink)" stroke-width="1.4"/>
</svg>`;

/** Small globe for the loading overlay (rotated by CSS). */
export const GLOBE_SPINNER = `
<svg viewBox="0 0 64 64" width="56" height="56" xmlns="http://www.w3.org/2000/svg">
  <circle cx="32" cy="32" r="28" fill="var(--gp-ocean)" stroke="var(--gp-ink)" stroke-width="2"/>
  <g class="gp-spinner__land">
    <path d="M14 22c6-6 12 2 18-1s10-5 18-2" fill="none" stroke="var(--gp-ink)" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M8 34c8 4 15-3 21 1s12 4 27-1" fill="none" stroke="var(--gp-ink)" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M16 46c6 3 11-2 17 1s9 1 15-2" fill="none" stroke="var(--gp-ink)" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M22 10c3 4 4 8 2 12s-4 6-2 11" fill="var(--gp-land)" stroke="var(--gp-ink)" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M40 9c4 2 8 6 7 10s-5 6-4 10 4 6 1 10" fill="var(--gp-land)" stroke="var(--gp-ink)" stroke-width="1.3" stroke-linejoin="round"/>
  </g>
  <ellipse cx="32" cy="32" rx="28" ry="9" fill="none" stroke="var(--gp-ink)" stroke-width="1" opacity=".35"/>
</svg>`;

export const ICON_SEARCH = `
<svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
  <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/>
  <path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;

export const ICON_CLOSE = `
<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
  <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

export const ICON_CHEVRON_LEFT = `
<svg viewBox="0 0 24 24" width="28" height="28" xmlns="http://www.w3.org/2000/svg">
  <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const ICON_CHEVRON_RIGHT = `
<svg viewBox="0 0 24 24" width="28" height="28" xmlns="http://www.w3.org/2000/svg">
  <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const ICON_EXTERNAL = `
<svg viewBox="0 0 24 24" width="14" height="14" xmlns="http://www.w3.org/2000/svg">
  <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/**
 * Theme picker: a fan of three colored pencils. Like GLOBE_MARK it is painted
 * from the theme tokens, so the icon restyles itself along with the page.
 */
export const ICON_THEME = `
<svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg">
  <g stroke="var(--gp-ink)" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">
    <g transform="translate(12 21) rotate(-20)">
      <path d="M-2.4 -17h4.8v12.2l-2.4 4-2.4-4z" fill="var(--gp-blue)"/>
      <path d="M-2.4 -4.8h4.8" fill="none"/>
    </g>
    <g transform="translate(12 21) rotate(20)">
      <path d="M-2.4 -17h4.8v12.2l-2.4 4-2.4-4z" fill="var(--gp-land)"/>
      <path d="M-2.4 -4.8h4.8" fill="none"/>
    </g>
    <g transform="translate(12 21)">
      <path d="M-2.4 -18.5h4.8v13.7l-2.4 4-2.4-4z" fill="var(--gp-accent)"/>
      <path d="M-2.4 -4.8h4.8" fill="none"/>
    </g>
  </g>
</svg>`;

export const ICON_CAMERA = `
<svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.5-2h5L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
  <circle cx="12" cy="13" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/>
</svg>`;

/** Bottom-sheet grabber affordance: a chevron that points the way the sheet will move. */
export const ICON_CHEVRON_UP = `
<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
  <path d="M5 15l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
