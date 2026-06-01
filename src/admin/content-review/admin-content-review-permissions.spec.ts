import 'reflect-metadata';

import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { ADMIN_PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { AdminContentReviewController } from './admin-content-review.controller';

const getRequiredPermissions = (
  methodName: keyof AdminContentReviewController,
) =>
  Reflect.getMetadata(
    ADMIN_PERMISSIONS_KEY,
    AdminContentReviewController.prototype[methodName],
  );

describe('AdminContentReviewController permissions', () => {
  it('requires read permission for review and report reads', () => {
    expect(getRequiredPermissions('reasonCodes')).toEqual([
      ADMIN_PERMISSIONS.CONTENT_REVIEW_READ,
    ]);
    expect(getRequiredPermissions('reportReasonCodes')).toEqual([
      ADMIN_PERMISSIONS.CONTENT_REVIEW_READ,
    ]);
    expect(getRequiredPermissions('listSubmissions')).toEqual([
      ADMIN_PERMISSIONS.CONTENT_REVIEW_READ,
    ]);
    expect(getRequiredPermissions('getSubmission')).toEqual([
      ADMIN_PERMISSIONS.CONTENT_REVIEW_READ,
    ]);
    expect(getRequiredPermissions('listReports')).toEqual([
      ADMIN_PERMISSIONS.CONTENT_REVIEW_READ,
    ]);
    expect(getRequiredPermissions('getReport')).toEqual([
      ADMIN_PERMISSIONS.CONTENT_REVIEW_READ,
    ]);
  });

  it('requires manage permission for review and report writes', () => {
    expect(getRequiredPermissions('approveSubmission')).toEqual([
      ADMIN_PERMISSIONS.CONTENT_REVIEW_MANAGE,
    ]);
    expect(getRequiredPermissions('rejectSubmission')).toEqual([
      ADMIN_PERMISSIONS.CONTENT_REVIEW_MANAGE,
    ]);
    expect(getRequiredPermissions('requestChanges')).toEqual([
      ADMIN_PERMISSIONS.CONTENT_REVIEW_MANAGE,
    ]);
    expect(getRequiredPermissions('resolveReport')).toEqual([
      ADMIN_PERMISSIONS.CONTENT_REVIEW_MANAGE,
    ]);
    expect(getRequiredPermissions('setBrandTrustOverride')).toEqual([
      ADMIN_PERMISSIONS.CONTENT_REVIEW_MANAGE,
    ]);
  });
});
