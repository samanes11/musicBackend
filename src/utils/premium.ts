import { GlobalPromo } from "./globalPromoCache";

export interface EffectivePremium {
  isPremium: boolean;
  effectiveExpiresAt: Date | null;
  promoActive: boolean;
}

export function computeEffectivePremium(
  realExpiresAt: Date | string | null | undefined,
  promo: GlobalPromo,
): EffectivePremium {
  const now = new Date();
  const real = realExpiresAt ? new Date(realExpiresAt) : null;
  const realActive = !!real && real > now;
  const promoActive = promo.active && !!promo.endDate && promo.endDate > now;

  if (!promoActive) {
    return { isPremium: realActive, effectiveExpiresAt: real, promoActive: false };
  }

  const promoEnd = promo.endDate as Date;

  if (!realActive) {
    return { isPremium: true, effectiveExpiresAt: promoEnd, promoActive: true };
  }

  if (real!.getTime() < promoEnd.getTime()) {
    const remainingMs = real!.getTime() - now.getTime();
    const effective = new Date(promoEnd.getTime() + remainingMs);
    return { isPremium: true, effectiveExpiresAt: effective, promoActive: true };
  }

  return { isPremium: true, effectiveExpiresAt: real, promoActive: true };
}