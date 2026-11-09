import { FakeClock } from '../../src/lib/clock';
import { Argon2Hasher, LocalEncryptor, LocalMacSigner } from '../../src/lib/crypto';
import { memoryRepos } from '../../src/lib/repo';
import { LocalTokenSigner, TokenService } from '../../src/lib/tokens';
import { FakeSender, OtpService } from '../../src/auth/otp';

/** Light argon2 params so tests stay fast; production uses ARGON2_DEFAULTS. */
export const FAST_ARGON2 = { memorySize: 1024, iterations: 1, parallelism: 1, hashLength: 32 };

export function setup() {
  const clock = new FakeClock();
  const repos = memoryRepos();
  const signer = new LocalTokenSigner('test');
  const tokens = new TokenService({ sessions: repos.sessions, signer, clock });
  const sender = new FakeSender();
  const mac = new LocalMacSigner();
  const encryptor = new LocalEncryptor();
  const otp = new OtpService({ repos, clock, mac, encryptor, hasher: new Argon2Hasher(FAST_ARGON2), sender, tokens });
  return { clock, repos, signer, tokens, sender, mac, encryptor, otp };
}

export const EMAIL = 'Asha.Rao@Example.com';
export const MOBILE = '+91 98765 43210';
