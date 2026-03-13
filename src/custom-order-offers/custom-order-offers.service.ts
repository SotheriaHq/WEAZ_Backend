import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomOrderSourceType,
  CustomFabricRuleBasisStatus,
  MeasurementPointSource,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderPricingService } from 'src/custom-order-pricing/custom-order-pricing.service';
import {
  CreateCustomFabricRuleBasisDto,
  CreateCustomOrderOfferDto,
  QueryCustomFabricRuleBasesDto,
  QueryCustomOrderOffersDto,
  UpdateCustomOrderOfferDto,
} from './dto/custom-order-offers.dto';

@Injectable()
export class CustomOrderOffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: CustomOrderPricingService,
  ) {}

  async createOffer(ownerUserId: string, dto: CreateCustomOrderOfferDto) {
    const brand = await this.resolveBrand(ownerUserId);
    await this.assertSourceOwnership(brand.id, ownerUserId, dto.sourceType, dto.sourceId);
    await this.assertBasisAccessible(brand.id, dto.fabricRuleBasisId);
    await this.assertFreeformPointsAccessible(brand.id, dto.requiredFreeformPointIds ?? []);

    const normalizedRules = this.pricingService.validateOfferRules(dto.rules);
    this.validateOfferGuardrails(dto, dto.rules);

    const created = await this.prisma.$transaction(async (tx) => {
      const offer = await tx.customOrderOffer.create({
        data: {
          brandId: brand.id,
          sourceType: dto.sourceType,
          sourceId: dto.sourceId,
          title: dto.title.trim(),
          buyerInstructionText: dto.buyerInstructionText?.trim() || null,
          requiredMeasurementKeys: dto.requiredMeasurementKeys,
          requiredFreeformPointIds: dto.requiredFreeformPointIds ?? [],
          fabricRuleBasisId: dto.fabricRuleBasisId,
          baseProductionCharge: new Prisma.Decimal(dto.baseProductionCharge),
          fabricCostPerYard: new Prisma.Decimal(dto.fabricCostPerYard),
          rushEnabled: dto.rushEnabled,
          rushFee: dto.rushFee ? new Prisma.Decimal(dto.rushFee) : null,
          rushProductionLeadDays: dto.rushProductionLeadDays ?? null,
          productionLeadDays: dto.productionLeadDays,
          deliveryMinDays: dto.deliveryMinDays,
          deliveryMaxDays: dto.deliveryMaxDays,
          deliveryScope: dto.deliveryScope.trim(),
          revisionPolicy: dto.revisionPolicy.trim(),
          returnPolicy: dto.returnPolicy.trim(),
          defectPolicy: dto.defectPolicy.trim(),
          fabricSourcingMode: dto.fabricSourcingMode,
          notes: dto.notes?.trim() || null,
          rules: {
            create: dto.rules.map((rule) => ({
              priority: rule.priority,
              conditionsJson: rule.conditionsJson as Prisma.InputJsonValue,
              outputYards: new Prisma.Decimal(rule.outputYards),
              isFallback: Boolean(rule.isFallback),
            })),
          },
        },
        include: {
          rules: { orderBy: { priority: 'asc' } },
        },
      });

      const snapshotJson = this.buildOfferSnapshot(offer, normalizedRules);
      await tx.customOrderOfferVersion.create({
        data: {
          offerId: offer.id,
          version: 1,
          snapshotJson,
          createdById: ownerUserId,
        },
      });

      await this.enableSourceCustomOrdering(tx, dto.sourceType, dto.sourceId);
      return offer;
    });

    return {
      statusCode: 201,
      message: 'Custom order offer created',
      data: {
        id: created.id,
        currentVersion: created.currentVersion,
        isActive: created.isActive,
      },
    };
  }

  async updateOffer(ownerUserId: string, offerId: string, dto: UpdateCustomOrderOfferDto) {
    const brand = await this.resolveBrand(ownerUserId);
    const existing = await this.prisma.customOrderOffer.findFirst({
      where: { id: offerId, brandId: brand.id },
      include: {
        rules: { orderBy: { priority: 'asc' } },
      },
    });

    if (!existing) {
      throw new NotFoundException('Custom order offer not found');
    }

    if (dto.sourceType || dto.sourceId) {
      await this.assertSourceOwnership(
        brand.id,
        ownerUserId,
        dto.sourceType ?? existing.sourceType,
        dto.sourceId ?? existing.sourceId,
      );
    }

    if (dto.fabricRuleBasisId) {
      await this.assertBasisAccessible(brand.id, dto.fabricRuleBasisId);
    }
    if (dto.requiredFreeformPointIds) {
      await this.assertFreeformPointsAccessible(brand.id, dto.requiredFreeformPointIds);
    }

    const mergedRuleDtos = dto.rules ?? existing.rules.map((rule) => ({
      priority: rule.priority,
      conditionsJson: rule.conditionsJson as Record<string, unknown>,
      outputYards: String(rule.outputYards),
      isFallback: rule.isFallback,
    }));
    const normalizedRules = this.pricingService.validateOfferRules(mergedRuleDtos);
    const mergedOffer = {
      ...existing,
      ...dto,
      sourceType: dto.sourceType ?? existing.sourceType,
      sourceId: dto.sourceId ?? existing.sourceId,
      title: dto.title ?? existing.title,
      buyerInstructionText: dto.buyerInstructionText ?? existing.buyerInstructionText,
      requiredMeasurementKeys: dto.requiredMeasurementKeys ?? existing.requiredMeasurementKeys,
      requiredFreeformPointIds:
        dto.requiredFreeformPointIds ?? existing.requiredFreeformPointIds,
      fabricRuleBasisId: dto.fabricRuleBasisId ?? existing.fabricRuleBasisId,
      baseProductionCharge: dto.baseProductionCharge ?? String(existing.baseProductionCharge),
      fabricCostPerYard: dto.fabricCostPerYard ?? String(existing.fabricCostPerYard),
      rushEnabled: dto.rushEnabled ?? existing.rushEnabled,
      rushFee: dto.rushFee ?? (existing.rushFee ? String(existing.rushFee) : undefined),
      rushProductionLeadDays:
        dto.rushProductionLeadDays ?? existing.rushProductionLeadDays ?? undefined,
      productionLeadDays: dto.productionLeadDays ?? existing.productionLeadDays,
      deliveryMinDays: dto.deliveryMinDays ?? existing.deliveryMinDays,
      deliveryMaxDays: dto.deliveryMaxDays ?? existing.deliveryMaxDays,
      deliveryScope: dto.deliveryScope ?? existing.deliveryScope,
      revisionPolicy: dto.revisionPolicy ?? existing.revisionPolicy,
      returnPolicy: dto.returnPolicy ?? existing.returnPolicy,
      defectPolicy: dto.defectPolicy ?? existing.defectPolicy,
      fabricSourcingMode: dto.fabricSourcingMode ?? existing.fabricSourcingMode,
      notes: dto.notes ?? existing.notes,
      rules: mergedRuleDtos,
    };
    this.validateOfferGuardrails(mergedOffer, mergedRuleDtos);

    const updated = await this.prisma.$transaction(async (tx) => {
      const nextVersion = existing.currentVersion + 1;
      const offer = await tx.customOrderOffer.update({
        where: { id: offerId },
        data: {
          sourceType: mergedOffer.sourceType,
          sourceId: mergedOffer.sourceId,
          title: String(mergedOffer.title).trim(),
          buyerInstructionText: mergedOffer.buyerInstructionText?.trim() || null,
          requiredMeasurementKeys: mergedOffer.requiredMeasurementKeys,
          requiredFreeformPointIds: mergedOffer.requiredFreeformPointIds,
          fabricRuleBasisId: mergedOffer.fabricRuleBasisId,
          baseProductionCharge: new Prisma.Decimal(mergedOffer.baseProductionCharge),
          fabricCostPerYard: new Prisma.Decimal(mergedOffer.fabricCostPerYard),
          rushEnabled: Boolean(mergedOffer.rushEnabled),
          rushFee: mergedOffer.rushFee ? new Prisma.Decimal(mergedOffer.rushFee) : null,
          rushProductionLeadDays: mergedOffer.rushProductionLeadDays ?? null,
          productionLeadDays: mergedOffer.productionLeadDays,
          deliveryMinDays: mergedOffer.deliveryMinDays,
          deliveryMaxDays: mergedOffer.deliveryMaxDays,
          deliveryScope: String(mergedOffer.deliveryScope).trim(),
          revisionPolicy: String(mergedOffer.revisionPolicy).trim(),
          returnPolicy: String(mergedOffer.returnPolicy).trim(),
          defectPolicy: String(mergedOffer.defectPolicy).trim(),
          fabricSourcingMode: mergedOffer.fabricSourcingMode,
          notes: mergedOffer.notes?.trim() || null,
          currentVersion: nextVersion,
          rules: {
            deleteMany: {},
            create: mergedRuleDtos.map((rule) => ({
              priority: rule.priority,
              conditionsJson: rule.conditionsJson as Prisma.InputJsonValue,
              outputYards: new Prisma.Decimal(rule.outputYards),
              isFallback: Boolean(rule.isFallback),
            })),
          },
        },
        include: {
          rules: { orderBy: { priority: 'asc' } },
        },
      });

      await tx.customOrderOfferVersion.create({
        data: {
          offerId: offer.id,
          version: nextVersion,
          snapshotJson: this.buildOfferSnapshot(offer, normalizedRules),
          createdById: ownerUserId,
        },
      });

      await this.enableSourceCustomOrdering(tx, mergedOffer.sourceType, mergedOffer.sourceId);
      return offer;
    });

    return {
      statusCode: 200,
      message: 'Custom order offer updated',
      data: {
        id: updated.id,
        currentVersion: updated.currentVersion,
        isActive: updated.isActive,
      },
    };
  }

  async getOffer(offerId: string, authUserId?: string) {
    const offer = await this.prisma.customOrderOffer.findUnique({
      where: { id: offerId },
      include: {
        brand: { select: { ownerId: true, name: true } },
        fabricRuleBasis: true,
        rules: { orderBy: { priority: 'asc' } },
        versions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });

    if (!offer) {
      throw new NotFoundException('Custom order offer not found');
    }

    const isOwner = authUserId === offer.brand.ownerId;
    if (!offer.isActive && !isOwner) {
      throw new NotFoundException('Custom order offer not found');
    }

    return {
      statusCode: 200,
      message: 'Custom order offer retrieved',
      data: offer,
    };
  }

  async listVisibleOffers(authUserId: string | undefined, query: QueryCustomOrderOffersDto) {
    const page = query.page ?? 1;
    const take = query.limit ?? 20;
    const brand = authUserId
      ? await this.prisma.brand.findUnique({
          where: { ownerId: authUserId },
          select: { id: true },
        })
      : null;

    const where: Prisma.CustomOrderOfferWhereInput = {
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query.sourceId ? { sourceId: query.sourceId } : {}),
      ...(query.isActive == null ? { isActive: true } : { isActive: query.isActive }),
      ...(brand?.id
        ? {
            OR: [
              { isActive: true },
              { brandId: brand.id },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customOrderOffer.findMany({
        where,
        include: {
          brand: { select: { id: true, name: true, ownerId: true } },
          fabricRuleBasis: true,
          rules: { orderBy: { priority: 'asc' } },
          versions: { orderBy: { version: 'desc' }, take: 1 },
        },
        orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.customOrderOffer.count({ where }),
    ]);

    const visibleItems = brand?.id
      ? items.filter((item) => item.isActive || item.brandId === brand.id)
      : items.filter((item) => item.isActive);

    return {
      statusCode: 200,
      message: 'Custom order offers retrieved',
      data: {
        items: visibleItems,
        page,
        limit: take,
        total,
      },
    };
  }

  async listBrandOffers(ownerUserId: string, brandId: string, query: QueryCustomOrderOffersDto) {
    const brand = await this.resolveBrand(ownerUserId);
    if (brand.id !== brandId) {
      throw new ForbiddenException('Not authorized for this brand');
    }

    const page = query.page ?? 1;
    const take = query.limit ?? 20;
    const where: Prisma.CustomOrderOfferWhereInput = {
      brandId,
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query.sourceId ? { sourceId: query.sourceId } : {}),
      ...(query.isActive == null ? {} : { isActive: query.isActive }),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customOrderOffer.findMany({
        where,
        include: {
          rules: { orderBy: { priority: 'asc' } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.customOrderOffer.count({ where }),
    ]);

    return {
      statusCode: 200,
      message: 'Custom order offers retrieved',
      data: {
        items,
        page,
        limit: take,
        total,
      },
    };
  }

  async createBasis(ownerUserId: string, dto: CreateCustomFabricRuleBasisDto) {
    const brand = await this.resolveBrand(ownerUserId);
    const measurementKeys = Array.from(new Set(dto.measurementKeys.map((key) => key.trim()).filter(Boolean)));
    if (measurementKeys.length === 0) {
      throw new BadRequestException('At least one measurement key is required for a fabric rule basis');
    }

    const created = await this.prisma.customFabricRuleBasis.create({
      data: {
        label: dto.label.trim(),
        measurementKeys,
        brandId: brand.id,
        source: 'BRAND_FREEFORM',
        status: 'BRAND_ONLY',
      },
    });

    return {
      statusCode: 201,
      message: 'Custom fabric rule basis created',
      data: created,
    };
  }

  async listBases(authUserId: string | undefined, query: QueryCustomFabricRuleBasesDto) {
    let brandId: string | null = null;
    if (authUserId) {
      const brand = await this.prisma.brand.findUnique({
        where: { ownerId: authUserId },
        select: { id: true },
      });
      brandId = brand?.id ?? null;
    }

    const items = await this.prisma.customFabricRuleBasis.findMany({
      where: brandId && query.includeBrandOnly
        ? {
            OR: [
              { status: CustomFabricRuleBasisStatus.APPROVED_GLOBAL },
              { brandId },
            ],
          }
        : { status: CustomFabricRuleBasisStatus.APPROVED_GLOBAL },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });

    return {
      statusCode: 200,
      message: 'Custom fabric rule bases retrieved',
      data: items,
    };
  }

  private async resolveBrand(ownerUserId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId: ownerUserId },
      select: { id: true },
    });

    if (!brand) {
      throw new NotFoundException('Brand profile not found');
    }

    return brand;
  }

  private async assertSourceOwnership(
    brandId: string,
    ownerUserId: string,
    sourceType: CustomOrderSourceType,
    sourceId: string,
  ) {
    if (sourceType === CustomOrderSourceType.PRODUCT) {
      const product = await this.prisma.product.findFirst({
        where: { id: sourceId, brandId },
        select: { id: true },
      });
      if (!product) {
        throw new BadRequestException('Product source was not found for this brand');
      }
      return;
    }

    const design = await this.prisma.collection.findFirst({
      where: {
        id: sourceId,
        ownerId: ownerUserId,
        OR: [{ domain: 'DESIGN' }, { isAvailableInStore: false }],
      },
      select: { id: true },
    });

    if (!design) {
      throw new BadRequestException('Design source was not found for this brand');
    }
  }

  private async assertBasisAccessible(brandId: string, basisId: string) {
    const basis = await this.prisma.customFabricRuleBasis.findFirst({
      where: {
        id: basisId,
        OR: [
          { status: CustomFabricRuleBasisStatus.APPROVED_GLOBAL },
          { brandId },
        ],
      },
      select: { id: true },
    });

    if (!basis) {
      throw new BadRequestException('Custom fabric rule basis is not accessible to this brand');
    }
  }

  private async assertFreeformPointsAccessible(brandId: string, pointIds: string[]) {
    if (!pointIds.length) {
      return;
    }

    const points = await this.prisma.measurementPoint.findMany({
      where: {
        id: { in: pointIds },
        OR: [
          {
            source: MeasurementPointSource.SYSTEM,
          },
          {
            source: MeasurementPointSource.BRAND_FREEFORM,
            brandId,
          },
        ],
      },
      select: { id: true },
    });

    if (points.length !== pointIds.length) {
      throw new BadRequestException('One or more required freeform measurement points are not accessible');
    }
  }

  private validateOfferGuardrails(
    dto: Pick<
      CreateCustomOrderOfferDto,
      | 'rushEnabled'
      | 'rushFee'
      | 'rushProductionLeadDays'
      | 'productionLeadDays'
      | 'deliveryMinDays'
      | 'deliveryMaxDays'
      | 'baseProductionCharge'
      | 'fabricCostPerYard'
    >,
    rules: Array<{ outputYards: string }> = [],
  ) {
    if (dto.deliveryMinDays > dto.deliveryMaxDays) {
      throw new BadRequestException('Delivery minimum days cannot exceed delivery maximum days');
    }

    if (Number(dto.baseProductionCharge) <= 0) {
      throw new BadRequestException('Base production charge must be greater than zero');
    }
    if (Number(dto.fabricCostPerYard) < 0) {
      throw new BadRequestException('Fabric cost per yard cannot be negative');
    }

    if (!dto.rushEnabled) {
      return;
    }

    if (!dto.rushFee || Number(dto.rushFee) <= 0) {
      throw new BadRequestException('Rush-enabled offers must define a positive rush fee');
    }

    const maxOutputYards = rules.reduce((currentMax, rule) => {
      const yards = Number(rule.outputYards);
      return Number.isFinite(yards) ? Math.max(currentMax, yards) : currentMax;
    }, 0);
    const estimatedPreDeliverySubtotal =
      Number(dto.baseProductionCharge) + maxOutputYards * Number(dto.fabricCostPerYard);
    if (
      estimatedPreDeliverySubtotal > 0 &&
      Number(dto.rushFee) > estimatedPreDeliverySubtotal * 0.7
    ) {
      throw new BadRequestException(
        'Rush fee cannot exceed 70% of the estimated outfit subtotal before delivery',
      );
    }

    if (!dto.rushProductionLeadDays || dto.rushProductionLeadDays < 5) {
      throw new BadRequestException('Rush production lead days must be at least 5');
    }
    if (dto.rushProductionLeadDays >= dto.productionLeadDays) {
      throw new BadRequestException('Rush production lead time must be shorter than standard production lead time');
    }
  }

  private buildOfferSnapshot(
    offer: {
      id: string;
      brandId: string;
      sourceType: CustomOrderSourceType;
      sourceId: string;
      title: string;
      buyerInstructionText: string | null;
      requiredMeasurementKeys: string[];
      requiredFreeformPointIds: string[];
      fabricRuleBasisId: string;
      baseProductionCharge: Prisma.Decimal;
      fabricCostPerYard: Prisma.Decimal;
      rushEnabled: boolean;
      rushFee: Prisma.Decimal | null;
      rushProductionLeadDays: number | null;
      productionLeadDays: number;
      deliveryMinDays: number;
      deliveryMaxDays: number;
      deliveryScope: string;
      revisionPolicy: string;
      returnPolicy: string;
      defectPolicy: string;
      fabricSourcingMode: string;
      notes: string | null;
    },
    normalizedRules: ReturnType<CustomOrderPricingService['validateOfferRules']>,
  ): Prisma.InputJsonValue {
    return {
      id: offer.id,
      brandId: offer.brandId,
      sourceType: offer.sourceType,
      sourceId: offer.sourceId,
      title: offer.title,
      buyerInstructionText: offer.buyerInstructionText,
      requiredMeasurementKeys: offer.requiredMeasurementKeys,
      requiredFreeformPointIds: offer.requiredFreeformPointIds,
      fabricRuleBasisId: offer.fabricRuleBasisId,
      baseProductionCharge: String(offer.baseProductionCharge),
      fabricCostPerYard: String(offer.fabricCostPerYard),
      rushEnabled: offer.rushEnabled,
      rushFee: offer.rushFee ? String(offer.rushFee) : null,
      rushProductionLeadDays: offer.rushProductionLeadDays,
      productionLeadDays: offer.productionLeadDays,
      deliveryMinDays: offer.deliveryMinDays,
      deliveryMaxDays: offer.deliveryMaxDays,
      deliveryScope: offer.deliveryScope,
      revisionPolicy: offer.revisionPolicy,
      returnPolicy: offer.returnPolicy,
      defectPolicy: offer.defectPolicy,
      fabricSourcingMode: offer.fabricSourcingMode,
      notes: offer.notes,
      rules: normalizedRules.map((rule) => ({
        priority: rule.priority,
        isFallback: rule.isFallback,
        outputYards: rule.outputYards.toFixed(2),
        conditions: rule.conditions,
      })),
    } as unknown as Prisma.InputJsonValue;
  }

  private async enableSourceCustomOrdering(
    tx: Prisma.TransactionClient,
    sourceType: CustomOrderSourceType,
    sourceId: string,
  ) {
    if (sourceType === CustomOrderSourceType.PRODUCT) {
      await tx.product.update({
        where: { id: sourceId },
        data: { customOrderEnabled: true },
      });
      return;
    }

    await tx.collection.update({
      where: { id: sourceId },
      data: { customOrderEnabled: true },
    });
  }
}
