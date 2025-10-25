import { IsOptional, IsString, IsUUID, MaxLength, MinLength, IsInt } from 'class-validator';

export class CreateCommentV2Dto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  content!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class ListQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string; // ISO date string cursor (createdAt)

  @IsOptional()
  @IsInt()
  limit?: number;
}

