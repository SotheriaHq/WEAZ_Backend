import { ArrayMaxSize, ArrayNotEmpty, IsEnum, IsUUID } from 'class-validator';
import { SavedItemTypeDto } from './create-saved-item.dto';

export class CheckSavedBatchDto {
  @IsEnum(SavedItemTypeDto)
  targetType: SavedItemTypeDto;

  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  targetIds: string[];
}
