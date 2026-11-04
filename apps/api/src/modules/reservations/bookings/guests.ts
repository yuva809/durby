import type { TenantTransactionClient } from '../../../platform/tenancy';

/** Guest details after normalisation: lower-case email, E.164 phone. */
export interface GuestDetails {
  name?: string;
  email?: string;
  phone?: string;
  locale: string;
}

const GUEST_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  lastVisitAt: true,
  createdAt: true,
} as const;

type GuestRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  lastVisitAt: Date | null;
  createdAt: Date;
};

/**
 * The guest of a booking (docs/modules/reservations.md → GDPR, R1.6 Q3): a live guest with the same
 * email first, else the most recently seen live guest with the same phone; a match only gets the
 * fields it doesn't have yet. Neither → a new guest.
 */
export async function resolveGuest(
  tx: TenantTransactionClient,
  tenantId: string,
  details: GuestDetails,
): Promise<string> {
  const match = await findMatch(tx, details);
  if (match) {
    await fillBlanks(tx, match, details);
    return match.id;
  }
  const created = await tx.reservationGuest.create({
    data: {
      tenantId,
      name: details.name ?? null,
      email: details.email ?? null,
      phone: details.phone ?? null,
      locale: details.locale,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * A booking's guest corrected by staff (PATCH): an email that belongs to another live guest links
 * the booking to that guest (filling its blanks); otherwise the given fields replace the current
 * guest's. Phone never relinks: families share numbers. An anonymised guest is never written
 * again (GDPR, R1.9): new details link the booking to a live guest (matched or new) instead.
 */
export async function correctGuest(
  tx: TenantTransactionClient,
  tenantId: string,
  current: { id: string; locale: string; anonymisedAt: Date | null },
  details: Partial<GuestDetails>,
): Promise<string> {
  const currentGuestId = current.id;
  if (current.anonymisedAt !== null) {
    if (details.name === undefined && details.email === undefined && details.phone === undefined) {
      return currentGuestId;
    }
    return resolveGuest(tx, tenantId, { ...details, locale: details.locale ?? current.locale });
  }
  if (details.email) {
    const owner = await tx.reservationGuest.findFirst({
      where: { email: details.email, anonymisedAt: null },
      select: GUEST_SELECT,
    });
    if (owner && owner.id !== currentGuestId) {
      await fillBlanks(tx, owner, details);
      return owner.id;
    }
  }
  const data = {
    ...(details.name !== undefined && { name: details.name }),
    ...(details.email !== undefined && { email: details.email }),
    ...(details.phone !== undefined && { phone: details.phone }),
    ...(details.locale !== undefined && { locale: details.locale }),
  };
  if (Object.keys(data).length > 0) {
    // Only while live: an anonymise that committed meanwhile wins.
    await tx.reservationGuest.updateMany({
      where: { id: currentGuestId, anonymisedAt: null },
      data,
    });
  }
  return currentGuestId;
}

async function findMatch(
  tx: TenantTransactionClient,
  details: GuestDetails,
): Promise<GuestRow | null> {
  if (details.email) {
    const byEmail = await tx.reservationGuest.findFirst({
      where: { email: details.email, anonymisedAt: null },
      select: GUEST_SELECT,
    });
    if (byEmail) return byEmail;
  }
  if (details.phone) {
    // Not unique (families): the most recently seen wins.
    const sharing = await tx.reservationGuest.findMany({
      where: { phone: details.phone, anonymisedAt: null },
      select: GUEST_SELECT,
    });
    const seen = (g: GuestRow) => (g.lastVisitAt ?? g.createdAt).getTime();
    return sharing.sort((a, b) => seen(b) - seen(a) || b.id.localeCompare(a.id))[0] ?? null;
  }
  return null;
}

/** Only fields the guest doesn't have yet; never overwrites, never refills an anonymised guest. */
async function fillBlanks(
  tx: TenantTransactionClient,
  guest: GuestRow,
  details: Partial<GuestDetails>,
): Promise<void> {
  const data = {
    ...(guest.name === null && details.name && { name: details.name }),
    ...(guest.email === null && details.email && { email: details.email }),
    ...(guest.phone === null && details.phone && { phone: details.phone }),
  };
  if (Object.keys(data).length > 0) {
    await tx.reservationGuest.updateMany({ where: { id: guest.id, anonymisedAt: null }, data });
  }
}
