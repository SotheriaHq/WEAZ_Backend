import { Injectable } from '@nestjs/common';

import {
  CreateCollectionDto,
  FinalizeCollectionDto,
} from 'src/collections/dto/create-collection.dto';
import { UpdateCollectionDto } from 'src/collections/dto/update-collection.dto';
import { DesignMetadataDto } from '../dto/design-metadata.dto';
import { FinalizeDesignUploadDto } from '../dto/finalize-design-upload.dto';
import { InitializeDesignUploadDto } from '../dto/initialize-design-upload.dto';
import { UpdateDesignDto } from '../dto/update-design.dto';
import { DesignResponseMapper } from '../mappers/design-response.mapper';

@Injectable()
export class LegacyCollectionDesignAdapter {
  toLegacyInitializePayload(dto: InitializeDesignUploadDto): CreateCollectionDto {
    const categoryTypeId = this.resolveCategoryTypeId(dto);
    return {
      ...dto,
      type: dto.type ?? dto.audience,
      categoryTypeId,
      subCategoryId: dto.subCategoryId ?? categoryTypeId,
      isAvailableInStore: false,
      mode: undefined,
    } as CreateCollectionDto;
  }

  toLegacyFinalizePayload(dto: FinalizeDesignUploadDto): FinalizeCollectionDto {
    const metadata = dto.designMetadata ?? dto.collectionMetadata;

    return {
      completions: dto.completions as any,
      shouldPublish: dto.shouldPublish,
      action: dto.action,
      coverMediaId: dto.coverMediaId,
      coverIndex: dto.coverIndex,
      draftSessionToken: dto.draftSessionToken,
      draftVersion: dto.draftVersion,
      collectionMetadata: metadata
        ? this.toLegacyMetadataPayload(metadata)
        : undefined,
    } as FinalizeCollectionDto;
  }

  toLegacyUpdatePayload(dto: UpdateDesignDto): UpdateCollectionDto {
    return this.toLegacyMetadataPayload(dto) as UpdateCollectionDto;
  }

  toLegacyMetadataPayload(dto: DesignMetadataDto): Record<string, unknown> {
    const categoryTypeId = this.resolveCategoryTypeId(dto);
    return {
      ...dto,
      type: dto.type ?? dto.audience,
      categoryTypeId,
      subCategoryId: dto.subCategoryId ?? categoryTypeId,
      isAvailableInStore: false,
    };
  }

  fromLegacyInitializeResponse(response: any): any {
    if (!response) return response;
    const legacyCollectionId = response.legacyCollectionId ?? response.collectionId;
    return {
      ...response,
      designId: response.designId ?? legacyCollectionId,
      id: response.id ?? response.designId ?? legacyCollectionId,
      legacyCollectionId,
      collectionId: legacyCollectionId,
    };
  }

  fromLegacyDraftSessionResponse(response: any): any {
    if (!response) return response;
    const legacyCollectionId = response.legacyCollectionId ?? response.collectionId;
    return {
      ...response,
      designId: response.designId ?? legacyCollectionId,
      legacyCollectionId,
      collectionId: legacyCollectionId,
    };
  }

  fromLegacyDesignResponse(response: any): any {
    return DesignResponseMapper.fromLegacyCollection(response);
  }

  private resolveCategoryTypeId(dto: {
    categoryTypeId?: string | null;
    subCategoryId?: string | null;
  }) {
    return dto.categoryTypeId ?? dto.subCategoryId ?? undefined;
  }
}
