/**
 * Phone normalisation.
 *
 * The login screen shows "+998 90 123 45 67" and the employees screen searches
 * by phone, so the same number must resolve identically however it was typed.
 * Storage is E.164 with no spaces, which the ck_user_phone_e164 database
 * constraint enforces independently.
 */

/** Uzbekistan is the launch market, so a bare 9-digit local number gets +998. */
const DEFAULT_COUNTRY_CODE = '998';

export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  if (!digits) return null;

  let candidate: string;
  if (digits.startsWith('+')) {
    candidate = digits;
  } else if (digits.startsWith('00')) {
    candidate = `+${digits.slice(2)}`;
  } else if (digits.length === 9) {
    // 901234567 -> +998901234567
    candidate = `+${DEFAULT_COUNTRY_CODE}${digits}`;
  } else {
    candidate = `+${digits}`;
  }

  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
}

/** Display form for API responses: +998 90 123 45 67. */
export function formatPhone(e164: string): string {
  const m = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(e164);
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : e164;
}
