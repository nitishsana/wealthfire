import { describe, expect, it } from 'vitest';
import {
  allowedReturnUrl, APP_RETURN_URL, DEFAULT_RETURN_URL_PREFIXES, parseReturnUrlPrefixes, returnUrlPrefixesFromEnv,
} from '../../src/lib/returnUrl';

const DEV = ['https://nitishsana.github.io/wealthfire/', APP_RETURN_URL, 'http://127.0.0.1:5180/'];

describe('return-URL allow-list (R10)', () => {
  it('the default has the app path and the exact deep link, no loopback', () => {
    expect(DEFAULT_RETURN_URL_PREFIXES).toEqual(['https://nitishsana.github.io/wealthfire/', 'wealthfire://kyc-return']);
    expect(DEFAULT_RETURN_URL_PREFIXES.join(',')).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(allowedReturnUrl('http://127.0.0.1:5180/kyc')).toBeNull();
  });

  it('only RETURN_URL_PREFIXES adds the local preview', () => {
    expect(returnUrlPrefixesFromEnv({})).toEqual([...DEFAULT_RETURN_URL_PREFIXES]);
    const dev = returnUrlPrefixesFromEnv({ RETURN_URL_PREFIXES: 'https://nitishsana.github.io/wealthfire/,wealthfire://kyc-return,http://127.0.0.1:5180/' });
    expect(dev).toEqual(DEV);
    expect(allowedReturnUrl('http://127.0.0.1:5180/?kyc=return#/settings', dev)).toBe('http://127.0.0.1:5180/?kyc=return#/settings');
  });

  it('the old bare app scheme entry means the one pinned deep link', () => {
    expect(parseReturnUrlPrefixes(['wealthfire://', 'wealthfire://kyc-return'])).toEqual([APP_RETURN_URL]);
  });

  it('refuses bad entries without echoing them', () => {
    for (const bad of [
      'https://nitishsana.github.io', 'https://nitishsana.github.io/wealthfire', 'http://example.com/', 'http://127.0.0.1/',
      'https://u:p@nitishsana.github.io/w/', 'https://nitishsana.github.io/w/?x=1', 'https://nitishsana.github.io/a/../b/',
      'wealthfire://other', 'javascript:alert(1)//', 'ftp://x/', 'https://NITISHSANA.github.io/w/',
    ]) {
      expect(() => parseReturnUrlPrefixes([bad]), bad).toThrow(/^Bad RETURN_URL_PREFIXES entry$/);
    }
  });
});

describe('return-URL matching (S15)', () => {
  it('accepts URLs under an allowed origin + path, and the exact deep link', () => {
    for (const ok of [
      'https://nitishsana.github.io/wealthfire/',
      'https://nitishsana.github.io/wealthfire/?kyc=return#/settings',
      'https://nitishsana.github.io/wealthfire/kyc/return',
      'wealthfire://kyc-return',
    ]) expect(allowedReturnUrl(ok, DEV), ok).toBe(ok);
  });

  it('returns the normalised URL', () => {
    expect(allowedReturnUrl('https://NITISHSANA.github.io:443/wealthfire/./kyc', DEV)).toBe('https://nitishsana.github.io/wealthfire/kyc');
  });

  it('refuses traversal, look-alikes, other paths and other schemes', () => {
    for (const bad of [
      'https://nitishsana.github.io/wealthfire/../other/',
      'https://nitishsana.github.io/wealthfire/%2e%2e/other/',
      'https://nitishsana.github.io/wealthfire/..%2fother/',
      'https://nitishsana.github.io/wealthfire/..%5Cother/',
      'https://nitishsana.github.io/wealthfire\\..\\other/',
      'https://nitishsana.github.io/wealthfire',
      'https://nitishsana.github.io/wealthfire-evil/',
      'https://nitishsana.github.io/other-app/',
      'https://nitishsana.github.io.evil.example/wealthfire/',
      'https://evil.example/https://nitishsana.github.io/wealthfire/',
      'https://user@nitishsana.github.io/wealthfire/',
      'http://nitishsana.github.io/wealthfire/',
      'http://127.0.0.1:5181/',
      'wealthfire://kyc-return/x',
      'wealthfire://kyc-return?next=https://evil.example',
      'wealthfire://kyc',
      'wealthfire://',
      'javascript:alert(1)',
      ' https://nitishsana.github.io/wealthfire/',
      'https://nitishsana.github.io/wealthfire/\n',
      `https://nitishsana.github.io/wealthfire/${'a'.repeat(500)}`,
      '',
      42,
      null,
    ]) expect(allowedReturnUrl(bad, DEV), String(bad)).toBeNull();
  });
});
