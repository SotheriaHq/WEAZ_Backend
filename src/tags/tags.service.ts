import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns a list of popular tags aggregated from collections.tags and users.brandTags
   */
  async getPopularTags(limit = 50): Promise<{ tag: string; count: number }[]> {
    // Fetch tags arrays from published collections and from users
    const [collections, users] = await Promise.all([
      this.prisma.collection.findMany({
        where: { status: 'PUBLISHED' },
        select: { tags: true },
        take: 5000, // safety cap; replace with SQL unnest for very large datasets
      }),
      this.prisma.user.findMany({
        select: { brandTags: true },
        take: 5000,
      }),
    ]);

    const counts = new Map<string, number>();
    const bump = (t?: string | null) => {
      if (!t) return;
      const tag = t.trim();
      if (!tag) return;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    };

    for (const c of collections) for (const t of c.tags ?? []) bump(t);
    for (const u of users) for (const t of u.brandTags ?? []) bump(t);

    const sorted = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, Math.max(1, Math.min(200, limit)));

    return sorted;
  }
}
