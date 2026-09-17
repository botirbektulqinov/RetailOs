import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'retailos:isPublic';

/**
 * Opt OUT of authentication.
 *
 * Everything is protected by default; this decorator is the explicit,
 * greppable exception. The inverse — opt-in protection — leaves an unguarded
 * endpoint one forgotten decorator away.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
