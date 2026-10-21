import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BrandAccessService } from './brand-access.service';
import { BrandCommerceAccessService } from './brand-commerce-access.service';
import { BrandPermissionService } from './permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from './permissions/brand-permissions';
import { BrandCustomersQueryDto } from './dto/brand-customers.dto';

@Injectable()
export class BrandCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BrandAccessService,
    private readonly permissions: BrandPermissionService,
    private readonly commerce: BrandCommerceAccessService,
  ) {}

  async settings(userId: string, id: string) {
    const { brandId } = await this.access.assertBrandOwnerAndResolve(
      userId,
      id,
    );
    return this.commerce.get(brandId);
  }

  async updateSettings(userId: string, id: string, minimumOrders: number) {
    const { brandId } = await this.access.assertBrandOwnerAndResolve(
      userId,
      id,
    );
    const entitlement = await this.commerce.get(brandId);
    if (!entitlement.canConfigureCustomers)
      throw new ForbiddenException(
        'Upgrade to a paid plan to set a customer purchase threshold.',
      );
    await this.prisma.brand.update({
      where: { id: brandId },
      data: { customerMinimumOrders: minimumOrders },
    });
    return this.commerce.get(brandId);
  }

  async list(userId: string, id: string, query: BrandCustomersQueryDto) {
    const { brandId } = await this.access.resolveBrandContext(id);
    await this.permissions.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.ORDERS_READ,
    );
    const settings = await this.commerce.get(brandId);
    const search = query.search?.trim().toLowerCase() ?? '';
    const offset = (query.page - 1) * query.limit;
    // Aggregate in Postgres: never download an entire order history to group it.
    // UNION ALL counts each standard/custom order once, irrespective of line count.
    const [result] = await this.prisma.$queryRaw<
      Array<{ items: unknown[]; total: bigint }>
    >(Prisma.sql`
      WITH purchases AS (
        SELECT "buyerId", "createdAt" FROM "Order"
        WHERE "brandId" = ${brandId}::uuid AND "buyerId" IS NOT NULL
          AND "paymentStatus" = 'PAID' AND "status" <> 'CANCELLED'
        UNION ALL
        SELECT "buyerId", "createdAt" FROM "CustomOrder"
        WHERE "brandId" = ${brandId}::uuid AND "paymentStatus" = 'PAID'
          AND "cancelledAt" IS NULL AND "anonymizedAt" IS NULL
          AND "status" NOT IN ('REJECTED_BY_BRAND', 'CANCELLED_BY_BUYER_PRE_ACCEPTANCE')
      ), customers AS (
        SELECT p."buyerId" AS id, CASE WHEN u.status = 'ACTIVE' THEN u.username ELSE NULL END AS username,
          CASE WHEN u.status = 'ACTIVE' THEN COALESCE(NULLIF(TRIM(CONCAT(up."firstName", ' ', up."lastName")), ''), u.username, 'Shopper') ELSE 'Shopper' END AS name,
          COUNT(*)::int AS "orderCount", MAX(p."createdAt") AS "lastOrderAt"
        FROM purchases p JOIN "User" u ON u."_id" = p."buyerId"
        LEFT JOIN "UserProfile" up ON up."userId" = u."_id"
        WHERE u.type = 'REGULAR'
        GROUP BY p."buyerId", u.username, u.status, up."firstName", up."lastName"
        HAVING COUNT(*) >= ${settings.effectiveMinimumOrders}
      ), filtered AS (
        SELECT * FROM customers
        WHERE ${search} = '' OR POSITION(${search} IN LOWER(CONCAT(name, ' ', username))) > 0
      ), page AS (
        SELECT * FROM filtered ORDER BY "lastOrderAt" DESC, id ASC LIMIT ${query.limit} OFFSET ${offset}
      )
      SELECT COALESCE((SELECT jsonb_agg(page ORDER BY "lastOrderAt" DESC, id ASC) FROM page), '[]'::jsonb) AS items,
        (SELECT COUNT(*) FROM filtered) AS total
    `);
    const total = Number(result?.total ?? 0);
    return {
      items: result?.items ?? [],
      total,
      page: query.page,
      limit: query.limit,
      hasNextPage: offset + query.limit < total,
      settings,
    };
  }
}
