import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateMeasurementPointLifecycleDto {
  @IsString()
  @IsIn(['approve', 'reject', 'activate', 'deactivate'])
  action: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
