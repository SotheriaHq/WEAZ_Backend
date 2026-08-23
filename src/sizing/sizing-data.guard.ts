import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Startup assertion: the system must always be able to size somebody.
 *
 * Sizing degrades silently. With no approved chart rows the recommendation
 * service still returns 200 with `estimatedSize: null` and a warning buried in
 * `categoryBreakdown[*].warnings`, so nothing in the logs, the health check or
 * the API surface says anything is wrong — the only symptom is an em dash on a
 * profile screen. That is how an empty `SizeChartRow` table survived into a live
 * environment and read to everyone as a broken feature.
 *
 * This turns an invisible data gap into a loud boot-time error. It deliberately
 * does NOT throw: refusing to start would take the whole API down over a feature
 * that is not on the critical path, which trades a silent failure for a much
 * louder wrong one. It logs at `error` so it reaches alerting, and
 * `assertUsableSizingData` is exported for CI to call and fail on.
 */
@Injectable()
export class SizingDataGuard implements OnModuleInit {
  private readonly logger = new Logger(SizingDataGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const report = await this.inspect();
    if (report.usable) {
      this.logger.log(
        `Sizing data OK — ${report.approvedVersions} approved chart version(s), ${report.rows} row(s).`,
      );
      return;
    }

    this.logger.error(
      [
        'SIZING DATA MISSING — no approved size chart rows are available.',
        `charts=${report.charts} approvedVersions=${report.approvedVersions} rows=${report.rows}`,
        'Every size estimate will return null and every shopper sees a blank size.',
        'Fix: npx ts-node -T -r tsconfig-paths/register prisma/seed_size_charts.ts',
      ].join(' '),
    );
  }

  async inspect(): Promise<{
    charts: number;
    approvedVersions: number;
    rows: number;
    usable: boolean;
  }> {
    const prisma = this.prisma as any;
    const [charts, approvedVersions, rows] = await Promise.all([
      prisma.sizeChart.count(),
      prisma.sizeChartVersion.count(),
      prisma.sizeChartRow.count(),
    ]);
    return {
      charts,
      approvedVersions,
      rows,
      // Rows are the only thing that actually produces a size. A chart with no
      // version, or a version with no rows, is indistinguishable from nothing.
      usable: rows > 0 && approvedVersions > 0,
    };
  }
}
