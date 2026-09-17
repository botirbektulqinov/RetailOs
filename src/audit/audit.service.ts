import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../database/prisma.service';

export interface AuditEntry {
  organizationId: string;
  storeId?: string | undefined;
  /** null/undefined = the system acted, not a person. */
  actorUserId?: string | undefined;
  /** noun.verb, past tense: 'role.permissions_changed'. */
  action: string;
  entityType: string;
  entityId?: string | undefined;
  /**
   * Explicitly constructed. There is deliberately no "log the whole DTO"
   * convenience — that convenience is how secrets end up in a table nobody can
   * delete from (docs/ARCHITECTURE.md §21.4).
   */
  metadata?: Record<string, unknown> | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
}

/**
 * Append-only audit trail — docs/ARCHITECTURE.md §21.
 *
 * Explicit calls at the points that matter, not a global interceptor. An
 * interceptor produces a table full of `PATCH /users/x` rows, which is a change
 * log rather than an audit trail: it cannot express "permission revoked" as a
 * business event and it cannot leave out the noise.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records an event, optionally inside a caller's transaction.
   *
   * Pass `tx` when the audit row must commit with the change it describes.
   * Without it the write is best-effort: a failed audit insert is logged but
   * never fails the business operation that already succeeded.
   */
  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const data = {
      organizationId: entry.organizationId,
      storeId: entry.storeId ?? null,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      requestId: entry.requestId ?? null,
    };

    if (tx) {
      await tx.auditLog.create({ data });
      return;
    }

    try {
      await this.prisma.asSystem().auditLog.create({ data });
    } catch (error) {
      this.logger.error(
        { err: error, action: entry.action, organizationId: entry.organizationId },
        'Failed to write audit entry',
      );
    }
  }
}
