import { CustomOrderSourceType, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderPricingService } from 'src/custom-order-pricing/custom-order-pricing.service';
import { CreateCustomFabricRuleBasisDto, CreateCustomOrderConfigurationDto, QueryCustomFabricRuleBasesDto, QueryVisibleCustomOrderConfigurationsDto, UpdateCustomOrderConfigurationDto } from './dto/custom-order-configurations.dto';
export declare class CustomOrderConfigurationsService {
    private readonly prisma;
    private readonly pricingService;
    constructor(prisma: PrismaService, pricingService: CustomOrderPricingService);
    createConfiguration(ownerUserId: string, dto: CreateCustomOrderConfigurationDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            brand: {
                id: string;
                name: string;
                ownerId: string;
            };
            fabricRuleBasis: {
                label: string;
                id: string;
                createdAt: Date;
                updatedAt: Date;
                status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
                brandId: string | null;
                source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
                reviewedById: string | null;
                reviewedAt: Date | null;
                measurementKeys: string[];
                moderationNotes: string | null;
            };
            versions: {
                id: string;
                createdAt: Date;
                version: number;
                configurationId: string;
                createdById: string;
                snapshotJson: Prisma.JsonValue;
            }[];
            rules: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                configurationId: string;
                priority: number;
                conditionsJson: Prisma.JsonValue;
                outputYards: Prisma.Decimal;
                isFallback: boolean;
            }[];
        } & {
            id: string;
            isActive: boolean;
            createdAt: Date;
            updatedAt: Date;
            title: string;
            notes: string | null;
            brandId: string;
            sourceType: import("@prisma/client").$Enums.CustomOrderSourceType;
            sourceId: string;
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
            fabricSourcingMode: import("@prisma/client").$Enums.FabricSourcingMode;
            currentVersion: number;
        };
    }>;
    updateConfiguration(ownerUserId: string, configurationId: string, dto: UpdateCustomOrderConfigurationDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            brand: {
                id: string;
                name: string;
                ownerId: string;
            };
            fabricRuleBasis: {
                label: string;
                id: string;
                createdAt: Date;
                updatedAt: Date;
                status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
                brandId: string | null;
                source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
                reviewedById: string | null;
                reviewedAt: Date | null;
                measurementKeys: string[];
                moderationNotes: string | null;
            };
            versions: {
                id: string;
                createdAt: Date;
                version: number;
                configurationId: string;
                createdById: string;
                snapshotJson: Prisma.JsonValue;
            }[];
            rules: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                configurationId: string;
                priority: number;
                conditionsJson: Prisma.JsonValue;
                outputYards: Prisma.Decimal;
                isFallback: boolean;
            }[];
        } & {
            id: string;
            isActive: boolean;
            createdAt: Date;
            updatedAt: Date;
            title: string;
            notes: string | null;
            brandId: string;
            sourceType: import("@prisma/client").$Enums.CustomOrderSourceType;
            sourceId: string;
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
            fabricSourcingMode: import("@prisma/client").$Enums.FabricSourcingMode;
            currentVersion: number;
        };
    }>;
    getConfiguration(configurationId: string, authUserId?: string): Promise<{
        statusCode: number;
        message: string;
        data: {
            brand: {
                name: string;
                ownerId: string;
            };
            fabricRuleBasis: {
                label: string;
                id: string;
                createdAt: Date;
                updatedAt: Date;
                status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
                brandId: string | null;
                source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
                reviewedById: string | null;
                reviewedAt: Date | null;
                measurementKeys: string[];
                moderationNotes: string | null;
            };
            versions: {
                id: string;
                createdAt: Date;
                version: number;
                configurationId: string;
                createdById: string;
                snapshotJson: Prisma.JsonValue;
            }[];
            rules: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                configurationId: string;
                priority: number;
                conditionsJson: Prisma.JsonValue;
                outputYards: Prisma.Decimal;
                isFallback: boolean;
            }[];
        } & {
            id: string;
            isActive: boolean;
            createdAt: Date;
            updatedAt: Date;
            title: string;
            notes: string | null;
            brandId: string;
            sourceType: import("@prisma/client").$Enums.CustomOrderSourceType;
            sourceId: string;
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
            fabricSourcingMode: import("@prisma/client").$Enums.FabricSourcingMode;
            currentVersion: number;
        };
    }>;
    getActiveConfigurationForSource(sourceType: CustomOrderSourceType, sourceId: string, authUserId?: string): Promise<{
        statusCode: number;
        message: string;
        data: {
            brand: {
                name: string;
                ownerId: string;
            };
            fabricRuleBasis: {
                label: string;
                id: string;
                createdAt: Date;
                updatedAt: Date;
                status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
                brandId: string | null;
                source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
                reviewedById: string | null;
                reviewedAt: Date | null;
                measurementKeys: string[];
                moderationNotes: string | null;
            };
            versions: {
                id: string;
                createdAt: Date;
                version: number;
                configurationId: string;
                createdById: string;
                snapshotJson: Prisma.JsonValue;
            }[];
            rules: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                configurationId: string;
                priority: number;
                conditionsJson: Prisma.JsonValue;
                outputYards: Prisma.Decimal;
                isFallback: boolean;
            }[];
        } & {
            id: string;
            isActive: boolean;
            createdAt: Date;
            updatedAt: Date;
            title: string;
            notes: string | null;
            brandId: string;
            sourceType: import("@prisma/client").$Enums.CustomOrderSourceType;
            sourceId: string;
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
            fabricSourcingMode: import("@prisma/client").$Enums.FabricSourcingMode;
            currentVersion: number;
        };
    }>;
    listVisibleConfigurations(authUserId: string | undefined, query: QueryVisibleCustomOrderConfigurationsDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            items: ({
                brand: {
                    id: string;
                    name: string;
                    ownerId: string;
                };
                fabricRuleBasis: {
                    label: string;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
                    brandId: string | null;
                    source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
                    reviewedById: string | null;
                    reviewedAt: Date | null;
                    measurementKeys: string[];
                    moderationNotes: string | null;
                };
                versions: {
                    id: string;
                    createdAt: Date;
                    version: number;
                    configurationId: string;
                    createdById: string;
                    snapshotJson: Prisma.JsonValue;
                }[];
                rules: {
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    configurationId: string;
                    priority: number;
                    conditionsJson: Prisma.JsonValue;
                    outputYards: Prisma.Decimal;
                    isFallback: boolean;
                }[];
            } & {
                id: string;
                isActive: boolean;
                createdAt: Date;
                updatedAt: Date;
                title: string;
                notes: string | null;
                brandId: string;
                sourceType: import("@prisma/client").$Enums.CustomOrderSourceType;
                sourceId: string;
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
                fabricSourcingMode: import("@prisma/client").$Enums.FabricSourcingMode;
                currentVersion: number;
            })[];
            page: number;
            limit: number;
            total: number;
        };
    }>;
    createBasis(ownerUserId: string, dto: CreateCustomFabricRuleBasisDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            label: string;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
            brandId: string | null;
            source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
            reviewedById: string | null;
            reviewedAt: Date | null;
            measurementKeys: string[];
            moderationNotes: string | null;
        };
    }>;
    listBases(authUserId: string | undefined, query: QueryCustomFabricRuleBasesDto): Promise<{
        statusCode: number;
        message: string;
        data: {
            label: string;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            status: import("@prisma/client").$Enums.CustomFabricRuleBasisStatus;
            brandId: string | null;
            source: import("@prisma/client").$Enums.CustomFabricRuleBasisSource;
            reviewedById: string | null;
            reviewedAt: Date | null;
            measurementKeys: string[];
            moderationNotes: string | null;
        }[];
    }>;
    private resolveBrand;
    private assertSourceOwnership;
    private assertBasisAccessible;
    private assertFreeformPointsAccessible;
    private validateConfigurationGuardrails;
    private resolveConfigurationTitle;
    private buildConfigurationSnapshot;
    private composeConfigurationNotes;
    private enableSourceCustomOrdering;
}
