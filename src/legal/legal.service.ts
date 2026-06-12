import { BadRequestException, Injectable } from '@nestjs/common';
import {
  LegalAcceptanceSource,
  LegalDocumentKey,
  Prisma,
  UserType,
} from '@prisma/client';
import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  LEGAL_DOCUMENTS,
  LEGAL_REQUIRED_DOCUMENTS,
  LegalDocumentDefinition,
} from './legal.constants';
import { LegalAcceptanceInputDto } from './dto/legal-acceptance.dto';

type LegalDbClient = PrismaService | Prisma.TransactionClient;

type RequestEvidence = {
  ipAddress?: string | null;
  userAgent?: string | null;
  locale?: string | null;
  appVersion?: string | null;
};

export type LegalAcceptancePayload = Pick<
  LegalAcceptanceInputDto,
  'documentKey' | 'version'
>;

@Injectable()
export class LegalService {
  constructor(private readonly prisma: PrismaService) {}

  getCurrentVersions() {
    return {
      documents: Object.values(LEGAL_DOCUMENTS),
      required: {
        signup: [...LEGAL_REQUIRED_DOCUMENTS.signup],
        checkout: [...LEGAL_REQUIRED_DOCUMENTS.checkout],
        storePublish: [...LEGAL_REQUIRED_DOCUMENTS.storePublish],
        contentPublish: [...LEGAL_REQUIRED_DOCUMENTS.contentPublish],
      },
    };
  }

  getDocument(key: LegalDocumentKey): LegalDocumentDefinition {
    return LEGAL_DOCUMENTS[key];
  }

  getRequiredSignupDocuments(): LegalDocumentKey[] {
    return [...LEGAL_REQUIRED_DOCUMENTS.signup];
  }

  getRequiredCheckoutDocuments(): LegalDocumentKey[] {
    return [...LEGAL_REQUIRED_DOCUMENTS.checkout];
  }

  getRequiredStorePublishDocuments(): LegalDocumentKey[] {
    return [...LEGAL_REQUIRED_DOCUMENTS.storePublish];
  }

  getRequiredContentPublishDocuments(): LegalDocumentKey[] {
    return [...LEGAL_REQUIRED_DOCUMENTS.contentPublish];
  }

  assertRequiredCurrentAcceptances(
    acceptances: LegalAcceptancePayload[] | null | undefined,
    requiredKeys: LegalDocumentKey[],
  ): void {
    const provided = new Map<LegalDocumentKey, string>();
    for (const acceptance of this.normalizeAcceptances(acceptances)) {
      provided.set(acceptance.documentKey, acceptance.version.trim());
    }

    const missing = requiredKeys.filter((key) => {
      const document = LEGAL_DOCUMENTS[key];
      return provided.get(key) !== document.version;
    });

    if (missing.length > 0) {
      const labels = missing
        .map(
          (key) =>
            `${LEGAL_DOCUMENTS[key].title} ${LEGAL_DOCUMENTS[key].version}`,
        )
        .join(', ');
      throw new BadRequestException(
        `Accept the current legal terms before continuing: ${labels}.`,
      );
    }
  }

  async recordAcceptedDocuments(args: {
    userId: string;
    acceptances: LegalAcceptancePayload[] | null | undefined;
    requiredKeys?: LegalDocumentKey[];
    source: LegalAcceptanceSource;
    surface: string;
    accountType?: UserType | null;
    req?: Request | null;
    tx?: Prisma.TransactionClient;
    metadata?: Record<string, unknown> | null;
    locale?: string | null;
    appVersion?: string | null;
    evidence?: RequestEvidence;
  }): Promise<void> {
    const requiredKeys =
      args.requiredKeys ??
      this.normalizeAcceptances(args.acceptances).map(
        (entry) => entry.documentKey,
      );
    this.assertRequiredCurrentAcceptances(args.acceptances, requiredKeys);

    const evidence = this.extractEvidence(args.req, {
      ...args.evidence,
      locale: args.locale ?? args.evidence?.locale ?? null,
      appVersion: args.appVersion ?? args.evidence?.appVersion ?? null,
    });
    const client = args.tx ?? this.prisma;

    const data = requiredKeys.map((documentKey) => {
      const document = LEGAL_DOCUMENTS[documentKey];
      return {
        id: uuidv4(),
        userId: args.userId,
        documentKey,
        version: document.version,
        source: args.source,
        surface: args.surface,
        accountType: args.accountType ?? null,
        ipAddress: evidence.ipAddress ?? null,
        userAgent: evidence.userAgent ?? null,
        locale: evidence.locale ?? null,
        appVersion: evidence.appVersion ?? null,
        metadata: (args.metadata ?? null) as Prisma.InputJsonValue | null,
      };
    });

    if (data.length === 0) return;

    await (client as any).legalAcceptance.createMany({
      data,
      skipDuplicates: true,
    });
  }

  async ensureCurrentAcceptancesForUser(args: {
    userId: string;
    requiredKeys: LegalDocumentKey[];
    acceptances?: LegalAcceptancePayload[] | null;
    source: LegalAcceptanceSource;
    surface: string;
    req?: Request | null;
    accountType?: UserType | null;
    metadata?: Record<string, unknown> | null;
    locale?: string | null;
    appVersion?: string | null;
  }): Promise<void> {
    if (args.acceptances && args.acceptances.length > 0) {
      await this.recordAcceptedDocuments({
        userId: args.userId,
        acceptances: args.acceptances,
        requiredKeys: args.requiredKeys,
        source: args.source,
        surface: args.surface,
        req: args.req,
        accountType: args.accountType,
        metadata: args.metadata,
        locale: args.locale,
        appVersion: args.appVersion,
      });
    }

    const currentDocuments = args.requiredKeys.map(
      (key) => LEGAL_DOCUMENTS[key],
    );
    const rows = await (this.prisma as any).legalAcceptance.findMany({
      where: {
        userId: args.userId,
        OR: currentDocuments.map((document) => ({
          documentKey: document.key,
          version: document.version,
        })),
      },
      select: {
        documentKey: true,
        version: true,
      },
    });

    const accepted = new Set(
      rows.map((row: { documentKey: LegalDocumentKey; version: string }) => {
        return `${row.documentKey}:${row.version}`;
      }),
    );

    const missing = currentDocuments.filter(
      (document) => !accepted.has(`${document.key}:${document.version}`),
    );

    if (missing.length > 0) {
      throw new BadRequestException(
        `Accept the current legal terms before continuing: ${missing
          .map((document) => `${document.title} ${document.version}`)
          .join(', ')}.`,
      );
    }
  }

  async listUserAcceptances(userId: string) {
    return (this.prisma as any).legalAcceptance.findMany({
      where: { userId },
      orderBy: [{ acceptedAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        documentKey: true,
        version: true,
        source: true,
        surface: true,
        accountType: true,
        locale: true,
        appVersion: true,
        acceptedAt: true,
        createdAt: true,
      },
    });
  }

  private normalizeAcceptances(
    acceptances: LegalAcceptancePayload[] | null | undefined,
  ): LegalAcceptancePayload[] {
    if (!Array.isArray(acceptances)) return [];
    return acceptances
      .map((entry) => ({
        documentKey: entry?.documentKey,
        version: String(entry?.version ?? '').trim(),
      }))
      .filter(
        (entry) => Boolean(entry.documentKey) && entry.version.length > 0,
      );
  }

  private extractEvidence(
    req?: Request | null,
    fallback?: RequestEvidence,
  ): Required<RequestEvidence> {
    const readHeader = (name: string): string | null => {
      const value = req?.headers?.[name];
      if (Array.isArray(value)) return String(value[0] ?? '').trim() || null;
      return typeof value === 'string' ? value.trim() || null : null;
    };

    return {
      ipAddress:
        fallback?.ipAddress ??
        req?.ip ??
        req?.socket?.remoteAddress ??
        readHeader('x-forwarded-for') ??
        null,
      userAgent: fallback?.userAgent ?? readHeader('user-agent') ?? null,
      locale:
        fallback?.locale ??
        readHeader('x-client-locale') ??
        readHeader('accept-language') ??
        null,
      appVersion:
        fallback?.appVersion ??
        readHeader('x-client-version') ??
        readHeader('x-app-version') ??
        null,
    };
  }
}
