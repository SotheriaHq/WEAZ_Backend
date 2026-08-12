import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id cost parameters.
 *
 * These were `m=65536 (64 MiB), t=3, p=8`. Two problems, both paid on every
 * single login and password check:
 *
 * 1. `parallelism: 8` does not make hashing faster — it splits the work into 8
 *    lanes that all must complete. On a box with 1-2 vCPUs (which is what the
 *    API runs on) those lanes are serialised, so the setting adds coordination
 *    overhead and buys no security the memory cost does not already provide.
 * 2. 64 MiB per concurrent hash on a ~2 GB host is a memory spike as well as a
 *    CPU one; several simultaneous logins contend for RAM the process needs for
 *    everything else.
 *
 * The values below are OWASP's recommended argon2id baseline (m=19 MiB, t=2,
 * p=1) — a configuration OWASP considers equivalent in strength to the higher
 * memory/lower time variants, not a downgrade to something weaker. Override per
 * environment with `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM`
 * if a bigger box justifies more.
 *
 * Existing hashes are unaffected: argon2 encodes its parameters INTO the hash
 * string, so `verify` keeps using whatever each stored hash was created with.
 * `needsRehash` below migrates each user to the current parameters the next
 * time they successfully authenticate.
 */
const readPositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: readPositiveInt(process.env.ARGON2_MEMORY_KIB, 19456),
  timeCost: readPositiveInt(process.env.ARGON2_TIME_COST, 2),
  parallelism: readPositiveInt(process.env.ARGON2_PARALLELISM, 1),
};

@Injectable()
export class PasswordService {
  async hashPassword(password: string): Promise<string> {
    try {
      return await argon2.hash(password, ARGON2_OPTIONS);
    } catch (error) {
      throw new Error(`Failed to hash password: ${error.message}`);
    }
  }

  async verifyPassword(
    hashedPassword: string,
    plainPassword: string,
  ): Promise<boolean> {
    try {
      return await argon2.verify(hashedPassword, plainPassword);
    } catch (error) {
      throw new Error(`Failed to verify password: ${error.message}`);
    }
  }

  /**
   * True when `hashedPassword` was produced with parameters other than the
   * current ones — i.e. an old 64 MiB / p=8 hash that will keep costing its
   * original price on every login until it is rewritten.
   */
  needsRehash(hashedPassword: string): boolean {
    try {
      return argon2.needsRehash(hashedPassword, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }
}
