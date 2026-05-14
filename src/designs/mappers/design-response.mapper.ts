import { DesignResponseDto } from '../dto/design-response.dto';

export class DesignResponseMapper {
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
