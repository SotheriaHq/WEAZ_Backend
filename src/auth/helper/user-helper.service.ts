import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

// Helper service for generating usernames and Industri numbers
@Injectable()
export class UserHelperService {
  constructor(
    private readonly prisma: PrismaService, // Database access
  ) {}

  // Generates a concise, unique username. Prefers short forms, no hyphens unless needed.
  async generateUniqueUsername(
    firstName: string,
    lastName: string,
  ): Promise<string> {
    const clean = (s: string) =>
      (s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-z0-9]/g, '');

    const f = clean(firstName);
    const l = clean(lastName);

    // Base candidate: first initial + last name, trimmed to max 12 chars
    const baseRaw = `${f.slice(0, 1)}${l}`;
    const MAX = 12;
    const base = baseRaw.slice(0, MAX) || f || l || 'user';

    // Try base, then append numbers; avoid hyphens unless necessary
    if (await this.isUsernameAvailable(base)) return base;

    for (let i = 1; i <= 9999; i++) {
      const candidate = `${base}${i}`.slice(0, 15); // cap length sensibly
      if (await this.isUsernameAvailable(candidate)) return candidate;
    }

    // Very rare fallback: include hyphen and timestamp tail
    const fallback = `${base}-${Date.now().toString().slice(-4)}`;
    if (await this.isUsernameAvailable(fallback)) return fallback;
    return `${base}${Math.floor(Math.random() * 10000)}`;
  }

  // Generate username from brandFullName using short slug without hyphens unless necessary
  async generateUsernameFromBrand(brandFullName: string): Promise<string> {
    const clean = (s: string) =>
      (s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-z0-9]/g, '');

    const raw = clean(brandFullName);
    const base = raw.slice(0, 14) || 'brand';
    if (await this.isUsernameAvailable(base)) return base;

    for (let i = 1; i <= 9999; i++) {
      const candidate = `${base}${i}`;
      if (await this.isUsernameAvailable(candidate)) return candidate;
    }

    // As a last resort, allow hyphen with short suffix
    for (let j = 1000; j < 10000; j++) {
      const candidate = `${base}-${j}`;
      if (await this.isUsernameAvailable(candidate)) return candidate;
    }
    return `${base}${Math.floor(Math.random() * 100000)}`;
  }

  // Checks if a username is available
  private async isUsernameAvailable(username: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    return !user; // True if username is not taken
  }

  // Generates a unique 15-digit Industri number starting with 'IDT'
  async generateIndustriNumber(): Promise<string> {
    const PREFIX = 'IDT';
    const NUMBER_LENGTH = 12; // 15 digits total (3 for IDT + 12 random)

    while (true) {
      // Generate 12 random digits
      const randomDigits = Math.floor(Math.random() * 10 ** NUMBER_LENGTH)
        .toString()
        .padStart(NUMBER_LENGTH, '0');

      const industriNumber = `${PREFIX}${randomDigits}`;

      // Check if number is unique
      const existing = await this.prisma.user.findUnique({
        where: { industriNumber },
        select: { id: true },
      });

      if (!existing) {
        return industriNumber; // Return unique number
      }
    }
  }
}
