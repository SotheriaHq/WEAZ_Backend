import { CreateDesignDto } from './create-design.dto';
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
import { DesignFileSpecDto } from './design-metadata.dto';

export class InitializeDesignUploadDto extends CreateDesignDto {}

export class InitializeDesignMediaUploadDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => DesignFileSpecDto)
  files!: DesignFileSpecDto[];
}

export class ReorderDesignMediaItemDto {
  @IsString()
  @IsNotEmpty()
  mediaId!: string;

  @IsInt()
  @Min(0)
  orderIndex!: number;
}

export class ReorderDesignMediaDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderDesignMediaItemDto)
  items!: ReorderDesignMediaItemDto[];
}
