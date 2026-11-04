-- The language the inviter chose for a new staff member (docs/platform/auth.md → Language): the invitation mail
-- (unless the invitee already has an account, whose own language wins) and the account created on accept.
-- Expand-only: nullable, no default; older releases never read it, and older invitations keep NULL
-- (accept then falls back as before).
ALTER TABLE "invitations" ADD COLUMN "locale" TEXT;
