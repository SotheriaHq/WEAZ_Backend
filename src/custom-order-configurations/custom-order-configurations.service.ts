import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomOrderSourceType,
  CustomFabricRuleBasisStatus,
  Gender,
  MeasurementPointSource,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderPricingService } from 'src/custom-order-pricing/custom-order-pricing.service';
import {
  CreateCustomFabricRuleBasisDto,
  CreateCustomOrderConfigurationDto,
  CustomOrderConfigurationSizeExtraYardDto,
  QueryCustomFabricRuleBasesDto,
  QueryVisibleCustomOrderConfigurationsDto,
  UpdateCustomOrderConfigurationDto,
} from './dto/custom-order-configurations.dto';
import {
  measurementKeysContainOppositeGender,
  normalizeIdList as normalizeIdArray,
  normalizeMeasurementKeyList as normalizeMeasurementKeyArray,
  resolveGarmentMeasurementTemplate,
  resolveSourceMeasurementGender,
} from '../custom-orders/custom-order-measurement-contract.util';

@Injectable()
export class CustomOrderConfigurationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: CustomOrderPricingService,
  ) {}

  async createConfiguration(ownerUserId: string, dto: CreateCustomOrderConfigurationDto) {
    const brand = await this.resolveBrand(ownerUserId);
    await this.assertSourceOwnership(brand.id, ownerUserId, dto.sourceType, dto.sourceId);
    await this.assertBasisAccessible(brand.id, dto.fabricRuleBasisId);
    await this.assertFreeformPointsAccessible(brand.id, dto.requiredFreeformPointIds ?? []);
    const resolvedTitle = this.resolveConfigurationTitle(dto.title);

    const normalizedRules = this.pricingService.validateConfigurationRules(dto.rules);
    this.validateConfigurationGuardrails(dto, dto.rules);

const created = await this.prisma.$transaction(async (tx) => {
      await this.deactivateSiblingConfigurations(
        tx,
        dto.sourceType,
        dto.sourceId,
      );

      const configuration = await tx.customOrderConfiguration.create({
        data: {
          brandId: brand.id,
          sourceType: dto.sourceType,
          sourceId: dto.sourceId,
          title: resolvedTitle,
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
          notes: this.composeConfigurationNotes(
            dto.notes,
            dto.averageBaseYards,
            dto.sizeExtraYards,
          ),
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

      const snapshotJson = this.buildConfigurationSnapshot(configuration, normalizedRules);
      await tx.customOrderConfigurationVersion.create({
        data: {
          configurationId: configuration.id,
          version: 1,
          snapshotJson,
          createdById: ownerUserId,
        },
      });

      await this.enableSourceCustomOrdering(tx, dto.sourceType, dto.sourceId);
      return configuration;
    });

    const hydrated = await this.prisma.customOrderConfiguration.findUnique({
      where: { id: created.id },
      include: {
        brand: { select: { id: true, name: true, ownerId: true } },
        fabricRuleBasis: true,
        rules: { orderBy: { priority: 'asc' } },
        versions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });

    if (!hydrated) {
      throw new NotFoundException('Custom order configuration not found after creation');
    }

    return {
      statusCode: 201,
      message: 'Custom order configuration created',
      data: hydrated,
    };
  }

  async updateConfiguration(ownerUserId: string, configurationId: string, dto: UpdateCustomOrderConfigurationDto) {
    const brand = await this.resolveBrand(ownerUserId);
    const existing = await this.prisma.customOrderConfiguration.findFirst({
      where: { id: configurationId, brandId: brand.id },
      include: {
        rules: { orderBy: { priority: 'asc' } },
      },
    });

    if (!existing) {
      throw new NotFoundException('Custom order configuration not found');
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
    const normalizedRules = this.pricingService.validateConfigurationRules(mergedRuleDtos);
    const mergedConfiguration = {
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
      averageBaseYards: dto.averageBaseYards,
      sizeExtraYards: dto.sizeExtraYards,
      rules: mergedRuleDtos,
    };
    this.validateConfigurationGuardrails(mergedConfiguration, mergedRuleDtos);

    const updated = await this.prisma.$transaction(async (tx) => {
      const nextVersion = existing.currentVersion + 1;
      const resolvedTitle = this.resolveConfigurationTitle(mergedConfiguration.title, existing.title);
      await this.deactivateSiblingConfigurations(
        tx,
        mergedConfiguration.sourceType,
        mergedConfiguration.sourceId,
        configurationId,
      );
      const configuration = await tx.customOrderConfiguration.update({
        where: { id: configurationId },
        data: {
          sourceType: mergedConfiguration.sourceType,
          sourceId: mergedConfiguration.sourceId,
          title: resolvedTitle,
          buyerInstructionText: mergedConfiguration.buyerInstructionText?.trim() || null,
          requiredMeasurementKeys: mergedConfiguration.requiredMeasurementKeys,
          requiredFreeformPointIds: mergedConfiguration.requiredFreeformPointIds,
          fabricRuleBasisId: mergedConfiguration.fabricRuleBasisId,
          baseProductionCharge: new Prisma.Decimal(mergedConfiguration.baseProductionCharge),
          fabricCostPerYard: new Prisma.Decimal(mergedConfiguration.fabricCostPerYard),
          rushEnabled: Boolean(mergedConfiguration.rushEnabled),
          rushFee: mergedConfiguration.rushFee ? new Prisma.Decimal(mergedConfiguration.rushFee) : null,
          rushProductionLeadDays: mergedConfiguration.rushProductionLeadDays ?? null,
          productionLeadDays: mergedConfiguration.productionLeadDays,
          deliveryMinDays: mergedConfiguration.deliveryMinDays,
          deliveryMaxDays: mergedConfiguration.deliveryMaxDays,
          deliveryScope: String(mergedConfiguration.deliveryScope).trim(),
          revisionPolicy: String(mergedConfiguration.revisionPolicy).trim(),
          returnPolicy: String(mergedConfiguration.returnPolicy).trim(),
          defectPolicy: String(mergedConfiguration.defectPolicy).trim(),
          fabricSourcingMode: mergedConfiguration.fabricSourcingMode,
          isActive: true,
          notes: this.composeConfigurationNotes(
            mergedConfiguration.notes,
            mergedConfiguration.averageBaseYards,
            mergedConfiguration.sizeExtraYards,
          ),
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

      await tx.customOrderConfigurationVersion.create({
        data: {
          configurationId: configuration.id,
          version: nextVersion,
          snapshotJson: this.buildConfigurationSnapshot(configuration, normalizedRules),
          createdById: ownerUserId,
        },
      });

      await this.enableSourceCustomOrdering(
        tx,
        mergedConfiguration.sourceType,
        mergedConfiguration.sourceId,
      );
      return configuration;
    });

    const hydrated = await this.prisma.customOrderConfiguration.findUnique({
      where: { id: updated.id },
      include: {
        brand: { select: { id: true, name: true, ownerId: true } },
        fabricRuleBasis: true,
        rules: { orderBy: { priority: 'asc' } },
        versions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });

    if (!hydrated) {
      throw new NotFoundException('Custom order configuration not found after update');
    }

    return {
      statusCode: 200,
      message: 'Custom order configuration updated',
      data: hydrated,
    };
  }

  async getConfiguration(configurationId: string, authUserId?: string) {
    const configuration = await this.prisma.customOrderConfiguration.findUnique({
      where: { id: configurationId },
      include: {
        brand: { select: { ownerId: true, name: true } },
        fabricRuleBasis: true,
        rules: { orderBy: { priority: 'asc' } },
        versions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });

    if (!configuration) {
      throw new NotFoundException('Custom order configuration not found');
    }

    const isOwner = authUserId === configuration.brand.ownerId;
    if (!configuration.isActive && !isOwner) {
      throw new NotFoundException('Custom order configuration not found');
    }

    const normalizedConfiguration = await this.normalizeLegacyMeasurementContract(configuration);

    return {
      statusCode: 200,
      message: 'Custom order configuration retrieved',
      data: normalizedConfiguration,
    };
  }

  async getActiveConfigurationForSource(
    sourceType: CustomOrderSourceType,
    sourceId: string,
    authUserId?: string,
  ) {
    const brand = authUserId
      ? await this.prisma.brand.findUnique({
          where: { ownerId: authUserId },
          select: { id: true },
        })
      : null;

    const configuration = await this.prisma.customOrderConfiguration.findFirst({
      where: {
        sourceType,
        sourceId,
        OR: brand?.id
          ? [{ isActive: true }, { brandId: brand.id }]
          : [{ isActive: true }],
      },
      include: {
        brand: { select: { ownerId: true, name: true } },
        fabricRuleBasis: true,
        rules: { orderBy: { priority: 'asc' } },
        versions: { orderBy: { version: 'desc' }, take: 1 },
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
    });

    if (!configuration) {
      throw new NotFoundException('Custom order configuration not found');
    }

    const normalizedConfiguration = await this.normalizeLegacyMeasurementContract(configuration);

    return {
      statusCode: 200,
      message: 'Custom order configuration retrieved',
      data: normalizedConfiguration,
    };
  }

  async listVisibleConfigurations(authUserId: string | undefined, query: QueryVisibleCustomOrderConfigurationsDto) {
    const page = query.page ?? 1;
    const take = query.limit ?? 20;
    const brand = authUserId
      ? await this.prisma.brand.findUnique({
          where: { ownerId: authUserId },
          select: { id: true },
        })
      : null;

    const where: Prisma.CustomOrderConfigurationWhereInput = {
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
      this.prisma.customOrderConfiguration.findMany({
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
      this.prisma.customOrderConfiguration.count({ where }),
    ]);

    const visibleItems = brand?.id
      ? items.filter((item) => item.isActive || item.brandId === brand.id)
      : items.filter((item) => item.isActive);
    const normalizedItems = await Promise.all(
      visibleItems.map((item) => this.normalizeLegacyMeasurementContract(item)),
    );

    return {
      statusCode: 200,
      message: 'Custom order configurations retrieved',
      data: {
        items: normalizedItems,
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

  private validateConfigurationGuardrails(
    dto: Pick<
      CreateCustomOrderConfigurationDto,
      | 'rushEnabled'
      | 'rushFee'
      | 'rushProductionLeadDays'
      | 'productionLeadDays'
      | 'deliveryMinDays'
      | 'deliveryMaxDays'
      | 'baseProductionCharge'
      | 'fabricCostPerYard'
      | 'averageBaseYards'
      | 'sizeExtraYards'
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

    if (dto.averageBaseYards != null && Number(dto.averageBaseYards) <= 0) {
      throw new BadRequestException('Average base yards must be greater than zero');
    }

    if (Array.isArray(dto.sizeExtraYards)) {
      const seen = new Set<string>();
      for (const row of dto.sizeExtraYards) {
        const sizeLabel = String((row as any).sizeLabel ?? '').trim().toUpperCase();
        const extraYards = Number((row as any).extraYards);
        if (!sizeLabel) {
          throw new BadRequestException('Each size extra-yard row requires a size label');
        }
        if (!Number.isFinite(extraYards) || extraYards < 0) {
          throw new BadRequestException('Each size extra-yard value must be zero or greater');
        }
        if (seen.has(sizeLabel)) {
          throw new BadRequestException(`Duplicate size extra-yard row for ${sizeLabel}`);
        }
        seen.add(sizeLabel);
      }
    }

    if (!dto.rushEnabled) {
      return;
    }

    if (!dto.rushFee || Number(dto.rushFee) <= 0) {
      throw new BadRequestException('Rush-enabled configurations must define a positive rush fee');
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

  private resolveConfigurationTitle(inputTitle?: string | null, fallbackTitle?: string | null): string {
    const normalizedInput = typeof inputTitle === 'string' ? inputTitle.trim() : '';
    if (normalizedInput.length > 0) {
      return normalizedInput;
    }

    const normalizedFallback = typeof fallbackTitle === 'string' ? fallbackTitle.trim() : '';
    if (normalizedFallback.length > 0) {
      return normalizedFallback;
    }

    return 'Custom order configuration';
  }

  private buildConfigurationSnapshot(
    configuration: {
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
    normalizedRules: ReturnType<CustomOrderPricingService['validateConfigurationRules']>,
  ): Prisma.InputJsonValue {
    return {
      id: configuration.id,
      brandId: configuration.brandId,
      sourceType: configuration.sourceType,
      sourceId: configuration.sourceId,
      title: configuration.title,
      buyerInstructionText: configuration.buyerInstructionText,
      requiredMeasurementKeys: configuration.requiredMeasurementKeys,
      requiredFreeformPointIds: configuration.requiredFreeformPointIds,
      fabricRuleBasisId: configuration.fabricRuleBasisId,
      baseProductionCharge: String(configuration.baseProductionCharge),
      fabricCostPerYard: String(configuration.fabricCostPerYard),
      rushEnabled: configuration.rushEnabled,
      rushFee: configuration.rushFee ? String(configuration.rushFee) : null,
      rushProductionLeadDays: configuration.rushProductionLeadDays,
      productionLeadDays: configuration.productionLeadDays,
      deliveryMinDays: configuration.deliveryMinDays,
      deliveryMaxDays: configuration.deliveryMaxDays,
      deliveryScope: configuration.deliveryScope,
      revisionPolicy: configuration.revisionPolicy,
      returnPolicy: configuration.returnPolicy,
      defectPolicy: configuration.defectPolicy,
      fabricSourcingMode: configuration.fabricSourcingMode,
      notes: configuration.notes,
      rules: normalizedRules.map((rule) => ({
        priority: rule.priority,
        isFallback: rule.isFallback,
        outputYards: rule.outputYards.toFixed(2),
        conditions: rule.conditions,
      })),
    } as unknown as Prisma.InputJsonValue;
  }

  private composeConfigurationNotes(
    notes: string | null | undefined,
    averageBaseYards?: number,
    sizeExtraYards?: CustomOrderConfigurationSizeExtraYardDto[] | Array<{ sizeLabel: string; extraYards: number }>,
  ) {
    const plainNotes = String(notes ?? '').replace(/^YARD_PROFILE:[^\n]*(\n\n)?/i, '').trim();
    const normalizedExtraRows = Array.isArray(sizeExtraYards)
      ? sizeExtraYards
          .map((row) => ({
            sizeLabel: String((row as any).sizeLabel ?? '').trim(),
            extraYards: Number((row as any).extraYards),
          }))
          .filter((row) => row.sizeLabel.length > 0 && Number.isFinite(row.extraYards) && row.extraYards >= 0)
      : [];

    if (averageBaseYards == null && normalizedExtraRows.length === 0) {
      return plainNotes || null;
    }

    const profileJson = JSON.stringify({
      averageBaseYards: averageBaseYards == null ? null : Number(averageBaseYards),
      sizeExtraYards: normalizedExtraRows,
    });

    return plainNotes ? `YARD_PROFILE:${profileJson}\n\n${plainNotes}` : `YARD_PROFILE:${profileJson}`;
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

  private normalizeMeasurementKeyList(keys: string[] | null | undefined) {
    return normalizeMeasurementKeyArray(keys);
  }

  private normalizeIdList(ids: string[] | null | undefined) {
    return normalizeIdArray(ids);
  }

  private async normalizeLegacyMeasurementContract<T extends {
    brandId: string;
    sourceType: CustomOrderSourceType;
    sourceId: string;
    requiredMeasurementKeys: string[];
    requiredFreeformPointIds: string[];
  }>(configuration: T): Promise<T> {
    const normalizedKeys = this.normalizeMeasurementKeyList(configuration.requiredMeasurementKeys);
    const normalizedFreeformPointIds = this.normalizeIdList(configuration.requiredFreeformPointIds);

    if (normalizedKeys.length === 0) {
      return {
        ...configuration,
        requiredMeasurementKeys: normalizedKeys,
        requiredFreeformPointIds: normalizedFreeformPointIds,
      };
    }

    const sourceContract = await this.loadSourceMeasurementContract(
      configuration.sourceType,
      configuration.sourceId,
    );
    const sourceMeasurementKeys = this.normalizeMeasurementKeyList(
      sourceContract.customMeasurementKeys,
    );
    const sourceGenderHint = resolveSourceMeasurementGender({
      sourceType: configuration.sourceType,
      categoryTypeSlug: sourceContract.categoryTypeSlug,
      collectionType: sourceContract.collectionType,
      customGender: sourceContract.customGender ?? null,
    });

    const sourceProvidesASmallerSubset =
      sourceMeasurementKeys.length > 0 &&
      sourceMeasurementKeys.length < normalizedKeys.length &&
      sourceMeasurementKeys.every((key) => normalizedKeys.includes(key));

    if (sourceProvidesASmallerSubset) {
      return {
        ...configuration,
        requiredMeasurementKeys: sourceMeasurementKeys,
        requiredFreeformPointIds: normalizedFreeformPointIds,
      };
    }

    const registryKeys = await this.loadMeasurementPoolKeys(
      configuration.brandId,
      sourceGenderHint ?? sourceContract.customGender ?? null,
    );
    const LEGACY_REGISTRY_WIDTH_THRESHOLD = 8;
    const looksLikeRegistryWideLegacySelection =
      registryKeys.length >= LEGACY_REGISTRY_WIDTH_THRESHOLD &&
      registryKeys.every((key) => normalizedKeys.includes(key));
    const sourceLooksLikeRegistryWideLegacySelection =
      registryKeys.length >= LEGACY_REGISTRY_WIDTH_THRESHOLD &&
      registryKeys.every((key) => sourceMeasurementKeys.includes(key));
    const templateMeasurementKeys = resolveGarmentMeasurementTemplate(
      {
        sourceType: configuration.sourceType,
        categoryTypeSlug: sourceContract.categoryTypeSlug,
        collectionType: sourceContract.collectionType,
        customGender: sourceContract.customGender ?? null,
      },
      registryKeys,
    );
    const configurationContainsOppositeGenderKeys =
      sourceGenderHint != null &&
      measurementKeysContainOppositeGender(normalizedKeys, sourceGenderHint);
    const sourceContainsOppositeGenderKeys =
      sourceGenderHint != null &&
      measurementKeysContainOppositeGender(sourceMeasurementKeys, sourceGenderHint);

    if (
      templateMeasurementKeys.length > 0 &&
      templateMeasurementKeys.length < normalizedKeys.length &&
      (
        looksLikeRegistryWideLegacySelection ||
        sourceLooksLikeRegistryWideLegacySelection ||
        configurationContainsOppositeGenderKeys ||
        sourceContainsOppositeGenderKeys
      )
    ) {
      return {
        ...configuration,
        requiredMeasurementKeys: templateMeasurementKeys,
        requiredFreeformPointIds: normalizedFreeformPointIds,
      };
    }

    return {
      ...configuration,
      requiredMeasurementKeys: normalizedKeys,
      requiredFreeformPointIds: normalizedFreeformPointIds,
    };
  }

  private async loadSourceMeasurementContract(
    sourceType: CustomOrderSourceType,
    sourceId: string,
  ) {
    if (sourceType === CustomOrderSourceType.PRODUCT) {
      const product = await this.prisma.product.findUnique({
        where: { id: sourceId },
        select: {
          customMeasurementKeys: true,
          customFreeformPointIds: true,
          customGender: true,
          gender: true,
          categoryType: {
            select: { slug: true },
          },
        },
      });

      if (!product) {
        throw new NotFoundException('Product source was not found for this configuration');
      }

      return {
        customMeasurementKeys: product.customMeasurementKeys,
        customFreeformPointIds: product.customFreeformPointIds,
        customGender: product.customGender,
        categoryTypeSlug: product.categoryType?.slug ?? null,
        collectionType: product.gender,
      };
    }

    const design = await this.prisma.collection.findUnique({
      where: { id: sourceId },
      select: {
        customMeasurementKeys: true,
        customFreeformPointIds: true,
        customGender: true,
        type: true,
        categoryType: {
          select: { slug: true },
        },
      },
    });

    if (!design) {
      throw new NotFoundException('Design source was not found for this configuration');
    }

    return {
      customMeasurementKeys: design.customMeasurementKeys,
      customFreeformPointIds: design.customFreeformPointIds,
      customGender: design.customGender,
      categoryTypeSlug: design.categoryType?.slug ?? null,
      collectionType: design.type,
    };
  }

  private async loadMeasurementPoolKeys(brandId: string, gender: Gender | null) {
    const points = await this.prisma.measurementPoint.findMany({
      where: {
        isActive: true,
        OR: [
          {
            source: MeasurementPointSource.SYSTEM,
            status: 'APPROVED_GLOBAL',
          },
          {
            source: MeasurementPointSource.BRAND_FREEFORM,
            brandId,
          },
        ],
        ...(gender && gender !== 'UNISEX'
          ? {
              AND: [
                {
                  OR: [{ gender }, { gender: 'UNISEX' }, { gender: null }],
                },
              ],
            }
          : {}),
      },
      select: { key: true },
    });

    return this.normalizeMeasurementKeyList(points.map((point) => point.key));
  }

  private async deactivateSiblingConfigurations(
    tx: Prisma.TransactionClient,
    sourceType: CustomOrderSourceType,
    sourceId: string,
    keepConfigurationId?: string,
  ) {
    await tx.customOrderConfiguration.updateMany({
      where: {
        sourceType,
        sourceId,
        ...(keepConfigurationId
          ? { id: { not: keepConfigurationId } }
          : {}),
        isActive: true,
      },
      data: { isActive: false },
    });
  }
}
