import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { AppConfig } from '../config/config.module';

/**
 * Access token claims — docs/ARCHITECTURE.md §4.3.
 *
 * Deliberately small. The permission LIST is not in here: a token minted
 * before a role was edited would keep granting what was just revoked, for its
 * whole lifetime.
 *
 * Instead permissions are resolved per request from the membership's current
 * role, through a cache keyed by `roleId:permissionVersion`. Editing a role
 * bumps that version, so the next request reads the new set — revocation is
 * immediate and nobody is forced to log in again. `pv` travels in the token
 * only so a client can tell that its cached permission list is stale.
 *
 * `tv` is different: it is compared on every request and a mismatch rejects
 * the token outright, because password change and deactivation must kill
 * existing sessions rather than merely re-scope them.
 */
export interface AccessTokenClaims {
  /** user id */
  sub: string;
  /** organization id */
  org: string;
  /** active store id */
  store: string;
  /** role id for the membership in that store */
  role: string;
  /** role.permission_version at issue time — lets a client detect a stale
   *  permission list. Authorization always re-reads the current version. */
  pv: number;
  /** user.token_version — invalidates every token on password change */
  tv: number;
  /** refresh-token family, so audit rows can name the session */
  sid: string;
  jti: string;
}

export interface IssuedTokens {
  accessToken: string;
  /** Opaque, never a JWT: it must be revocable, and a JWT is not. */
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  async signAccessToken(claims: Omit<AccessTokenClaims, 'jti'>): Promise<string> {
    const payload: AccessTokenClaims = { ...claims, jti: randomUUID() };
    return this.jwt.signAsync<AccessTokenClaims>(payload, {
      secret: this.config.get('JWT_SECRET'),
      // Seconds, not the raw "15m" string: jsonwebtoken's string form has a
      // template literal type, and a number is unambiguous anyway.
      expiresIn: this.accessTokenTtlSeconds(),
      issuer: 'retailos',
      audience: 'retailos-api',
    });
  }

  /**
   * Verifies signature, expiry, issuer and audience.
   *
   * Throws on anything wrong; the caller turns that into 401. Tampering with
   * the payload changes the signature, so a forged `org` claim never verifies.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    return this.jwt.verifyAsync<AccessTokenClaims>(token, {
      secret: this.config.get('JWT_SECRET'),
      issuer: 'retailos',
      audience: 'retailos-api',
    });
  }

  /**
   * 256 bits of randomness. Refresh tokens are opaque rather than signed so
   * that revoking one is a database write rather than a blocklist nobody
   * remembers to check.
   */
  generateRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Only the hash is stored, so a database leak does not hand over live
   * sessions. SHA-256 rather than Argon2 on purpose: the input is already 256
   * bits of entropy, so there is nothing to brute-force and the refresh path
   * stays fast.
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  accessTokenTtlSeconds(): number {
    return parseDuration(this.config.get('JWT_ACCESS_TTL'));
  }

  /**
   * "Eslab qolish" on the login screen. A remembered device gets the full
   * refresh lifetime; a shared till gets a short one, so walking away from an
   * unattended device is not a standing grant.
   */
  refreshTokenTtlSeconds(rememberDevice: boolean): number {
    const full = parseDuration(this.config.get('JWT_REFRESH_TTL'));
    return rememberDevice ? full : Math.min(full, 12 * 3600);
  }
}

/** Accepts `900`, `15m`, `24h`, `30d`. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);

  const amount = Number(match[1]);
  switch (match[2]) {
    case 'd':
      return amount * 86_400;
    case 'h':
      return amount * 3_600;
    case 'm':
      return amount * 60;
    default:
      return amount;
  }
}
