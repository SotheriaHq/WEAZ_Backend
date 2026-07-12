import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Sent by web/mobile when a client-side "Go Live" fails after the draft was
 * already created server-side (media upload/finalize failed). Produces a
 * durable, cross-device CONTENT_PUBLISH_FAILED notification that routes the
 * owner back to the draft. Never trusts the client for anything but context.
 */
export class ReportDesignPublishFailureDto {
  /** Design/collection title snapshot for a readable notification message. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  /** Short reason (client error message), surfaced for support/diagnostics. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** Where in the pipeline it failed, for diagnostics. */
  @IsOptional()
  @IsIn(['initialize', 'upload', 'finalize'])
  stage?: 'initialize' | 'upload' | 'finalize';
}
