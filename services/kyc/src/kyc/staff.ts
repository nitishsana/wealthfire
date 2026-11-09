// Staff identity for /review/* (design §3, §7): a Cognito token from the staff pool (MFA enforced
// by the pool) whose `cognito:groups` the router checks for 'reviewer'.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface StaffIdentity {
  id: string;
  groups: string[];
}

export interface StaffVerifier {
  /** The verified staff member for this Authorization header, or null. Never throws. */
  verify(authorization: string | undefined): Promise<StaffIdentity | null>;
}

function bearer(authorization: string | undefined): string | null {
  if (typeof authorization !== 'string') return null;
  const m = /^Bearer\s+([A-Za-z0-9_.-]{20,4096})$/.exec(authorization.trim());
  return m ? m[1]! : null;
}

/** Verifies a Cognito ID or access token against the pool's JWKS. */
export class CognitoStaffVerifier implements StaffVerifier {
  private readonly jwks: JWTVerifyGetKey;
  private readonly issuer: string;

  constructor(region: string, private readonly userPoolId: string, private readonly clientId: string, jwks?: JWTVerifyGetKey) {
    this.issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    this.jwks = jwks ?? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async verify(authorization: string | undefined): Promise<StaffIdentity | null> {
    const token = bearer(authorization);
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer, algorithms: ['RS256'] });
      const use = payload.token_use;
      const clientOk = use === 'id' ? payload.aud === this.clientId : use === 'access' ? payload.client_id === this.clientId : false;
      if (!clientOk || typeof payload.sub !== 'string') return null;
      const groups = payload['cognito:groups'];
      return { id: payload.sub, groups: Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [] };
    } catch {
      return null;
    }
  }
}

/** Test verifier: `Bearer <token>` → the identity registered for that token. */
export class FakeStaffVerifier implements StaffVerifier {
  private readonly tokens = new Map<string, StaffIdentity>();

  add(token: string, identity: StaffIdentity): void {
    this.tokens.set(token, identity);
  }

  async verify(authorization: string | undefined): Promise<StaffIdentity | null> {
    const token = bearer(authorization);
    return (token && this.tokens.get(token)) || null;
  }
}
