import { IsArray, ValidateNested, IsString, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

class ServerFileDto {
  @IsString()
  originalName: string;

  @IsString()
  contentType: string;

  @IsString()
  base64: string; // base64-encoded file content

  @IsOptional()
  @IsString()
  fileType?: string;
}

export class ServerUploadDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ServerFileDto)
  files: ServerFileDto[];
}
