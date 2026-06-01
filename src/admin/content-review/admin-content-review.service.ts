import { Injectable } from '@nestjs/common';
import { ContentIntegrityService } from 'src/content-integrity/content-integrity.service';
import {
  BrandTrustOverrideDto,
  ContentReportQueryDto,
  ContentReportResolutionDto,
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
      brandId: query.brandId,
      trustTier: query.trustTier,
      reviewMode: query.reviewMode,
      from: query.from,
      to: query.to,
      q: query.q,
      cursor: query.cursor,
      take: query.take,
    });
  }

  getSubmission(id: string) {
    return this.contentIntegrity.getSubmission(id);
  }

  getReasonCodes() {
    return this.contentIntegrity.getReasonCodes();
  }

  getReportReasonCodes() {
    return this.contentIntegrity.getReportReasonCodes();
  }

  listReports(query: ContentReportQueryDto) {
    return this.contentIntegrity.listReports(query);
  }

  getReport(id: string) {
    return this.contentIntegrity.getReport(id);
  }

  resolveReport(
    reportId: string,
    adminUserId: string,
    dto: ContentReportResolutionDto,
    req: any,
  ) {
    return this.contentIntegrity.resolveReport({
      reportId,
      adminUserId,
      status: dto.status,
      resolution: dto.resolution,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
    });
  }

  approveSubmission(submissionId: string, adminUserId: string, req: any) {
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
