import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

import { BusinessRuleException } from '../exceptions/business-rule.exception';
import type { ErrorDetail, ErrorResponseBody } from '../exceptions/error-codes';
import { ErrorCode } from '../exceptions/error-codes';
import { resolveRequestId } from '../http/request-context';

const ERROR_DOCS_BASE = 'https://docs.retailos.uz/errors';

const TITLES: Record<string, string> = {
  [ErrorCode.VALIDATION_FAILED]: 'Validation failed',
  [ErrorCode.MALFORMED_REQUEST]: 'Malformed request',
  [ErrorCode.INVALID_CREDENTIALS]: 'Invalid credentials',
  [ErrorCode.TOKEN_EXPIRED]: 'Token expired',
  [ErrorCode.TOKEN_INVALID]: 'Token invalid',
  [ErrorCode.FORBIDDEN]: 'Forbidden',
  [ErrorCode.REFRESH_TOKEN_INVALID]: 'Refresh token invalid',
  [ErrorCode.REFRESH_TOKEN_EXPIRED]: 'Refresh token expired',
  [ErrorCode.USER_INACTIVE]: 'Account not active',
  [ErrorCode.ORGANIZATION_SUSPENDED]: 'Organization suspended',
  [ErrorCode.STORE_ACCESS_DENIED]: 'Store access denied',
  [ErrorCode.NO_STORE_ACCESS]: 'No store assigned',
  [ErrorCode.PHONE_ALREADY_USED]: 'Phone already in use',
  [ErrorCode.SEAT_LIMIT_REACHED]: 'Seat limit reached',
  [ErrorCode.ROLE_IN_USE]: 'Role still assigned',
  [ErrorCode.ROLE_IMMUTABLE]: 'Role cannot be modified',
  [ErrorCode.LAST_ADMIN]: 'Last administrator',
  [ErrorCode.WEAK_PASSWORD]: 'Password too weak',
  [ErrorCode.UNKNOWN_PERMISSION]: 'Unknown permission',
  [ErrorCode.RESOURCE_NOT_FOUND]: 'Resource not found',
  [ErrorCode.DUPLICATE_RESOURCE]: 'Duplicate resource',
  [ErrorCode.CONCURRENT_MODIFICATION]: 'Concurrent modification',
  [ErrorCode.PAYLOAD_TOO_LARGE]: 'Payload too large',
  [ErrorCode.RATE_LIMIT_EXCEEDED]: 'Rate limit exceeded',
  [ErrorCode.INTERNAL_ERROR]: 'Internal server error',
  [ErrorCode.SERVICE_UNAVAILABLE]: 'Service unavailable',
};

/** Derives a kebab-case docs slug from the code, so links need no lookup table. */
const docsType = (code: string): string =>
  `${ERROR_DOCS_BASE}/${code.toLowerCase().replace(/_/g, '-')}`;

interface Resolved {
  status: HttpStatus;
  code: string;
  detail: string;
  errors?: ErrorDetail[];
  /** True when the original error should be logged at `error` with its stack. */
  unexpected?: boolean;
}

/**
 * The single place an error becomes an HTTP response — docs/ARCHITECTURE.md §23.4.
 *
 * The rule: only errors we deliberately constructed may describe themselves to
 * a client. Anything else is logged in full and returned as a bare 500 carrying
 * nothing but a traceId — in every environment, including development, so that
 * "it leaks only in dev" can never become "it leaked in prod".
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const traceId = request.requestId ?? resolveRequestId(undefined);
    const resolved = this.resolve(exception);

    if (resolved.unexpected) {
      this.logger.error(
        {
          traceId,
          method: request.method,
          path: request.originalUrl,
          err: exception,
        },
        'Unhandled exception',
      );
    } else if (resolved.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({ traceId, code: resolved.code }, resolved.detail);
    }

    const body: ErrorResponseBody = {
      type: docsType(resolved.code),
      title: TITLES[resolved.code] ?? 'Request failed',
      status: resolved.status,
      code: resolved.code,
      detail: resolved.detail,
      traceId,
      timestamp: new Date().toISOString(),
      ...(resolved.errors?.length ? { errors: resolved.errors } : {}),
    };

    response.status(resolved.status).json(body);
  }

  private resolve(exception: unknown): Resolved {
    if (exception instanceof BusinessRuleException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        detail: exception.message,
        ...(exception.errors ? { errors: exception.errors } : {}),
      };
    }

    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        code: ErrorCode.RATE_LIMIT_EXCEEDED,
        detail: 'Too many requests. Please retry shortly.',
      };
    }

    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }

    if (this.isPrismaKnownError(exception)) {
      return this.fromPrismaError(exception);
    }

    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ErrorCode.SERVICE_UNAVAILABLE,
        detail: 'A required dependency is unavailable.',
        unexpected: true,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.INTERNAL_ERROR,
      detail: 'An unexpected error occurred.',
      unexpected: true,
    };
  }

  private fromHttpException(exception: HttpException): Resolved {
    const status: HttpStatus = exception.getStatus();
    const payload = exception.getResponse();

    // The global ValidationPipe throws BadRequestException with a string[] of
    // messages; turn that into the structured `errors` array.
    if (status === HttpStatus.BAD_REQUEST && this.isValidationPayload(payload)) {
      return {
        status,
        code: ErrorCode.VALIDATION_FAILED,
        detail: 'One or more fields are invalid.',
        errors: payload.message.map((message) => ({
          field: this.fieldFromMessage(message),
          code: ErrorCode.VALIDATION_FAILED,
          message,
        })),
      };
    }

    const detail =
      typeof payload === 'string'
        ? payload
        : typeof payload === 'object' && payload !== null && 'message' in payload
          ? String((payload as Record<string, unknown>)['message'])
          : exception.message;

    return { status, code: this.codeForStatus(status), detail };
  }

  private fromPrismaError(exception: Prisma.PrismaClientKnownRequestError): Resolved {
    switch (exception.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.DUPLICATE_RESOURCE,
          detail: 'A record with these values already exists.',
          errors: this.uniqueTargetFields(exception).map((field) => ({
            field,
            code: ErrorCode.DUPLICATE_RESOURCE,
            message: `${field} must be unique`,
          })),
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: ErrorCode.RESOURCE_NOT_FOUND,
          detail: 'The requested record does not exist.',
        };
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          code: ErrorCode.DUPLICATE_RESOURCE,
          detail: 'A related record is missing or still referenced.',
        };
      default:
        // Never forward exception.message — it names tables and columns.
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ErrorCode.INTERNAL_ERROR,
          detail: 'An unexpected error occurred.',
          unexpected: true,
        };
    }
  }

  private isPrismaKnownError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
    return error instanceof Prisma.PrismaClientKnownRequestError;
  }

  /** `meta.target` is the constraint's column list when Prisma can determine it. */
  private uniqueTargetFields(exception: Prisma.PrismaClientKnownRequestError): string[] {
    const target = exception.meta?.['target'];
    if (Array.isArray(target)) return target.map(String);
    if (typeof target === 'string') return [target];
    return [];
  }

  private isValidationPayload(payload: unknown): payload is { message: string[] } {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'message' in payload &&
      Array.isArray((payload as Record<string, unknown>)['message'])
    );
  }

  /** class-validator prefixes each message with the property path. */
  private fieldFromMessage(message: string): string | undefined {
    const [first] = message.split(' ');
    return first && /^[A-Za-z_$][\w$.[\]]*$/.test(first) ? first : undefined;
  }

  private codeForStatus(status: HttpStatus): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.MALFORMED_REQUEST;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.TOKEN_INVALID;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.RESOURCE_NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.DUPLICATE_RESOURCE;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ErrorCode.PAYLOAD_TOO_LARGE;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMIT_EXCEEDED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.SERVICE_UNAVAILABLE;
      default:
        return status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? ErrorCode.INTERNAL_ERROR
          : ErrorCode.MALFORMED_REQUEST;
    }
  }
}
