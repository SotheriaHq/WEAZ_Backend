import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum ModerationAction {
    KEEP = 'KEEP',
    HIDE = 'HIDE',
    RESTORE = 'RESTORE',
    DELETE = 'DELETE',
}

export class AdminModerationDto {
    @IsEnum(ModerationAction)
    action: ModerationAction;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    reason?: string;

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    moderatorNote?: string;
}

export class AdminReviewStatusDto {
    @IsOptional()
    @IsString()
    @MaxLength(500)
    reason?: string;
}
