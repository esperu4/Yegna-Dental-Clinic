/** Tiny hash router: works offline and needs no server rewrites. */
import { signal } from '@preact/signals';

export type Route =
  | 'home'
  | 'calls'
  | 'approvals'
  | 'settings'
  | 'users'
  | 'devices'
  | 'procedures'
  | 'hours'
  | 'holidays'
  | 'wizard'
  | 'print'
  | 'imports';
const ROUTES: readonly Route[] = [
  'home',
  'calls',
  'approvals',
  'settings',
  'users',
  'devices',
  'procedures',
  'hours',
  'holidays',
  'wizard',
  'print',
  'imports',
];

/** `#/imports/<id>` ⇒ route `imports`, param `<id>` (one optional parameter per route). */
export function parseHash(hash: string): { route: Route; param: string | null } {
  const [name = '', param] = hash.replace(/^#\/?/, '').split('/');
  const known = ROUTES.includes(name as Route);
  return {
    route: known ? (name as Route) : 'home',
    param: known && param ? decodeURIComponent(param) : null,
  };
}

const initial = typeof location === 'undefined' ? parseHash('') : parseHash(location.hash);
export const route = signal<Route>(initial.route);
/** The current route's parameter, e.g. an import id. */
export const routeParam = signal<string | null>(initial.param);

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const next = parseHash(location.hash);
    route.value = next.route;
    routeParam.value = next.param;
  });
}

export function go(to: Route, param?: string): void {
  location.hash = to === 'home' ? '' : `/${to}${param ? `/${encodeURIComponent(param)}` : ''}`;
}

export function back(): void {
  if (history.length > 1) history.back();
  else go('home');
}
