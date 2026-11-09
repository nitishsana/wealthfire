// The web app uses hash routes (#/profile) so deep links work on GitHub Pages. A path link such as
// http://127.0.0.1:5180/profile?preview=demo (or /wealthfire/profile on GitHub Pages) would open Home;
// pathToHashRoute turns it into <base>?<same query>#/profile so the section opens.

/**
 * The URL to switch to (for history.replaceState), or null to leave it alone.
 * - `base`: the Vite base, '/' locally or '/wealthfire/' on GitHub Pages.
 * - Only when there is no hash route yet and the path after `base` is one of `routes` (e.g. 'profile').
 */
export function pathToHashRoute(loc: { pathname: string; search: string; hash: string }, base: string, routes: readonly string[]): string | null {
  if (loc.hash && loc.hash !== '#' && loc.hash !== '#/') return null;
  const b = base.endsWith('/') ? base : `${base}/`;
  if (!loc.pathname.startsWith(b)) return null;
  const route = loc.pathname.slice(b.length).replace(/\/+$/, '');
  if (!route || !routes.includes(route)) return null;
  return `${b}${loc.search}#/${route}`;
}
