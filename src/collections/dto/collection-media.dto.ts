import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

import { FileSpecDto } from './create-collection.dto';

export class InitializeCollectionMediaUploadsDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => FileSpecDto)
  files!: FileSpecDto[];
}

export class ReorderCollectionMediaItemDto {
  @IsString()
  @IsNotEmpty()
  mediaId!: string;

  @IsInt()
  @Min(0)
  orderIndex!: number;
}

export class ReorderCollectionMediaDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderCollectionMediaItemDto)
  items!: ReorderCollectionMediaItemDto[];
}
