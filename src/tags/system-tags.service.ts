import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeTag } from 'src/common/utils/tag-validator';

@Injectable()
export class SystemTagsService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeTag(tag: string): string {
    return normalizeTag(tag);
  }

  private normalizeTags(tags: Array<string | null | undefined>): string[] {
    const set = new Set<string>();
    for (const raw of tags) {
      const normalized = this.normalizeTag(String(raw ?? ''));
      if (!normalized) continue;
      set.add(normalized);
    }
    return Array.from(set);
  }

  async upsertTags(tags: Array<string | null | undefined>): Promise<void> {
    const normalized = this.normalizeTags(tags);
    if (normalized.length === 0) return;

    await this.prisma.systemTag.createMany({
      data: normalized.map((tag) => ({ id: uuidv4(), tag })),
      skipDuplicates: true,
    });
  }

  async syncTags(
    previousTags: Array<string | null | undefined>,
    nextTags: Array<string | null | undefined>,
  ): Promise<void> {
    const prev = new Set(this.normalizeTags(previousTags));
    const next = new Set(this.normalizeTags(nextTags));

    const added: string[] = [];
    const removed: string[] = [];

    for (const tag of next) {
      if (!prev.has(tag)) added.push(tag);
    }
    for (const tag of prev) {
      if (!next.has(tag)) removed.push(tag);
    }

    if (added.length > 0) {
      await this.prisma.systemTag.createMany({
        data: added.map((tag) => ({ id: uuidv4(), tag })),
        skipDuplicates: true,
      });
    }

    for (const tag of removed) {
      const stillUsed = await this.isTagUsed(tag);
      if (!stillUsed) {
        await this.prisma.systemTag.deleteMany({ where: { tag } });
      }
    }
  }

  private async isTagUsed(tag: string): Promise<boolean> {
    const [userCount, productCount, collectionCount, brandCount] = await Promise.all([
      this.prisma.user.count({
        where: { type: 'BRAND', brandTags: { has: tag } },
      }),
      this.prisma.product.count({
        where: { tags: { has: tag } },
      }),
      this.prisma.collection.count({
        where: { tags: { has: tag }, deletedAt: null },
      }),
      this.prisma.brand.count({
        where: { tags: { has: tag } },
      }),
    ]);
    return userCount + productCount + collectionCount + brandCount > 0;
  }
}
