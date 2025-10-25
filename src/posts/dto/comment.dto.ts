import { IsString, IsNotEmpty } from 'class-validator';
import { PaginationDto } from '../../upload/dto/pagination.dto';

export class CreateCommentDto {
  @IsString()
  @IsNotEmpty()
  content: string;
}

export class UpdateCommentDto {
  @IsString()
  @IsNotEmpty()
  content: string;
}

export class GetCommentsDto extends PaginationDto {}
