import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id — docs/ARCHITECTURE.md §29.1.
 *
 * Not bcrypt: bcrypt silently truncates at 72 bytes and has no memory
 * hardness. Parameters follow the OWASP baseline (19 MiB, 2 iterations).
 */
/** 2 === Algorithm.Argon2id. The enum is ambient-const and cannot be imported
 *  under isolatedModules, so the value is inlined with this note. */
const ARGON2_ID = 2;

const ARGON2_OPTIONS = {
  algorithm: ARGON2_ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Password policy, taken from the "Yangi parol yarating" screen, which states
 * exactly two requirements: "Kamida 8 ta belgi" and "Bitta raqam yoki belgi".
 *
 * The architecture document proposed a 10-character minimum. The design is the
 * UX source of truth and its rules are already shown to the user, so 8 wins —
 * a backend that rejects what the screen says is acceptable is a bug.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Rejected outright regardless of length. */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'parol123',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'admin123',
  'retailos',
  'iloveyou',
  '11111111',
  '00000000',
]);

export interface PasswordCheck {
  valid: boolean;
  /** 0–4, drives the "Parol mustahkamligi" meter on the design's screen. */
  score: number;
  errors: string[];
}

@Injectable()
export class PasswordService {
  async hash(plain: string): Promise<string> {
    return hash(plain, ARGON2_OPTIONS);
  }

  /**
   * A malformed stored hash must not crash the login path — it returns false,
   * which surfaces as ordinary invalid credentials.
   */
  async verify(storedHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(storedHash, plain, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }

  /** Mirrors the requirement list the user was shown when choosing it. */
  check(password: string): PasswordCheck {
    const errors: string[] = [];

    if (password.length < PASSWORD_MIN_LENGTH) {
      errors.push(`Parol kamida ${PASSWORD_MIN_LENGTH} ta belgidan iborat bo'lishi kerak`);
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      errors.push(`Parol ${PASSWORD_MAX_LENGTH} ta belgidan oshmasligi kerak`);
    }
    if (!/[0-9]|[^A-Za-z0-9]/.test(password)) {
      errors.push("Parolda kamida bitta raqam yoki maxsus belgi bo'lishi kerak");
    }
    if (COMMON_PASSWORDS.has(password.toLowerCase())) {
      errors.push('Bu parol juda oddiy, boshqasini tanlang');
    }

    return { valid: errors.length === 0, score: this.score(password), errors };
  }

  /** Coarse 0–4 strength, matching the four segments in the design's meter. */
  private score(password: string): number {
    if (password.length < PASSWORD_MIN_LENGTH) return 0;

    let score = 1;
    if (password.length >= 12) score += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
    if (/[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
    return Math.min(score, 4);
  }
}
