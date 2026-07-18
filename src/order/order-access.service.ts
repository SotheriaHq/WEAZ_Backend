import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';

@Injectable()
export class OrderAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brandPermissionService: BrandPermissionService,
  ) {}

  async resolveOrderBrandId(orderId: string): Promise<string> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { brandId: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order.brandId;
  }

  async assertOrderBuyerAccess(userId: string, orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { buyerId: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (!order.buyerId || order.buyerId !== userId) {
      throw new ForbiddenException('Not authorized for this order');
    }
  }

  /**
   * When pathBrandIdOrOwnerId is provided, the order must belong to that brand
   * (after resolving Brand UUID or owner user id). Prevents path/target drift.
   */
  private async resolveAndMatchOrderBrand(
    orderId: string,
    pathBrandIdOrOwnerId?: string,
  ): Promise<string> {
    const orderBrandId = await this.resolveOrderBrandId(orderId);
    if (!pathBrandIdOrOwnerId) {
      return orderBrandId;
    }
    const pathBrand = await this.prisma.brand.findFirst({
      where: {
        OR: [
          { id: pathBrandIdOrOwnerId },
          { ownerId: pathBrandIdOrOwnerId },
        ],
      },
      select: { id: true },
    });
    if (!pathBrand || pathBrand.id !== orderBrandId) {
      throw new NotFoundException('Order not found');
    }
    return orderBrandId;
  }

  async assertOrderBrandRead(
    userId: string,
    orderId: string,
    pathBrandIdOrOwnerId?: string,
  ): Promise<void> {
    const brandId = await this.resolveAndMatchOrderBrand(
      orderId,
      pathBrandIdOrOwnerId,
    );
    await this.brandPermissionService.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.ORDERS_READ,
    );
  }

  async assertOrderBrandUpdate(
    userId: string,
    orderId: string,
    pathBrandIdOrOwnerId?: string,
  ): Promise<void> {
    const brandId = await this.resolveAndMatchOrderBrand(
      orderId,
      pathBrandIdOrOwnerId,
    );
    await this.brandPermissionService.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.ORDERS_UPDATE,
    );
  }

  async assertOrderParticipantRead(
    userId: string,
    orderId: string,
  ): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { buyerId: true, brandId: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.buyerId && order.buyerId === userId) {
      return;
    }
    await this.brandPermissionService.assertPermission(
      userId,
      order.brandId,
      BRAND_PERMISSIONS.ORDERS_READ,
    );
  }
}
