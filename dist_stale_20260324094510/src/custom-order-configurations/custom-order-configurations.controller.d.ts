import { Request } from 'express';
import { CustomOrderConfigurationsService } from './custom-order-configurations.service';
import { CreateCustomFabricRuleBasisDto, CreateCustomOrderConfigurationDto, QueryCustomFabricRuleBasesDto, QueryVisibleCustomOrderConfigurationsDto, UpdateCustomOrderConfigurationDto } from './dto/custom-order-configurations.dto';
export declare class CustomOrderConfigurationsController {
    private readonly service;
    constructor(service: CustomOrderConfigurationsService);
    getActiveProductConfiguration(productId: string, req: Request & {
        user?: {
            id?: string;
        };
    }): Promise<{
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
                snapshotJson: import("@prisma/client/runtime/client").JsonValue;
            }[];
            rules: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                configurationId: string;
                priority: number;
                conditionsJson: import("@prisma/client/runtime/client").JsonValue;
                outputYards: import("@prisma/client-runtime-utils").Decimal;
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
            baseProductionCharge: import("@prisma/client-runtime-utils").Decimal;
            fabricCostPerYard: import("@prisma/client-runtime-utils").Decimal;
            rushEnabled: boolean;
            rushFee: import("@prisma/client-runtime-utils").Decimal | null;
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
    getActiveDesignConfiguration(designId: string, req: Request & {
        user?: {
            id?: string;
        };
    }): Promise<{
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
                snapshotJson: import("@prisma/client/runtime/client").JsonValue;
            }[];
            rules: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                configurationId: string;
                priority: number;
                conditionsJson: import("@prisma/client/runtime/client").JsonValue;
                outputYards: import("@prisma/client-runtime-utils").Decimal;
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
            baseProductionCharge: import("@prisma/client-runtime-utils").Decimal;
            fabricCostPerYard: import("@prisma/client-runtime-utils").Decimal;
            rushEnabled: boolean;
            rushFee: import("@prisma/client-runtime-utils").Decimal | null;
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
    listVisibleConfigurations(req: Request & {
        user?: {
            id?: string;
        };
    }, query: QueryVisibleCustomOrderConfigurationsDto): Promise<{
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
                    snapshotJson: import("@prisma/client/runtime/client").JsonValue;
                }[];
                rules: {
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    configurationId: string;
                    priority: number;
                    conditionsJson: import("@prisma/client/runtime/client").JsonValue;
                    outputYards: import("@prisma/client-runtime-utils").Decimal;
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
                baseProductionCharge: import("@prisma/client-runtime-utils").Decimal;
                fabricCostPerYard: import("@prisma/client-runtime-utils").Decimal;
                rushEnabled: boolean;
                rushFee: import("@prisma/client-runtime-utils").Decimal | null;
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
    createConfiguration(req: Request & {
        user: {
            id: string;
        };
    }, dto: CreateCustomOrderConfigurationDto): Promise<{
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
                snapshotJson: import("@prisma/client/runtime/client").JsonValue;
            }[];
            rules: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                configurationId: string;
                priority: number;
                conditionsJson: import("@prisma/client/runtime/client").JsonValue;
                outputYards: import("@prisma/client-runtime-utils").Decimal;
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
            baseProductionCharge: import("@prisma/client-runtime-utils").Decimal;
            fabricCostPerYard: import("@prisma/client-runtime-utils").Decimal;
            rushEnabled: boolean;
            rushFee: import("@prisma/client-runtime-utils").Decimal | null;
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
    updateConfiguration(id: string, req: Request & {
        user: {
            id: string;
        };
    }, dto: UpdateCustomOrderConfigurationDto): Promise<{
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
                snapshotJson: import("@prisma/client/runtime/client").JsonValue;
            }[];
            rules: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                configurationId: string;
                priority: number;
                conditionsJson: import("@prisma/client/runtime/client").JsonValue;
                outputYards: import("@prisma/client-runtime-utils").Decimal;
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
            baseProductionCharge: import("@prisma/client-runtime-utils").Decimal;
            fabricCostPerYard: import("@prisma/client-runtime-utils").Decimal;
            rushEnabled: boolean;
            rushFee: import("@prisma/client-runtime-utils").Decimal | null;
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
    getConfiguration(id: string, req: Request & {
        user?: {
            id?: string;
        };
    }): Promise<{
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
                snapshotJson: import("@prisma/client/runtime/client").JsonValue;
            }[];
            rules: {
                id: string;
                createdAt: Date;
                updatedAt: Date;
                configurationId: string;
                priority: number;
                conditionsJson: import("@prisma/client/runtime/client").JsonValue;
                outputYards: import("@prisma/client-runtime-utils").Decimal;
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
            baseProductionCharge: import("@prisma/client-runtime-utils").Decimal;
            fabricCostPerYard: import("@prisma/client-runtime-utils").Decimal;
            rushEnabled: boolean;
            rushFee: import("@prisma/client-runtime-utils").Decimal | null;
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
    createBasis(req: Request & {
        user: {
            id: string;
        };
    }, dto: CreateCustomFabricRuleBasisDto): Promise<{
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
    listBases(req: Request & {
        user?: {
            id?: string;
        };
    }, query: QueryCustomFabricRuleBasesDto): Promise<{
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
}
