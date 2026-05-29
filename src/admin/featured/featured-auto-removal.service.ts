import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NotificationType } from '@prisma/client';

const PENALTY_MONTHS = 2;

/**
 * Provides auto-removal hooks for the featured system.
 * These methods should be called from relevant services when
 * products/designs are deactivated, deleted, archived, or when
 * brand owners are suspended.
 */
@Injectable()
export class FeaturedAutoRemovalService {
  private readonly logger = new Logger(FeaturedAutoRemovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Call when a product is deactivated, deleted, or archived.
   * Applies a 2-month penalty to the brand.
   */
  async onProductDeactivated(productId: string, reason: string) {
    await this.removeAndPenalize('PRODUCT', productId, reason);
  }

  /**
   * Call when a design (Collection) is unpublished, deleted, or archived.
   * Applies a 2-month penalty to the brand.
   */
  async onDesignDeactivated(collectionId: string, reason: string) {
    await this.removeAndPenalize('DESIGN', collectionId, reason);
  }

  /**
   * Call when a brand owner is suspended or deactivated.
   * Removes ALL featured items for that brand with penalty.
   */
  async onBrandOwnerSuspended(brandId: string) {
    const activeItems = await this.prisma.featuredItem.findMany({
      where: { brandId, isActive: true },
    });
    if (!activeItems.length) return;

    const penaltyUntil = new Date();
    penaltyUntil.setMonth(penaltyUntil.getMonth() + PENALTY_MONTHS);

    await this.prisma.$transaction(async (tx) => {
      for (const item of activeItems) {
        await tx.featuredItem.update({
          where: { id: item.id },
          data: {
            isActive: false,
            removedAt: new Date(),
            removeReason: 'BRAND_SUSPENDED',
          },
        });
      }

      await tx.brand.update({
        where: { id: brandId },
        data: { featuredPenaltyUntil: penaltyUntil },
      });
    });

    this.logger.warn(
      `Auto-removed ${activeItems.length} featured item(s) for brand ${brandId}: BRAND_SUSPENDED. Penalty until ${penaltyUntil.toISOString()}`,
    );

    // Notify brand owner
    for (const item of activeItems) {
      this.notifyBrandOwner(
        brandId,
        item.entityType,
        item.entityId,
        'BRAND_SUSPENDED',
      ).catch((err) =>
        this.logger.warn(
          `Failed to send auto-removal notification: ${err?.message}`,
        ),
      );
    }
  }

  // ── Private ──

  private async removeAndPenalize(
    entityType: string,
    entityId: string,
    reason: string,
  ) {
    const active = await this.prisma.featuredItem.findFirst({
      where: { entityType, entityId, isActive: true },
    });
    if (!active) return;

    const penaltyUntil = new Date();
    penaltyUntil.setMonth(penaltyUntil.getMonth() + PENALTY_MONTHS);

    await this.prisma.$transaction(async (tx) => {
      await tx.featuredItem.update({
        where: { id: active.id },
        data: {
          isActive: false,
          removedAt: new Date(),
          removeReason: reason,
        },
      });

      await tx.brand.update({
        where: { id: active.brandId },
        data: { featuredPenaltyUntil: penaltyUntil },
      });
    });

    this.logger.warn(
      `Auto-removed featured ${entityType} ${entityId}: ${reason}. Brand ${active.brandId} penalized until ${penaltyUntil.toISOString()}`,
    );

    // Notify brand owner
    this.notifyBrandOwner(active.brandId, entityType, entityId, reason).catch(
      (err) =>
        this.logger.warn(
          `Failed to send auto-removal notification: ${err?.message}`,
        ),
    );
  }

  private async notifyBrandOwner(
    brandId: string,
    entityType: string,
    entityId: string,
    reason: string,
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { ownerId: true },
    });
    if (!brand?.ownerId) return;

    await this.notifications.create(
      brand.ownerId,
      NotificationType.FEATURED_AUTO_REMOVED,
      {
        payload: { entityType, entityId, reason },
        target: {
          type: entityType === 'DESIGN' ? 'COLLECTION' : 'PRODUCT',
          id: entityId,
        },
      },
    );
  }
}
