# ADR 0011: Label overrides (terminology)

- Status: accepted
- Date: 2026-10-23
- Step: Phase 1.7 (labels / terminology)

## Context

Every user-facing string is a label key with defaults in `packages/i18n` (rule 3). Clients call the same thing by
different names ("Inventory" vs "Products"), and partners re-brand the product. Overrides must not let an organization
change text it doesn't own: emails go out from Durby's address to addresses an Admin types, and the app's name belongs
to the partner (white-label). Settings (ADR 0010) already solved two-level storage and per-request caching; the outbox
(and with it any Redis cache invalidation) arrives in 1.9. Spec: [docs/platform/labels.md](../platform/labels.md).

## Decisions

1. **Two tables, like settings (ADR 0010 §2).** `partner_label_overrides` is a platform table, read-only for
   `durby_app` (DML revoked, catalog test), changed only through reviewed migrations. `label_overrides` is a tenant
   table with the full ADR 0005 block. Organization scope only; no polymorphic `scope_id`. Brand or location
   overrides get their own columns if a step needs them.

2. **Organizations may override only an allow-list of keys.** `packages/i18n` defines `ORG_OVERRIDABLE` (key
   patterns; terminology only: `*.nav.**`, `*.entities.**`, `*.fields.**`) and `NEVER_ORG_OVERRIDABLE` (email
   templates `platform.email.**` and `auth.email.**`, every `**.errors.**` key, `platform.app.name`). A key is
   org-overridable only if it matches the allow-list and not the deny-list; a test checks every such key is denied. Other keys →
   `422 labels.not_overridable`.
   _Why:_ an org Admin could otherwise rewrite the invitation email (sent from Durby's address to any address they
   type) into a phishing message, reword security errors, or rename the app.
   _Rejected:_ a deny-list only: every new key would be overridable by default, including future email and PDF
   templates. Widening the allow-list is a reviewed code change.

3. **Partner overrides may change any key** (they are reviewed migrations, and white-label is partner-level).

4. **Values are plain text that keeps the default's placeholders.** An override must contain exactly the same set of
   `{name}` placeholders as the default text for that key **in the same locale**, no other braces, no control or
   bidi-override characters, and isn't blank. Organization values are single-line and at most 200 characters (api);
   partner values may span lines, at most 1000 characters (the SQL check, which is only a shape limit for both
   tables). Rendering escapes: React escapes in the web app; HTML output (emails, later PDFs) uses the translator's
   `html` format, which escapes the template and every parameter.

5. **Overrides are per locale and never cross locales.** Per key: organization override (locale) → partner override
   (locale) → default (locale) → default (`en`) → the key. A missing `de` override never falls back to an `en`
   override: an override in one language is not a translation.

6. **Fail safe on stored rows.** A stored row whose key is no longer in the dictionary, whose placeholders no longer
   match the default (a deploy changed the text), or (organization rows) whose key is no longer org-overridable or
   whose value breaks the organization limits is skipped and logged without its value; the next level applies.

7. **Reading reuses `platform.settings.read`.** `GET /labels` returns the merged dictionary under the existing key
   every system role holds, instead of a new key every role (and every custom role that assigns roles, ADR 0010 §6)
   would need. Writes use the existing `platform.labels.manage` (organization scope). Public pages (login, password
   reset, accept-invite) and user-level emails (reset, verification) have no organization and use the bundled
   defaults.

8. **Per-request cache only (as ADR 0010 §8).** A tenant's override rows and its partner's are loaded once per
   request (CLS); the web app loads the dictionary once per session and organization. No Redis until the outbox
   exists (1.9).

9. **Emails use the recipient's locale.** The invitation email uses the invitee's own locale if they have an account,
   otherwise the organization's `locale` setting, with the inviting organization's labels (partner overrides and any
   allowed organization overrides). Previously it used the inviter's locale.

## Consequences

- Renaming terminology needs no deploy; anything else needs a partner migration or a dictionary change.
- New label keys outside `nav`/`entities`/`fields` areas are not org-overridable until the allow-list is widened.
- A changed default text silently disables stored overrides whose placeholders no longer match (logged).
- Open: Redis cache invalidated by an outbox event (1.9), brand/location overrides, partner writes by platform
  staff, an editor in the web app (1.10).
