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
  | 'wizard';
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
];

function parse(): Route {
  const name = location.hash.replace(/^#\/?/, '') as Route;
  return ROUTES.includes(name) ? name : 'home';
}

export const route = signal<Route>(typeof location === 'undefined' ? 'home' : parse());

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    route.value = parse();
  });
}

export function go(to: Route): void {
  location.hash = to === 'home' ? '' : `/${to}`;
}

export function back(): void {
  if (history.length > 1) history.back();
  else go('home');
}
