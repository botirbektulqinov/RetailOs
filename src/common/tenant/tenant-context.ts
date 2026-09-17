import { ClsServiceManager } from 'nestjs-cls';

/**
 * The verified identity behind the current request.
 *
 * Every field here comes from a signature-verified access token and has been
 * re-checked against the database. Nothing in it is ever read from a header,
 * query parameter or request body (docs/ARCHITECTURE.md §4.3).
 */
export interface TenantContext {
  userId: string;
  organizationId: string;
  /** The store this session is operating in. */
  storeId: string;
  roleId: string;
  roleCode: string;
  /** Already expanded — `*` never reaches a comparison. */
  permissions: ReadonlySet<string>;
  /** Refresh-token family, so an audit row can name the session. */
  sessionId: string | null;
}

export const TENANT_CONTEXT_KEY = 'tenant';

/**
 * Held in AsyncLocalStorage rather than passed down every call, because the
 * Prisma extension (tenant-extension.ts) runs far below the controller and has
 * no other way to learn whose request it is serving.
 */
export function getTenantContext(): TenantContext | undefined {
  const cls = ClsServiceManager.getClsService();
  if (!cls.isActive()) return undefined;
  return cls.get<TenantContext | undefined>(TENANT_CONTEXT_KEY);
}

export function setTenantContext(context: TenantContext): void {
  ClsServiceManager.getClsService().set(TENANT_CONTEXT_KEY, context);
}

/**
 * The organization id for the current request, or undefined outside one
 * (startup, seeds, cron). Callers that require tenancy use requireTenant().
 */
export function currentOrganizationId(): string | undefined {
  return getTenantContext()?.organizationId;
}

export function requireTenant(): TenantContext {
  const context = getTenantContext();
  if (!context) {
    throw new Error('No tenant context: this code path must run inside an authenticated request');
  }
  return context;
}
