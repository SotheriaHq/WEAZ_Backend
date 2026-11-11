import { ConfigService } from '@nestjs/config';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { AdaptiveAccessService, type AdaptiveOperation } from './adaptive-access.service';
import { READ_ONLY_RESPONSE_KEY } from '../decorator/read-only-response.decorator';
import { UploadController } from 'src/upload/upload.controller';

describe('explicit read-only POST responses', () => {
  it('marks only the three non-mutating upload lookup handlers', () => {
    const expected = ['getPublicSignedUrls', 'getPublicSignedUrlsBySource', 'getSignedUrlsBySource'];
    const marked = Object.getOwnPropertyNames(UploadController.prototype).filter(name =>
      Reflect.getMetadata(READ_ONLY_RESPONSE_KEY, UploadController.prototype[name]) === true);
    expect(marked.sort()).toEqual(expected.sort());
    for (const name of marked) expect(Reflect.getMetadata(METHOD_METADATA, UploadController.prototype[name])).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(READ_ONLY_RESPONSE_KEY, UploadController.prototype.uploadPostImage)).toBeUndefined();
  });

  it.each([
    { method: 'POST', readOnlyResponse: false, sensitivity: 'ACCOUNT' },
    { method: 'PATCH', readOnlyResponse: true, sensitivity: 'ACCOUNT' },
    { method: 'POST', readOnlyResponse: true, sensitivity: 'CRITICAL_CHANGE' },
    { method: 'GET', readOnlyResponse: true, sensitivity: 'CRITICAL_CHANGE' },
  ] as const)('refuses to reinterpret a command or critical proof as a read: %o', async input => {
    const prisma = { $transaction: jest.fn() };
    const access = new AdaptiveAccessService(prisma as any, new ConfigService());
    const operation: AdaptiveOperation = { method: input.method, readOnlyResponse: input.readOnlyResponse,
      policy: { sensitivity: input.sensitivity, scope: 'SELF', action: 'fixture' },
      actor: { id: 'user', sid: 'session', authVersion: 0, role: 'User' },
      path: '/fixture', route: '/fixture', body: null, requiredAdminPermissions: [], requestId: 'fixture', operationDigest: '' };
    await expect(access.revalidateRead(operation))
      .rejects.toMatchObject({ status: 400 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
