import { IsNotEmpty, IsObject, IsString } from 'class-validator';

/**
 * Shape-only DTO — the deep validation (valid HH:mm times, close>open, at least
 * one open day, valid IANA timezone) lives in `working-hours.util` and is run in
 * the service so the same rules apply everywhere.
 */
export class UpdateWorkingHoursDto {
  @IsObject()
  workingHours!: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  timezone!: string;
}
