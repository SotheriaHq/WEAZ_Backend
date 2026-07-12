import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { CustomOrderSourceType } from '@prisma/client';
import { validate as isUuid } from 'uuid';

import { CollectionsService } from 'src/collections/collections.service';
import { CustomOrderConfigurationsService } from 'src/custom-order-configurations/custom-order-configurations.service';
import { LegacyCollectionDesignAdapter } from './adapters/legacy-collection-design.adapter';
import { getDesignDomainWriteMode } from './design-domain-write-mode';
import { DesignResolverService } from './design-resolver.service';
import { FinalizeDesignUploadDto } from './dto/finalize-design-upload.dto';
import {
  InitializeDesignMediaUploadDto,
  InitializeDesignUploadDto,
} from './dto/initialize-design-upload.dto';
import { UpdateDesignDto } from './dto/update-design.dto';
import { DesignResponseMapper } from './mappers/design-response.mapper';

@Injectable()
export class DesignsService {
  private readonly logger = new Logger(DesignsService.name);

  constructor(
    private readonly collectionsService: CollectionsService,
    private readonly customOrderConfigurationsService: CustomOrderConfigurationsService,
    private readonly legacyAdapter: LegacyCollectionDesignAdapter,
    private readonly designResolver: DesignResolverService,
  ) {}

  private assertDesignOnlyWriteModeNotEnabled() {
    if (getDesignDomainWriteMode() === 'design') {
      throw new InternalServerErrorException(
        'DESIGN_DOMAIN_WRITE_MODE=design is guarded until design backfill verification passes.',
      );
    }
  }

  private assertPersistedDesignId(designId: string) {
    if (!isUuid(designId)) {
      throw new BadRequestException('Invalid design id');
    }
  }

  private async resolveLegacyCollectionIdForApi(designId: string): Promise<string> {
    const legacyId = await this.designResolver.resolveLegacyCollectionId(designId);
    return legacyId ?? designId;
  }

  private async syncExplicitDesignIfDual(legacyCollectionId: string) {
    if (getDesignDomainWriteMode() !== 'dual') return;
    const synced =
      await this.designResolver.trySyncFromLegacyCollection(legacyCollectionId);
    if (!synced) {
      this.logger.warn(
        `Continuing legacy design write after failed explicit Design sync for ${legacyCollectionId}`,
      );
    }
  }

  async initializeDesignUpload(userId: string, dto: InitializeDesignUploadDto) {
    this.assertDesignOnlyWriteModeNotEnabled();
    await this.collectionsService.assertDesignCreationAllowed(userId);
    const result = await this.collectionsService.initializeCollection(
      userId,
      this.legacyAdapter.toLegacyInitializePayload(dto),
    );
    const resultAny = result as any;
    const legacyCollectionId =
      resultAny?.collectionId ?? resultAny?.legacyCollectionId;
    if (legacyCollectionId) {
      await this.syncExplicitDesignIfDual(legacyCollectionId);
    }
    return this.legacyAdapter.fromLegacyInitializeResponse(result);
  }

  async finalizeDesignUpload(
    designId: string,
    userId: string,
    dto: FinalizeDesignUploadDto,
  ) {
    this.assertPersistedDesignId(designId);
    this.assertDesignOnlyWriteModeNotEnabled();
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    const result = await this.collectionsService.finalizeCollection(
      legacyCollectionId,
      userId,
      this.legacyAdapter.toLegacyFinalizePayload(dto),
      'design',
    );
    const resultAny = result as any;
    const syncedLegacyId =
      resultAny?.legacyCollectionId ??
      resultAny?.collectionId ??
      resultAny?.id ??
      legacyCollectionId;
    if (syncedLegacyId) {
      await this.syncExplicitDesignIfDual(syncedLegacyId);
    }
    return DesignResponseMapper.fromLegacyCollection(result);
  }

  async getDesignDetail(designId: string, requesterId?: string) {
    this.assertPersistedDesignId(designId);
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);

    try {
      const result = await this.collectionsService.getCollection(
        legacyCollectionId,
        requesterId,
        'design',
      );
      const mapped = DesignResponseMapper.fromLegacyCollection(result) as unknown as Record<
        string,
        unknown
      >;
      const explicit = await this.designResolver.resolveExplicitDesign(
        designId,
        requesterId,
      );
      if (explicit?.id && explicit.id !== legacyCollectionId) {
        mapped.id = explicit.id;
        mapped.designId = explicit.id;
        mapped.legacyCollectionId = legacyCollectionId;
      }
      return mapped;
    } catch (error) {
      const explicit = await this.designResolver.resolveExplicitDesign(
        designId,
        requesterId,
      );
      if (explicit) return explicit;
      throw error;
    }
  }

  async updateDesign(designId: string, userId: string, dto: UpdateDesignDto) {
    this.assertPersistedDesignId(designId);
    this.assertDesignOnlyWriteModeNotEnabled();
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    const result = await this.collectionsService.updateCollection(
      legacyCollectionId,
      userId,
      this.legacyAdapter.toLegacyUpdatePayload(dto),
      'design',
    );
    const resultAny = result as any;
    const syncedLegacyId =
      resultAny?.legacyCollectionId ??
      resultAny?.collectionId ??
      resultAny?.id ??
      legacyCollectionId;
    if (syncedLegacyId) {
      await this.syncExplicitDesignIfDual(syncedLegacyId);
    }
    return DesignResponseMapper.fromLegacyCollection(result);
  }

  async deleteDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    return this.collectionsService.deleteCollection(
      legacyCollectionId,
      userId,
      'design',
    );
  }

  async archiveDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    return this.collectionsService.archiveCollection(
      legacyCollectionId,
      userId,
      'design',
    );
  }

  async unarchiveDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    return this.collectionsService.unarchiveCollection(
      legacyCollectionId,
      userId,
      'design',
    );
  }

  async restoreDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    return this.collectionsService.restoreCollection(legacyCollectionId, userId);
  }

  async permanentlyDeleteDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    return this.collectionsService.permanentlyDeleteCollection(
      legacyCollectionId,
      userId,
      'design',
    );
  }

  async duplicateDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    const result = await this.collectionsService.duplicateCollection(
      legacyCollectionId,
      userId,
      'design',
    );
    return DesignResponseMapper.fromLegacyCollection(result);
  }

  async startDesignDraftSession(
    designId: string,
    userId: string,
    body: { deviceName?: string; forceNew?: boolean; existingToken?: string },
  ) {
    this.assertPersistedDesignId(designId);
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    const result = await this.collectionsService.checkDraftConflict(
      legacyCollectionId,
      userId,
      body?.deviceName,
      body?.forceNew,
      body?.existingToken,
    );
    return this.legacyAdapter.fromLegacyDraftSessionResponse(result);
  }

  async initializeDesignMediaUpload(
    designId: string,
    userId: string,
    dto: InitializeDesignMediaUploadDto,
  ) {
    this.assertPersistedDesignId(designId);
    this.assertDesignOnlyWriteModeNotEnabled();
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    const result =
      await this.collectionsService.initializeCollectionMediaUploads(
        legacyCollectionId,
        userId,
        dto.files,
        'design',
      );
    return this.legacyAdapter.fromLegacyInitializeResponse(result);
  }

  async reorderDesignMedia(
    designId: string,
    userId: string,
    items: Array<{ mediaId: string; orderIndex: number }>,
  ) {
    this.assertPersistedDesignId(designId);
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    return this.collectionsService.reorderCollectionMedia(
      legacyCollectionId,
      userId,
      items,
      'design',
    );
  }

  async deleteDesignMedia(designId: string, mediaId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    return this.collectionsService.deleteCollectionMedia(
      legacyCollectionId,
      mediaId,
      userId,
    );
  }

  async submitDesignForReview(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    this.assertDesignOnlyWriteModeNotEnabled();
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    const result = await this.collectionsService.submitDesignForReview(
      legacyCollectionId,
      userId,
    );
    await this.syncExplicitDesignIfDual(legacyCollectionId);
    const explicit = await this.designResolver.resolveExplicitDesign(designId, userId);
    return {
      ...result,
      designId: explicit?.id ?? result.designId ?? legacyCollectionId,
      collectionId: legacyCollectionId,
    };
  }

  async withdrawDesignFromReview(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    this.assertDesignOnlyWriteModeNotEnabled();
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    const result = await this.collectionsService.withdrawDesignFromReview(
      legacyCollectionId,
      userId,
    );
    await this.syncExplicitDesignIfDual(legacyCollectionId);
    const explicit = await this.designResolver.resolveExplicitDesign(designId, userId);
    return {
      ...result,
      designId: explicit?.id ?? result.designId ?? legacyCollectionId,
      collectionId: legacyCollectionId,
    };
  }

  async reportDesignPublishFailure(
    designId: string,
    userId: string,
    dto: {
      title?: string;
      reason?: string;
      stage?: 'initialize' | 'upload' | 'finalize';
    },
  ) {
    this.assertPersistedDesignId(designId);
    const legacyCollectionId = await this.resolveLegacyCollectionIdForApi(designId);
    return this.collectionsService.reportDesignPublishFailure(
      legacyCollectionId,
      userId,
      dto,
    );
  }

  async getMyDraftDesigns(userId: string) {
    const result = await this.collectionsService.getMyDraftCollections(userId);
    return DesignResponseMapper.fromLegacyCollectionList(result);
  }

  async getUserDesigns(
    userId: string,
    requesterId: string | undefined,
    options: {
      cursor?: string;
      limit?: number;
      visibility?: 'public' | 'private' | 'all';
      includeDeleted?: boolean;
      onlyDeleted?: boolean;
    },
  ) {
    const result = await this.collectionsService.getUserCollections(
      userId,
      requesterId,
      { ...options, scope: 'design' },
    );
    return DesignResponseMapper.fromLegacyCollectionList(result);
  }

  async submitDesignCustomFitInquiry(
    designId: string,
    userId: string,
    body: {
      productId?: string;
      message: string;
      measurements?: string;
      preferredSize?: string;
    },
  ) {
    this.assertPersistedDesignId(designId);
    return this.collectionsService.submitCustomFitInquiry(
      designId,
      userId,
      body,
    );
  }

  async getDesignCustomOrderConfiguration(
    designId: string,
    requesterId?: string,
  ) {
    this.assertPersistedDesignId(designId);
    try {
      return await this.customOrderConfigurationsService.getActiveConfigurationForSource(
        CustomOrderSourceType.DESIGN,
        designId,
        requesterId,
      );
    } catch (error) {
      const legacyCollectionId =
        await this.designResolver.resolveLegacyCollectionId(designId);
      if (!legacyCollectionId || legacyCollectionId === designId) {
        throw error;
      }
      return this.customOrderConfigurationsService.getActiveConfigurationForSource(
        CustomOrderSourceType.DESIGN,
        legacyCollectionId,
        requesterId,
      );
    }
  }
}
