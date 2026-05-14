import { IsEnum, IsUUID } from 'class-validator';

export enum SavedItemTypeDto {
  COLLECTION = 'COLLECTION',
  COLLECTION_MEDIA = 'COLLECTION_MEDIA',
  DESIGN = 'DESIGN',
  PRODUCT = 'PRODUCT',
}

export class CreateSavedItemDto {
  @IsEnum(SavedItemTypeDto)
  targetType: SavedItemTypeDto;

  @IsUUID()
  targetId: string;
}
