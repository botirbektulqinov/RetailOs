-- audit_log.actor_user_id: SET NULL -> RESTRICT
--
-- Prisma's implicit ON DELETE for an optional relation is SET NULL, which is an
-- UPDATE on an append-only table. The immutability trigger rejects it, and the
-- failure surfaces at the delete site as a baffling "table audit_log is
-- append-only". RESTRICT states the real intent: audit rows outlive their
-- actor, and users are deactivated rather than deleted.
--
-- NOTE FOR FUTURE MIGRATIONS: `prisma migrate dev` generated this file with
-- DROP statements for every hand-written constraint in
-- 20260917092323_identity_tenancy_rbac (the composite same-org foreign keys and
-- the trigram indexes), because they do not exist in schema.prisma and Prisma
-- therefore reads them as drift. Those DROPs were removed by hand. Every future
-- migration must be reviewed for the same thing — see docs/ARCHITECTURE.md §6.2.

ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_user_id_fkey";

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
