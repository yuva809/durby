# ADR 0041: Password and onboarding links on the partner's domain

- Status: accepted (2026-11-14)
- Date: 2026-11-14
- Amends: ADR 0015 §12 (invitation links), ADR 0040 (partner domains)

## Context

Invitation links already open on the organization's partner domain. A new Owner's set-password mail (`create-admin`,
admin portal onboarding), password reset and email verification always used `WEB_BASE_URL`, so AsiaMight's first
owner was sent to `app.durby.tech/reset-password` with Durby's branding instead of `app.asiamight.site`.

## Decisions

1. **Onboarding mails use the partner's domain.** `create-admin` and the admin portal know the organization's
   partner; they pass it, and the link base is chosen like invitations (`inviteLinkBase`: the first origin in
   `WEB_ORIGINS` whose host is one of the partner's domains, else `WEB_BASE_URL`). The partner's domains come from
   `partner_domains` (a platform table): no cross-tenant read.

2. **Reset and verification use the asking site.** These are user-level, and a user can belong to organizations of
   several partners. The link opens on the browser request's `Origin` when it is **exactly** one of `WEB_ORIGINS`,
   else `WEB_BASE_URL`. A client can only choose among our own sites, never put another host into an email; the token
   stays in the fragment as before.

3. **One rule in platform/auth.** `inviteLinkBase` and the new `mailLinkBase` live in `platform/auth/link-base.ts`
   (rbac imports auth, never the reverse); `rbac/invitation-link.ts` re-exports `inviteLinkBase`.

## Consequences

- A user who asks for a reset on `app.durby.tech` gets a Durby link, on `app.asiamight.site` an AsiaMight one.
- Mail texts still use the bundled product name; partner wording in user-level mails is a later step.
