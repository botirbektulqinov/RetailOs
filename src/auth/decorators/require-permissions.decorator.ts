import { SetMetadata } from '@nestjs/common';

import type { Permission } from '../../rbac/permissions';

export const PERMISSIONS_KEY = 'retailos:permissions';

/**
 * Declares what a handler needs. AND semantics — every listed permission must
 * be held.
 *
 * The parameter is typed against the catalogue, so a misspelled permission is
 * a compile error rather than a check that is silently false forever.
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
