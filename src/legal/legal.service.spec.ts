import {
  LegalAcceptanceSource,
  LegalDocumentKey,
  UserType,
} from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { LegalService } from './legal.service';
import { LEGAL_DOCUMENTS } from './legal.constants';

describe('LegalService', () => {
  const createService = () => {
    const prisma = {
      legalAcceptance: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;
    return { prisma, service: new LegalService(prisma) };
  };

  it('rejects missing current required document versions', () => {
    const { service } = createService();

    expect(() =>
      service.assertRequiredCurrentAcceptances(
        [
          {
            documentKey: LegalDocumentKey.TERMS_OF_SERVICE,
            version: LEGAL_DOCUMENTS.TERMS_OF_SERVICE.version,
          },
        ],
        [LegalDocumentKey.TERMS_OF_SERVICE, LegalDocumentKey.PRIVACY_POLICY],
      ),
    ).toThrow(BadRequestException);
  });

  it('records accepted current documents with request evidence', async () => {
    const { prisma, service } = createService();

    await service.recordAcceptedDocuments({
      userId: 'user-1',
      acceptances: [
        {
          documentKey: LegalDocumentKey.TERMS_OF_SERVICE,
          version: LEGAL_DOCUMENTS.TERMS_OF_SERVICE.version,
        },
        {
          documentKey: LegalDocumentKey.PRIVACY_POLICY,
          version: LEGAL_DOCUMENTS.PRIVACY_POLICY.version,
        },
      ],
      requiredKeys: [
        LegalDocumentKey.TERMS_OF_SERVICE,
        LegalDocumentKey.PRIVACY_POLICY,
      ],
      source: LegalAcceptanceSource.SIGNUP,
      surface: 'signup',
      accountType: UserType.REGULAR,
      evidence: {
        ipAddress: '203.0.113.10',
        userAgent: 'jest',
        locale: 'en-NG',
        appVersion: 'test',
      },
    });

    expect(prisma.legalAcceptance.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: expect.arrayContaining([
          expect.objectContaining({
            userId: 'user-1',
            documentKey: LegalDocumentKey.TERMS_OF_SERVICE,
            version: LEGAL_DOCUMENTS.TERMS_OF_SERVICE.version,
            source: LegalAcceptanceSource.SIGNUP,
            surface: 'signup',
            accountType: UserType.REGULAR,
            ipAddress: '203.0.113.10',
            userAgent: 'jest',
            locale: 'en-NG',
            appVersion: 'test',
          }),
        ]),
      }),
    );
  });
});
