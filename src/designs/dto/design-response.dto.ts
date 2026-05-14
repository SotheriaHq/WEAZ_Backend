import { CollectionType, CollectionVisibility } from '@prisma/client';

export class DesignResponseDto {
  id: string;
  designId: string;
  legacyCollectionId?: string;
  collectionId?: string;
  title?: string | null;
  description?: string | null;
  visibility?: CollectionVisibility;
  type?: CollectionType;
  audience?: CollectionType;
  categoryId?: string | null;
  subCategoryId?: string | null;
  categoryTypeId?: string | null;
  tags?: string[];
  medias?: unknown[];
  media?: unknown[];
  filters?: unknown[];
  filterValueIds?: string[];
  sizingMode?: string | null;
  rtwSizes?: string[];
  rtwSizeSystem?: string | null;
  rtwSizeType?: string | null;
  customGender?: string | null;
  customFreeformPointIds?: string[];
  fitPreference?: string | null;
  targetAgeGroup?: string | null;
  customOrderEnabled?: boolean;
  customMeasurementKeys?: string[];
  status?: string;
  draftVersion?: number;
  metadataEditedAt?: Date | string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}
