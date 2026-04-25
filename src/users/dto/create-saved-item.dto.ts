import { IsEnum, IsUUID } from 'class-validator';

export enum SavedItemTypeDto {
  COLLECTION = 'COLLECTION',
  COLLECTION_MEDIA = 'COLLECTION_MEDIA',
}

export class CreateSavedItemDto {
  @IsEnum(SavedItemTypeDto)
  targetType: SavedItemTypeDto;

  @IsUUID()
  targetId: string;
}