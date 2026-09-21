/**
 * Runs before any module is imported.
 *
 * The login endpoint allows five attempts per fifteen minutes per client
 * (src/auth/auth.controller.ts). That is the right number for production and a
 * fatal one for a suite that logs in several dozen times, so the budget is
 * raised here. It has to happen at this point rather than in a beforeAll:
 * `@Throttle` reads process.env at decoration time, before the DI container
 * exists and long before any test body runs.
 *
 * No test asserts on throttling, so nothing is being disabled that a test
 * relies on — and a suite whose result depends on whether the developer's
 * .env happens to carry a variable is not a suite anyone can trust.
 *
 * `??=` so an explicit `AUTH_RATE_LIMIT=5 npm run test:e2e` still wins; .env
 * is loaded later by ConfigModule and never overwrites what is already set.
 */
process.env['AUTH_RATE_LIMIT'] ??= '100000';
process.env['AUTH_RATE_LIMIT_TTL_SECONDS'] ??= '60';
process.env['RATE_LIMIT_LIMIT'] ??= '100000';
process.env['RATE_LIMIT_TTL_SECONDS'] ??= '60';
