import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Hard ceiling on page size — docs/ARCHITECTURE.md §27.1. No endpoint exceeds it. */
export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * The shared shape for every list endpoint.
 *
 * A request for `limit=10000` is clamped to 100 rather than rejected: clients
 * that paginate correctly are unaffected, and clients that do not cannot take
 * the database down. Per-resource filters extend this class.
 */
export class ListQueryDto {
  @ApiPropertyOptional({ description: 'Free-text search; fields vary per resource.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ default: DEFAULT_PAGE_LIMIT, maximum: MAX_PAGE_LIMIT, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit: number = DEFAULT_PAGE_LIMIT;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset: number = 0;

  @ApiPropertyOptional({ description: 'Opaque keyset cursor; mutually exclusive with offset.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({
    description: 'e.g. "createdAt:desc". Fields are whitelisted per resource.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sort?: string;

  @ApiPropertyOptional({ description: 'Inclusive lower bound, ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound, ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  dateTo?: string;
}

/** Offset pagination metadata. */
export class PageMeta {
  limit!: number;
  offset!: number;
  total!: number;
  hasMore!: boolean;
  /** Set when `total` came from a planner estimate rather than a COUNT(*). */
  totalIsEstimate?: boolean;
}

/** The one and only list envelope — docs/ARCHITECTURE.md §23.1. */
export class PagedResult<T> {
  data!: T[];
  page!: PageMeta;
}

export function paged<T>(data: T[], total: number, query: ListQueryDto): PagedResult<T> {
  return {
    data,
    page: {
      limit: query.limit,
      offset: query.offset,
      total,
      hasMore: query.offset + data.length < total,
    },
  };
}
