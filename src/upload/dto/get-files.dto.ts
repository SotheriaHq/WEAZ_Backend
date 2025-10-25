import { IsEnum, IsOptional } from 'class-validator';
import { FileType } from '../upload.service';
import { PaginationDto } from './pagination.dto';

export class GetFilesDto extends PaginationDto {
  @IsOptional()
  @IsEnum(FileType)
  type?: FileType;
}
