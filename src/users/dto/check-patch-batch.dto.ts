import { ArrayMaxSize, ArrayNotEmpty, IsUUID } from 'class-validator';

export class CheckPatchBatchDto {
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  targetIds: string[];
}