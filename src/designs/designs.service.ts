import { BadRequestException, Injectable } from '@nestjs/common';
import { CustomOrderSourceType } from '@prisma/client';
import { validate as isUuid } from 'uuid';

import { CollectionsService } from 'src/collections/collections.service';
import { CustomOrderConfigurationsService } from 'src/custom-order-configurations/custom-order-configurations.service';
import { LegacyCollectionDesignAdapter } from './adapters/legacy-collection-design.adapter';
import { FinalizeDesignUploadDto } from './dto/finalize-design-upload.dto';
import {
  InitializeDesignMediaUploadDto,
  InitializeDesignUploadDto,
} from './dto/initialize-design-upload.dto';
import { UpdateDesignDto } from './dto/update-design.dto';
import { DesignResponseMapper } from './mappers/design-response.mapper';

/**
 * Design write/read facade.
 *
 * Designs are persisted as `Collection(domain = DESIGN)` rows and a design's
 * public id IS its collection id. This service exposes design-language
 * endpoints and delegates persistence to {@link CollectionsService} with
 * `scope: 'design'`, translating design-shaped DTOs through
 * {@link LegacyCollectionDesignAdapter}.
 *
 * The former `DESIGN_DOMAIN_WRITE_MODE` flag, the dual-write mirror sync, and
 * the standalone `Design` read-shadow have been removed — designs read and
 * write the collection store directly (see the design↔collection decoupling
 * boundary pass).
 */
@Injectable()
export class DesignsService {
  constructor(
    private readonly collectionsService: CollectionsService,
    private readonly customOrderConfigurationsService: CustomOrderConfigurationsService,
    private readonly legacyAdapter: LegacyCollectionDesignAdapter,
  ) {}

  private assertPersistedDesignId(designId: string) {
    if (!isUuid(designId)) {
      throw new BadRequestException('Invalid design id');
    }
  }

  async initializeDesignUpload(userId: string, dto: InitializeDesignUploadDto) {
    await this.collectionsService.assertDesignCreationAllowed(userId);
    const result = await this.collectionsService.initializeCollection(
      userId,
      this.legacyAdapter.toLegacyInitializePayload(dto),
    );
    return this.legacyAdapter.fromLegacyInitializeResponse(result);
  }

  async finalizeDesignUpload(
    designId: string,
    userId: string,
    dto: FinalizeDesignUploadDto,
  ) {
    this.assertPersistedDesignId(designId);
    const result = await this.collectionsService.finalizeCollection(
      designId,
      userId,
      this.legacyAdapter.toLegacyFinalizePayload(dto),
      'design',
    );
    return DesignResponseMapper.fromLegacyCollection(result);
  }

  async getDesignDetail(designId: string, requesterId?: string) {
    this.assertPersistedDesignId(designId);
    const result = await this.collectionsService.getCollection(
      designId,
      requesterId,
      'design',
    );
    return DesignResponseMapper.fromLegacyCollection(result);
  }

  async updateDesign(designId: string, userId: string, dto: UpdateDesignDto) {
    this.assertPersistedDesignId(designId);
    const result = await this.collectionsService.updateCollection(
      designId,
      userId,
      this.legacyAdapter.toLegacyUpdatePayload(dto),
      'design',
    );
    return DesignResponseMapper.fromLegacyCollection(result);
  }

  async deleteDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    return this.collectionsService.deleteCollection(designId, userId, 'design');
  }

  async archiveDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    return this.collectionsService.archiveCollection(designId, userId, 'design');
  }

  async unarchiveDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    return this.collectionsService.unarchiveCollection(
      designId,
      userId,
      'design',
    );
  }

  async restoreDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    return this.collectionsService.restoreCollection(designId, userId);
  }

  async permanentlyDeleteDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    return this.collectionsService.permanentlyDeleteCollection(
      designId,
      userId,
      'design',
    );
  }

  async duplicateDesign(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    const result = await this.collectionsService.duplicateCollection(
      designId,
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
    const result = await this.collectionsService.checkDraftConflict(
      designId,
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
    const result =
      await this.collectionsService.initializeCollectionMediaUploads(
        designId,
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
    return this.collectionsService.reorderCollectionMedia(
      designId,
      userId,
      items,
      'design',
    );
  }

  async deleteDesignMedia(designId: string, mediaId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    return this.collectionsService.deleteCollectionMedia(
      designId,
      mediaId,
      userId,
    );
  }

  async submitDesignForReview(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    const result = await this.collectionsService.submitDesignForReview(
      designId,
      userId,
    );
    return {
      ...result,
      designId: result.designId ?? designId,
      collectionId: designId,
    };
  }

  async withdrawDesignFromReview(designId: string, userId: string) {
    this.assertPersistedDesignId(designId);
    const result = await this.collectionsService.withdrawDesignFromReview(
      designId,
      userId,
    );
    return {
      ...result,
      designId: result.designId ?? designId,
      collectionId: designId,
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
    return this.collectionsService.reportDesignPublishFailure(
      designId,
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
    return this.customOrderConfigurationsService.getActiveConfigurationForSource(
      CustomOrderSourceType.DESIGN,
      designId,
      requesterId,
    );
  }
}
