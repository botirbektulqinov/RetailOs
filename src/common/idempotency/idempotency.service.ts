import { createHash } from 'node:crypto';

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import type { Tx } from '../../database/prisma.service';
import { BusinessRuleException } from '../exceptions/business-rule.exception';
import { ErrorCode } from '../exceptions/error-codes';

/** How long a key is honoured — long enough for an offline till to reconnect
 *  the next morning, short enough that the table stays small (§26.3). */
export const IDEMPOTENCY_TTL_HOURS = 24;

export interface IdempotentRun<T> {
  organizationId: string;
  /** The client's `Idempotency-Key` header. */
  key: string;
  /** 'POST /sales/checkout' — part of the identity of the request. */
  endpoint: string;
  /** The request body, hashed so a different body under the same key is caught. */
  body: unknown;
  /** The successful HTTP status to replay. */
  status?: number;
  /** Pulls the created resource's id out of the result, for the record. */
  resourceId?: (result: T) => string | undefined;
}

export interface IdempotentResult<T> {
  result: T;
  /** True when this response came from the stored record, not from work. */
  replayed: boolean;
}

/**
 * Idempotency — docs/ARCHITECTURE.md §26.
 *
 * A service rather than the interceptor the architecture sketched, for one
 * reason that matters: §26.2 requires the record to be written in the **same
 * transaction** as the business work, and an interceptor sits outside the
 * handler's transaction. Here the record and the sale commit or roll back
 * together, so "the sale committed but the idempotency record did not" is not
 * a state the system can reach.
 *
 * Rollback also implements §26.2's "failure → DELETE the record" for free: a
 * handler that throws takes the IN_PROGRESS row down with it, and the same key
 * can be retried.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` at most once per key.
   *
   * `work` receives the transaction and must do all of its persistence inside
   * it. Anything it does outside — a notification, a webhook — is not covered
   * and must be done by the caller after this resolves.
   */
  async run<T>(
    options: IdempotentRun<T>,
    work: (tx: Tx) => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    const requestHash = hashRequest(options.endpoint, options.body);
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3_600_000);

    try {
      const result = await this.prisma.db.$transaction(async (tx) => {
        // The insert is the claim. A second request with the same key trips
        // the unique index here and lands in the replay path below; it cannot
        // proceed to do the work, because it never gets past this statement.
        await tx.idempotencyRecord.create({
          data: {
            organizationId: options.organizationId,
            key: options.key,
            endpoint: options.endpoint,
            requestHash,
            status: 'IN_PROGRESS',
            expiresAt,
          },
          select: { id: true },
        });

        const value = await work(tx);

        await tx.idempotencyRecord.update({
          where: {
            organizationId_key: { organizationId: options.organizationId, key: options.key },
          },
          data: {
            status: 'COMPLETED',
            responseStatus: options.status ?? HttpStatus.CREATED,
            responseBody: toJson(value),
            resourceId: options.resourceId?.(value) ?? null,
          },
        });

        return value;
      });

      return { result, replayed: false };
    } catch (error) {
      if (isUniqueViolation(error)) return this.replay<T>(options);
      throw error;
    }
  }

  /** The second and subsequent requests with the same key. */
  private async replay<T>(options: IdempotentRun<T>): Promise<IdempotentResult<T>> {
    const requestHash = hashRequest(options.endpoint, options.body);

    const record = await this.prisma.db.idempotencyRecord.findFirst({
      where: { key: options.key },
      select: { requestHash: true, status: true, responseBody: true, endpoint: true },
    });

    if (!record) {
      // The holder rolled back between our insert failing and this read, so
      // the key is free again. Retrying is the client's cheapest correct move.
      throw new BusinessRuleException({
        code: ErrorCode.REQUEST_IN_PROGRESS,
        detail: "So'rov bir vaqtning o'zida qayta yuborildi. Qaytadan urinib ko'ring.",
      });
    }

    // A different body under the same key is a client bug. Answering it with
    // the first request's response would be worse than an error: the caller
    // would believe something happened that never did.
    if (record.requestHash !== requestHash || record.endpoint !== options.endpoint) {
      throw new BusinessRuleException({
        code: ErrorCode.IDEMPOTENCY_KEY_REUSED,
        detail: "Bu Idempotency-Key boshqa so'rov uchun ishlatilgan.",
      });
    }

    if (record.status === 'IN_PROGRESS') {
      throw new BusinessRuleException({
        code: ErrorCode.REQUEST_IN_PROGRESS,
        detail: "Bu so'rov hozir bajarilmoqda. Bir necha soniyadan keyin qaytadan urinib ko'ring.",
      });
    }

    this.logger.log(
      { key: options.key, endpoint: options.endpoint },
      'Replaying idempotent response',
    );
    return { result: record.responseBody as T, replayed: true };
  }

  /**
   * Removes expired records. Called by whatever schedules maintenance; there
   * is deliberately no cron wired up inside the API process, because two
   * replicas both running it is a race nobody needs (§32.4).
   */
  async purgeExpired(): Promise<number> {
    const { count } = await this.prisma.asSystem().idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return count;
  }
}

/**
 * sha256 over the endpoint and a canonical rendering of the body.
 *
 * Canonical means object keys sorted at every level, so `{a,b}` and `{b,a}`
 * hash the same — two serializations of the same request are the same request,
 * and a client that reorders its JSON should not be told its key was reused.
 */
export function hashRequest(endpoint: string, body: unknown): string {
  return createHash('sha256')
    .update(`${endpoint}\n${canonical(body)}`)
    .digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** bigint is not JSON. Money is serialized the way the API serializes it. */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
