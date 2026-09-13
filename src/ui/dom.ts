/**
 * Tiny DOM helpers. All user/data text goes through textContent — never innerHTML.
 * `svg()` is the single exception and must only ever receive the constant
 * markup strings from ./icons.ts.
 */

export type Child = Node | string | number | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | null | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/** Build an SVG element from a CONSTANT markup string (icons.ts only). */
export function svg(markup: string, className?: string): SVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  const node = tpl.content.firstElementChild as SVGElement;
  if (className) node.classList.add(...className.split(' '));
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  return node;
}

export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | Document | Window,
  type: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler as EventListener, options);
  return () => target.removeEventListener(type, handler as EventListener, options);
}

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
