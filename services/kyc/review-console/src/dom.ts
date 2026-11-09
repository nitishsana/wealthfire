// Tiny DOM builder. Text always goes through textContent, never innerHTML, so case data can
// never inject markup.
type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

/** Replace main's content and move focus to its first heading (for screen readers + keyboard). */
export function show(...nodes: (Node | null | undefined | false)[]): void {
  const main = document.getElementById('main') as HTMLElement;
  main.replaceChildren(...nodes.filter((n): n is Node => n instanceof Node));
  const heading = main.querySelector<HTMLElement>('h1, h2');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus();
  } else {
    main.focus();
  }
}

export function announce(text: string): void {
  const s = document.getElementById('status');
  if (s) s.textContent = text;
}

export function when(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}
