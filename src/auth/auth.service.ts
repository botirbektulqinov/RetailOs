import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import { PrismaService } from '../database/prisma.service';
import { expandPermissions } from '../rbac/permissions';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { LoginDto } from './dto/login.dto';
import { PasswordService } from './password.service';
import { normalizePhone } from './phone';
import { TokenService } from './token.service';

export interface RequestMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthenticatedUser;
}

export interface AuthenticatedUser {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  status: string;
  organization: { id: string; name: string; currencyCode: string; status: string };
  activeStore: { id: string; code: string; name: string } | null;
  stores: { id: string; code: string; name: string; roleCode: string; roleName: string }[];
  role: { id: string; code: string; name: string } | null;
  permissions: string[];
}

/**
 * Identical for a wrong phone, a wrong password and a missing account.
 * Anything more specific is an account-enumeration oracle.
 */
const INVALID_CREDENTIALS = () =>
  new BusinessRuleException({
    code: ErrorCode.INVALID_CREDENTIALS,
    status: HttpStatus.UNAUTHORIZED,
    detail: "Telefon raqami yoki parol noto'g'ri.",
  });

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  // ── Login ────────────────────────────────────────────────────────────────

  async login(dto: LoginDto, meta: RequestMeta): Promise<AuthSession> {
    const phone = normalizePhone(dto.phone);
    if (!phone) throw INVALID_CREDENTIALS();

    // Cross-tenant by necessity: which organization the caller belongs to is
    // the answer this lookup produces, so it cannot be scoped beforehand.
    const user = await this.prisma.asSystem().user.findUnique({
      where: { phone },
      select: {
        id: true,
        organizationId: true,
        passwordHash: true,
        status: true,
        tokenVersion: true,
        organization: { select: { status: true } },
      },
    });

    // Always hash something, even when the user does not exist, so that a
    // missing account and a wrong password take the same time. Skipping the
    // verify on a miss turns login latency into an account oracle.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const passwordMatches = await this.passwords.verify(hash, dto.password);

    if (!user || !passwordMatches) {
      if (user) {
        await this.audit.record({
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'auth.login_failed',
          entityType: 'user',
          entityId: user.id,
          metadata: { reason: 'invalid_password' },
          ...meta,
        });
      }
      throw INVALID_CREDENTIALS();
    }

    if (user.status !== 'ACTIVE') {
      await this.audit.record({
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'auth.login_blocked',
        entityType: 'user',
        entityId: user.id,
        metadata: { reason: user.status.toLowerCase() },
        ...meta,
      });
      // Distinct from invalid credentials on purpose: the caller proved they
      // own the account, so telling them why they cannot get in is not a leak
      // and saves a support call.
      throw new BusinessRuleException({
        code: ErrorCode.USER_INACTIVE,
        status: HttpStatus.FORBIDDEN,
        detail:
          user.status === 'SUSPENDED'
            ? 'Hisobingiz bloklangan. Administratorga murojaat qiling.'
            : 'Hisobingiz faol emas. Administratorga murojaat qiling.',
      });
    }

    if (user.organization.status !== 'ACTIVE') {
      throw new BusinessRuleException({
        code: ErrorCode.ORGANIZATION_SUSPENDED,
        status: HttpStatus.FORBIDDEN,
        detail: 'Tashkilot vaqtincha to‘xtatilgan.',
      });
    }

    const membership = await this.resolveMembership(user.id, dto.storeId);

    const session = await this.issueSession({
      userId: user.id,
      organizationId: user.organizationId,
      storeId: membership.storeId,
      roleId: membership.roleId,
      permissionVersion: membership.role.permissionVersion,
      tokenVersion: user.tokenVersion,
      rememberDevice: dto.rememberDevice ?? false,
      meta,
    });

    await this.prisma.asSystem().user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.record({
      organizationId: user.organizationId,
      storeId: membership.storeId,
      actorUserId: user.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      metadata: { storeId: membership.storeId, rememberDevice: dto.rememberDevice ?? false },
      ...meta,
    });

    return { ...session, user: await this.describeUser(user.id) };
  }

  // ── Refresh ──────────────────────────────────────────────────────────────

  /**
   * Rotation with reuse detection — docs/ARCHITECTURE.md §29.2.
   *
   * Every refresh issues a new token and marks the old one revoked. Presenting
   * an already-revoked token means it was captured, so the entire family is
   * revoked and the legitimate holder is forced to log in again.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthSession> {
    const tokenHash = this.tokens.hashRefreshToken(refreshToken);

    const existing = await this.prisma.asSystem().refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        organizationId: true,
        familyId: true,
        expiresAt: true,
        revokedAt: true,
        deviceName: true,
      },
    });

    if (!existing) throw invalidRefresh();

    if (existing.revokedAt) {
      // Reuse of a rotated token: assume theft, kill the family.
      await this.prisma.asSystem().refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: 'reuse_detected' },
      });
      await this.audit.record({
        organizationId: existing.organizationId,
        actorUserId: existing.userId,
        action: 'auth.refresh_reuse_detected',
        entityType: 'session',
        entityId: existing.familyId,
        metadata: { familyRevoked: true },
        ...meta,
      });
      this.logger.warn(
        `Refresh token reuse detected for user ${existing.userId}; family ${existing.familyId} revoked`,
      );
      throw invalidRefresh();
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new BusinessRuleException({
        code: ErrorCode.REFRESH_TOKEN_EXPIRED,
        status: HttpStatus.UNAUTHORIZED,
        detail: 'Sessiya muddati tugadi. Qaytadan kiring.',
      });
    }

    const user = await this.prisma.asSystem().user.findUnique({
      where: { id: existing.userId },
      select: {
        id: true,
        organizationId: true,
        status: true,
        tokenVersion: true,
        organization: { select: { status: true } },
      },
    });

    if (!user || user.status !== 'ACTIVE' || user.organization.status !== 'ACTIVE') {
      throw invalidRefresh();
    }

    const membership = await this.resolveMembership(user.id, undefined);

    const session = await this.prisma.asSystem().$transaction(async (tx) => {
      // Revoke first, inside the transaction: if issuing the replacement
      // fails, the old token must not remain usable.
      const revoked = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: 'rotated' },
      });
      // Lost the race against a concurrent refresh of the same token.
      if (revoked.count === 0) throw invalidRefresh();

      return this.issueSession(
        {
          userId: user.id,
          organizationId: user.organizationId,
          storeId: membership.storeId,
          roleId: membership.roleId,
          permissionVersion: membership.role.permissionVersion,
          tokenVersion: user.tokenVersion,
          rememberDevice: true,
          familyId: existing.familyId,
          previousTokenId: existing.id,
          deviceName: existing.deviceName,
          meta,
        },
        tx,
      );
    });

    return { ...session, user: await this.describeUser(user.id) };
  }

  // ── Logout ───────────────────────────────────────────────────────────────

  /** Idempotent: logging out twice is a success, not a 404. */
  async logout(refreshToken: string | undefined, userId: string): Promise<{ revoked: number }> {
    if (!refreshToken) return { revoked: 0 };

    const result = await this.prisma.asSystem().refreshToken.updateMany({
      where: {
        tokenHash: this.tokens.hashRefreshToken(refreshToken),
        // Scoped to the caller, so a stolen token cannot be used to log
        // somebody else out.
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date(), revokedBy: 'logout' },
    });

    return { revoked: result.count };
  }

  /** "Barcha qurilmalardan chiqish" on the security screen. */
  async logoutAll(
    userId: string,
    organizationId: string,
    meta: RequestMeta,
  ): Promise<{ revoked: number }> {
    const result = await this.prisma.asSystem().refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: 'logout_all' },
    });

    // Bumping tokenVersion kills the still-valid access tokens too. Without
    // it, "log out everywhere" would leave every device working for another
    // 15 minutes, which is not what the button promises.
    await this.prisma.asSystem().user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    await this.audit.record({
      organizationId,
      actorUserId: userId,
      action: 'auth.logout_all',
      entityType: 'user',
      entityId: userId,
      metadata: { sessionsRevoked: result.count },
      ...meta,
    });

    return { revoked: result.count };
  }

  // ── Password ─────────────────────────────────────────────────────────────

  async changePassword(
    userId: string,
    organizationId: string,
    dto: ChangePasswordDto,
    meta: RequestMeta,
  ): Promise<void> {
    const user = await this.prisma.asSystem().user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw INVALID_CREDENTIALS();

    if (!(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
      await this.audit.record({
        organizationId,
        actorUserId: userId,
        action: 'auth.password_change_failed',
        entityType: 'user',
        entityId: userId,
        metadata: { reason: 'wrong_current_password' },
        ...meta,
      });
      throw new BusinessRuleException({
        code: ErrorCode.INVALID_CREDENTIALS,
        status: HttpStatus.UNAUTHORIZED,
        detail: "Joriy parol noto'g'ri.",
      });
    }

    if (dto.currentPassword === dto.newPassword) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        status: HttpStatus.BAD_REQUEST,
        detail: 'Yangi parol joriy paroldan farq qilishi kerak.',
      });
    }

    const check = this.passwords.check(dto.newPassword);
    if (!check.valid) {
      throw new BusinessRuleException({
        code: ErrorCode.WEAK_PASSWORD,
        status: HttpStatus.BAD_REQUEST,
        detail: 'Parol talablarga javob bermaydi.',
        errors: check.errors.map((message) => ({
          field: 'newPassword',
          code: ErrorCode.WEAK_PASSWORD,
          message,
        })),
      });
    }

    const passwordHash = await this.passwords.hash(dto.newPassword);

    // Policy: a password change revokes every session, including the one that
    // made the request. Changing a password is what you do when you think it
    // was exposed, so leaving other devices signed in defeats the point. The
    // client re-authenticates immediately with the new password.
    await this.prisma.asSystem().$transaction([
      this.prisma.asSystem().user.update({
        where: { id: userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          tokenVersion: { increment: 1 },
        },
      }),
      this.prisma.asSystem().refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: 'password_changed' },
      }),
    ]);

    await this.audit.record({
      organizationId,
      actorUserId: userId,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: userId,
      metadata: { allSessionsRevoked: true },
      ...meta,
    });
  }

  // ── Store switching ──────────────────────────────────────────────────────

  /**
   * Re-mints the access token with a different `store` claim.
   *
   * Store context lives inside the signed token rather than in a mutable
   * header, so a client cannot simply claim to be in another branch.
   */
  async switchStore(
    userId: string,
    storeId: string,
    meta: RequestMeta,
  ): Promise<{ accessToken: string; expiresIn: number; user: AuthenticatedUser }> {
    const membership = await this.resolveMembership(userId, storeId);

    const user = await this.prisma.asSystem().user.findUnique({
      where: { id: userId },
      select: { id: true, organizationId: true, tokenVersion: true },
    });
    if (!user) throw invalidRefresh();

    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      org: user.organizationId,
      store: membership.storeId,
      role: membership.roleId,
      pv: membership.role.permissionVersion,
      tv: user.tokenVersion,
      sid: randomUUID(),
    });

    await this.audit.record({
      organizationId: user.organizationId,
      storeId: membership.storeId,
      actorUserId: userId,
      action: 'auth.store_switched',
      entityType: 'store',
      entityId: membership.storeId,
      metadata: {},
      ...meta,
    });

    return {
      accessToken,
      expiresIn: this.tokens.accessTokenTtlSeconds(),
      user: await this.describeUser(userId),
    };
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /** "Faol qurilmalar" on the security screen. */
  async listSessions(userId: string) {
    const sessions = await this.prisma.asSystem().refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        deviceName: true,
        ip: true,
        lastUsedAt: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { lastUsedAt: 'desc' },
    });

    return sessions.map((s) => ({
      id: s.id,
      deviceName: s.deviceName ?? "Noma'lum qurilma",
      ip: s.ip,
      lastUsedAt: s.lastUsedAt,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.prisma.asSystem().refreshToken.updateMany({
      // userId in the predicate: without it, any authenticated user could
      // revoke any session by guessing an id.
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: 'revoked_by_user' },
    });

    if (result.count === 0) throw BusinessRuleException.notFound('Sessiya', sessionId);
  }

  // ── Current user ─────────────────────────────────────────────────────────

  async describeUser(userId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.asSystem().user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        status: true,
        organization: { select: { id: true, name: true, currencyCode: true, status: true } },
        memberships: {
          where: { status: 'ACTIVE' },
          select: {
            storeId: true,
            isPrimary: true,
            store: { select: { id: true, code: true, name: true, status: true } },
            role: { select: { id: true, code: true, name: true, permissions: true } },
          },
          orderBy: { isPrimary: 'desc' },
        },
      },
    });

    if (!user) throw BusinessRuleException.notFound('Foydalanuvchi', userId);

    const active = user.memberships.find((m) => m.store.status === 'ACTIVE');

    return {
      id: user.id,
      fullName: user.fullName,
      phone: user.phone,
      email: user.email,
      status: user.status,
      organization: user.organization,
      activeStore: active
        ? { id: active.store.id, code: active.store.code, name: active.store.name }
        : null,
      stores: user.memberships.map((m) => ({
        id: m.store.id,
        code: m.store.code,
        name: m.store.name,
        roleCode: m.role.code,
        roleName: m.role.name,
      })),
      role: active ? { id: active.role.id, code: active.role.code, name: active.role.name } : null,
      // Expanded: a client cannot render a permission-driven UI from `*`.
      permissions: active ? expandPermissions(active.role.permissions) : [],
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async resolveMembership(userId: string, requestedStoreId: string | undefined) {
    const memberships = await this.prisma.asSystem().storeMembership.findMany({
      where: {
        userId,
        status: 'ACTIVE',
        store: { status: 'ACTIVE', archivedAt: null },
      },
      select: {
        storeId: true,
        roleId: true,
        isPrimary: true,
        role: { select: { permissionVersion: true } },
      },
      orderBy: { isPrimary: 'desc' },
    });

    if (memberships.length === 0) {
      throw new BusinessRuleException({
        code: ErrorCode.NO_STORE_ACCESS,
        status: HttpStatus.FORBIDDEN,
        detail: "Sizga hech qanday do'kon biriktirilmagan. Administratorga murojaat qiling.",
      });
    }

    if (!requestedStoreId) {
      // Primary first, then any active store — never "whatever the database
      // returned first", which changes under the user without explanation.
      return memberships[0]!;
    }

    const requested = memberships.find((m) => m.storeId === requestedStoreId);
    if (!requested) {
      // 403, not 404: the caller is authenticated, and a store id they cannot
      // use is not a resource whose existence we need to deny.
      throw new BusinessRuleException({
        code: ErrorCode.STORE_ACCESS_DENIED,
        status: HttpStatus.FORBIDDEN,
        detail: "Bu do'konga kirish huquqingiz yo'q.",
      });
    }
    return requested;
  }

  private async issueSession(
    input: {
      userId: string;
      organizationId: string;
      storeId: string;
      roleId: string;
      permissionVersion: number;
      tokenVersion: number;
      rememberDevice: boolean;
      familyId?: string;
      previousTokenId?: string;
      deviceName?: string | null;
      meta: RequestMeta;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const client = tx ?? this.prisma.asSystem();
    const familyId = input.familyId ?? randomUUID();

    const refreshToken = this.tokens.generateRefreshToken();
    const ttl = this.tokens.refreshTokenTtlSeconds(input.rememberDevice);

    const created = await client.refreshToken.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        tokenHash: this.tokens.hashRefreshToken(refreshToken),
        familyId,
        deviceName: input.deviceName ?? describeDevice(input.meta.userAgent),
        ip: input.meta.ip ?? null,
        expiresAt: new Date(Date.now() + ttl * 1000),
      },
      select: { id: true },
    });

    if (input.previousTokenId) {
      await client.refreshToken.update({
        where: { id: input.previousTokenId },
        data: { replacedById: created.id },
      });
    }

    const accessToken = await this.tokens.signAccessToken({
      sub: input.userId,
      org: input.organizationId,
      store: input.storeId,
      role: input.roleId,
      pv: input.permissionVersion,
      tv: input.tokenVersion,
      sid: familyId,
    });

    return { accessToken, refreshToken, expiresIn: this.tokens.accessTokenTtlSeconds() };
  }
}

function invalidRefresh(): BusinessRuleException {
  return new BusinessRuleException({
    code: ErrorCode.REFRESH_TOKEN_INVALID,
    status: HttpStatus.UNAUTHORIZED,
    detail: 'Sessiya yaroqsiz. Qaytadan kiring.',
  });
}

/**
 * A coarse, human-readable device label for the "Faol qurilmalar" list.
 * Deliberately not a fingerprint: enough to recognise your own phone, not
 * enough to track anyone.
 */
function describeDevice(userAgent: string | undefined): string | null {
  if (!userAgent) return null;

  const platform = /iPhone|iPad/i.test(userAgent)
    ? 'iPhone'
    : /Android/i.test(userAgent)
      ? 'Android'
      : /Windows/i.test(userAgent)
        ? 'Windows'
        : /Mac OS/i.test(userAgent)
          ? 'Mac'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : null;

  const browser = /Chrome/i.test(userAgent)
    ? 'Chrome'
    : /Safari/i.test(userAgent)
      ? 'Safari'
      : /Firefox/i.test(userAgent)
        ? 'Firefox'
        : null;

  if (!platform && !browser) return null;
  return [platform, browser].filter(Boolean).join(' · ');
}

/**
 * A real Argon2id hash of a value nobody knows, used to keep the timing of a
 * missing account identical to a wrong password.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zYWx0LXZhbHVl$8B5Zr6cWx1Q0oQkC5Zz1kPqWz0vXK1lJzXqYq7mR4Xo';
