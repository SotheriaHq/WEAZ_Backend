import { IsOptional, IsString, IsArray, IsUUID } from 'class-validator';
import { PaginationDto } from '../../upload/dto/pagination.dto';

export class CreatePostDto {
  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  imageIds?: string[];

  @IsOptional()
  @IsUUID('4')
  videoId?: string;
}

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  content?: string;
}

export class GetPostsDto extends PaginationDto {}
