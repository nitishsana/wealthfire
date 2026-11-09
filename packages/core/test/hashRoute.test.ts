import { describe, expect, it } from 'vitest';
import { pathToHashRoute } from '../src';

const ROUTES = ['profile', 'settings', 'expenses'];
const loc = (pathname: string, search = '', hash = '') => ({ pathname, search, hash });

describe('pathToHashRoute (web path links open the section)', () => {
  it('turns a known path into a hash route and keeps the query', () => {
    expect(pathToHashRoute(loc('/profile', '?preview=demo'), '/', ROUTES)).toBe('/?preview=demo#/profile');
    expect(pathToHashRoute(loc('/settings/', '?server=off'), '/', ROUTES)).toBe('/?server=off#/settings');
    expect(pathToHashRoute(loc('/expenses'), '/', ROUTES)).toBe('/#/expenses');
  });

  it('works under the GitHub Pages base', () => {
    expect(pathToHashRoute(loc('/wealthfire/profile', '?x=1'), '/wealthfire/', ROUTES)).toBe('/wealthfire/?x=1#/profile');
    expect(pathToHashRoute(loc('/wealthfire/profile'), '/wealthfire', ROUTES)).toBe('/wealthfire/#/profile');
    expect(pathToHashRoute(loc('/profile'), '/wealthfire/', ROUTES)).toBeNull();
  });

  it('leaves the root, unknown paths and existing hash routes alone', () => {
    expect(pathToHashRoute(loc('/'), '/', ROUTES)).toBeNull();
    expect(pathToHashRoute(loc('/nope', '?preview=demo'), '/', ROUTES)).toBeNull();
    expect(pathToHashRoute(loc('/profile/extra'), '/', ROUTES)).toBeNull();
    expect(pathToHashRoute(loc('/profile', '', '#/settings'), '/', ROUTES)).toBeNull();
    expect(pathToHashRoute(loc('/profile', '', '#/'), '/', ROUTES)).toBe('/#/profile');
  });
});
