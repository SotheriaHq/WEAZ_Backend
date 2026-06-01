import { Injectable } from '@nestjs/common';
import { ContentIntegrityService } from 'src/content-integrity/content-integrity.service';
import {
  BrandTrustOverrideDto,
  ContentReviewDecisionDto,
  ContentReviewQueryDto,
} from './dto/content-review.dto';

@Injectable()
export class AdminContentReviewService {
  constructor(private readonly contentIntegrity: ContentIntegrityService) {}

  listSubmissions(query: ContentReviewQueryDto) {
    return this.contentIntegrity.listSubmissions({
      status: query.status,
      entityType: query.entityType,
    });
  }

  getSubmission(id: string) {
    return this.contentIntegrity.getSubmission(id);
  }

  getReasonCodes() {
    return this.contentIntegrity.getReasonCodes();
  }

  approveSubmission(
    submissionId: string,
    adminUserId: string,
    req: any,
  ) {
    return this.contentIntegrity.reviewSubmission({
      submissionId,
      adminUserId,
      action: 'approve',
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
    });
  }

  rejectSubmission(
    submissionId: string,
    adminUserId: string,
    dto: ContentReviewDecisionDto,
    req: any,
  ) {
    return this.contentIntegrity.reviewSubmission({
      submissionId,
      adminUserId,
      action: 'reject',
      reasonCode: dto.reasonCode,
      reasonNote: dto.reasonNote,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
    });
  }

  requestChanges(
    submissionId: string,
    adminUserId: string,
    dto: ContentReviewDecisionDto,
    req: any,
  ) {
    return this.contentIntegrity.reviewSubmission({
      submissionId,
      adminUserId,
      action: 'request_changes',
      reasonCode: dto.reasonCode,
      reasonNote: dto.reasonNote,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
    });
  }

  setBrandTrustOverride(
    brandId: string,
    adminUserId: string,
    dto: BrandTrustOverrideDto,
    req: any,
  ) {
    return this.contentIntegrity.setBrandTrustOverride({
      brandId,
      adminUserId,
      trustTier: dto.trustTier,
      reviewMode: dto.reviewMode,
      reason: dto.reason,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
    });
  }
}
