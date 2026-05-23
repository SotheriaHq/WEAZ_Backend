import { DesignResponseDto } from '../dto/design-response.dto';

export class DesignResponseMapper {
  private static sanitizePrivateMedia(media: any): any {
    const file = media?.file;
    if (!file || file.isPublic !== false) return media;

    const sanitizedVariants = Array.isArray(file.variants)
      ? file.variants.map((variant: any) => ({
          ...variant,
          s3Key: null,
          s3Url: null,
          url: null,
        }))
      : file.variants;

    return {
      ...media,
      s3Key: null,
      s3Url: null,
      url: null,
      file: {
        ...file,
        s3Key: null,
        s3Url: null,
        url: null,
        variants: sanitizedVariants,
      },
    };
  }

  static fromExplicitDesign(source: any): DesignResponseDto {
    if (!source) return source;

    const designId = source.designId ?? source.id;
    const legacyCollectionId = source.legacyCollectionId ?? null;
    const medias = Array.isArray(source.medias)
      ? source.medias.map((media: any) => {
          const safeMedia = this.sanitizePrivateMedia(media);
          return {
            ...safeMedia,
            collectionMediaId:
              safeMedia.collectionMediaId ?? safeMedia.legacyCollectionMediaId ?? null,
            fileUploadId: safeMedia.fileUploadId ?? safeMedia.file?.id ?? null,
          };
        })
      : [];
    const appliedFilters = Array.isArray(source.filters)
      ? source.filters
      : Array.isArray(source.entityFilters)
        ? source.entityFilters.map((filter: any) => ({
            id: filter.id,
            valueId: filter.filterValueId,
            filterValueId: filter.filterValueId,
            value: filter.filterValue,
          }))
        : [];

    return {
      ...source,
      id: designId,
      designId,
      entityType: 'DESIGN',
      legacyCollectionId,
      // Compatibility for clients that still resolve collection-backed design IDs.
      collectionId: legacyCollectionId ?? designId,
      type: source.type,
      audience: source.audience ?? source.type,
      subCategoryId: source.subCategoryId ?? source.categoryTypeId ?? null,
      categoryTypeId: source.categoryTypeId ?? source.subCategoryId ?? null,
      medias,
      media: source.media ?? medias,
      filters: appliedFilters,
      filterValueIds: Array.isArray(source.filterValueIds)
        ? source.filterValueIds
        : Array.from(
            new Set(
              appliedFilters
                .map((filter: any) => filter?.valueId ?? filter?.filterValueId)
                .filter((value: unknown): value is string => typeof value === 'string'),
            ),
          ),
      customMeasurementKeys: Array.isArray(source.customMeasurementKeys)
        ? source.customMeasurementKeys
        : [],
      customFreeformPointIds: Array.isArray(source.customFreeformPointIds)
        ? source.customFreeformPointIds
        : [],
      rtwSizes: Array.isArray(source.rtwSizes) ? source.rtwSizes : [],
    };
  }

  static fromLegacyCollection(source: any): DesignResponseDto {
    if (!source) return source;

    const legacyCollectionId =
      source.legacyCollectionId ?? source.collectionId ?? source.id;
    const designId = source.designId ?? source.id ?? legacyCollectionId;
    const medias = Array.isArray(source.medias)
      ? source.medias
      : Array.isArray(source.media)
        ? source.media
        : [];
    const subCategoryId = source.subCategoryId ?? source.categoryTypeId ?? null;

    return {
      ...source,
      id: designId,
      designId,
      entityType: 'DESIGN',
      legacyCollectionId,
      // Compatibility for existing mobile/web clients during migration.
      collectionId: legacyCollectionId,
      type: source.type,
      audience: source.audience ?? source.type,
      subCategoryId,
      categoryTypeId: source.categoryTypeId ?? subCategoryId,
      medias,
      media: source.media ?? medias,
      filterValueIds: Array.isArray(source.filterValueIds)
        ? source.filterValueIds
        : Array.isArray(source.filters)
          ? Array.from(
              new Set(
                source.filters
                  .map((filter: any) => filter?.valueId)
                  .filter((value: unknown): value is string => typeof value === 'string'),
              ),
            )
          : [],
      customMeasurementKeys: Array.isArray(source.customMeasurementKeys)
        ? source.customMeasurementKeys
        : [],
      customFreeformPointIds: Array.isArray(source.customFreeformPointIds)
        ? source.customFreeformPointIds
        : [],
      rtwSizes: Array.isArray(source.rtwSizes) ? source.rtwSizes : [],
    };
  }

  static fromLegacyCollectionList(source: any): any {
    if (Array.isArray(source)) {
      return source.map((item) => this.fromLegacyCollection(item));
    }

    if (Array.isArray(source?.items)) {
      return {
        ...source,
        items: source.items.map((item: any) => this.fromLegacyCollection(item)),
      };
    }

    if (Array.isArray(source?.data)) {
      return {
        ...source,
        data: source.data.map((item: any) => this.fromLegacyCollection(item)),
      };
    }

    return source;
  }
}
