import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';

@Injectable()
export class CustomOrderAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brandPermissionService: BrandPermissionService,
  ) {}

  async resolveBrandId(brandIdOrOwnerId: string): Promise<string> {
    const brand = await this.prisma.brand.findFirst({
      where: {
        OR: [{ id: brandIdOrOwnerId }, { ownerId: brandIdOrOwnerId }],
      },
      select: { id: true },
    });
    if (!brand) {
      throw new NotFoundException('Brand not found');
    }
    return brand.id;
  }

  async resolveCustomOrderBrandId(customOrderId: string): Promise<string> {
    const order = await this.prisma.customOrder.findUnique({
      where: { id: customOrderId },
      select: { brandId: true },
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    return order.brandId;
  }

  async assertBrandOrdersRead(userId: string, brandIdOrOwnerId: string): Promise<string> {
    const brandId = await this.resolveBrandId(brandIdOrOwnerId);
    await this.brandPermissionService.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.ORDERS_READ,
    );
    return brandId;
  }

  async assertBrandOrdersUpdate(userId: string, brandIdOrOwnerId: string): Promise<string> {
    const brandId = await this.resolveBrandId(brandIdOrOwnerId);
    await this.brandPermissionService.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.ORDERS_UPDATE,
    );
    return brandId;
  }

  async assertCustomOrderBuyerAccess(userId: string, customOrderId: string): Promise<void> {
    const order = await this.prisma.customOrder.findUnique({
      where: { id: customOrderId },
      select: { buyerId: true },
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    if (order.buyerId !== userId) {
      throw new ForbiddenException('Not authorized for this custom order');
    }
  }

  async assertCustomOrderBrandRead(userId: string, customOrderId: string): Promise<void> {
    const brandId = await this.resolveCustomOrderBrandId(customOrderId);
    await this.brandPermissionService.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.ORDERS_READ,
    );
  }

  async assertCustomOrderBrandUpdate(userId: string, customOrderId: string): Promise<void> {
    const brandId = await this.resolveCustomOrderBrandId(customOrderId);
    await this.brandPermissionService.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.ORDERS_UPDATE,
    );
  }

  async assertCustomOrderParticipantRead(userId: string, customOrderId: string): Promise<void> {
    const order = await this.prisma.customOrder.findUnique({
      where: { id: customOrderId },
      select: { buyerId: true, brandId: true },
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    if (order.buyerId === userId) {
      return;
    }
    await this.brandPermissionService.assertPermission(
      userId,
      order.brandId,
      BRAND_PERMISSIONS.ORDERS_READ,
    );
  }

  async canReadCustomOrder(userId: string, customOrderId: string): Promise<boolean> {
    try {
      await this.assertCustomOrderParticipantRead(userId, customOrderId);
      return true;
    } catch {
      return false;
    }
  }

  async canUpdateCustomOrderAsBrand(userId: string, customOrderId: string): Promise<boolean> {
    try {
      await this.assertCustomOrderBrandUpdate(userId, customOrderId);
      return true;
    } catch {
      return false;
    }
  }
}
