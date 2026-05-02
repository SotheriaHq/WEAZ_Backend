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
    // Note: systemTag table not in schema, skipping operations
    console.warn('SystemTagsService.upsertTags called but systemTag table not available');
  }

  async syncTags(
    previousTags: Array<string | null | undefined>,
    nextTags: Array<string | null | undefined>,
  ): Promise<void> {
    // Note: systemTag table not in schema, skipping operations
    console.warn('SystemTagsService.syncTags called but systemTag table not available');
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
