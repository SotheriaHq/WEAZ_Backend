import { Injectable } from '@nestjs/common';
import type {
  BagFittingState,
  BagFreshnessState,
  FittingFreshnessResult,
  SizeFitProfileForFreshness,
} from './bagging.types';

const DEFAULT_FRESHNESS_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class FittingFreshnessPolicy {
  evaluate(input: {
    requiredMeasurementKeys: string[];
    profile?: SizeFitProfileForFreshness | null;
    now?: Date;
  }): FittingFreshnessResult {
    const requiredMeasurementKeys = this.normalizeKeys(input.requiredMeasurementKeys);
    const staleAfterDays = this.resolveFreshnessDays(input.profile);

    if (requiredMeasurementKeys.length === 0) {
      return this.buildResult('NOT_REQUIRED', 'NOT_REQUIRED', [], null, staleAfterDays, null, false);
    }

    const measurementRecord = this.extractMeasurementRecord(input.profile?.measurements);
    const missingMeasurementKeys = requiredMeasurementKeys.filter((key) => {
      const raw = measurementRecord[key];
      const value =
        raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)
          ? (raw as Record<string, unknown>).value
          : raw;
      const numeric = Number(value);
      return !Number.isFinite(numeric) || numeric <= 0;
    });

    if (missingMeasurementKeys.length === requiredMeasurementKeys.length) {
      return this.buildResult('MISSING', 'MISSING', missingMeasurementKeys, null, staleAfterDays, null, false);
    }

    if (missingMeasurementKeys.length > 0) {
      return this.buildResult('PARTIAL', 'PARTIAL', missingMeasurementKeys, null, staleAfterDays, null, false);
    }

    const updatedAt = this.resolveMeasurementUpdatedAt(input.profile);
    if (!updatedAt) {
      return this.buildResult('COMPLETE', 'STALE', [], null, staleAfterDays, null, true);
    }

    const staleAt = new Date(updatedAt.getTime() + staleAfterDays * MS_PER_DAY);
    const now = input.now ?? new Date();
    const freshnessState: BagFreshnessState = staleAt.getTime() <= now.getTime() ? 'STALE' : 'FRESH';

    return this.buildResult(
      'COMPLETE',
      freshnessState,
      [],
      updatedAt.toISOString(),
      staleAfterDays,
      staleAt.toISOString(),
      freshnessState === 'STALE',
    );
  }

  private buildResult(
    fittingState: BagFittingState,
    freshnessState: BagFreshnessState,
    missingMeasurementKeys: string[],
    measurementUpdatedAt: string | null,
    staleAfterDays: number,
    staleAt: string | null,
    requiresStaleConfirmation: boolean,
  ): FittingFreshnessResult {
    return {
      fittingState,
      freshnessState,
      missingMeasurementKeys,
      measurementUpdatedAt,
      staleAfterDays,
      staleAt,
      requiresStaleConfirmation,
    };
  }

  private normalizeKeys(raw: string[]): string[] {
    return Array.from(
      new Set(
        (Array.isArray(raw) ? raw : [])
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter(Boolean),
      ),
    );
  }

  private resolveFreshnessDays(profile?: SizeFitProfileForFreshness | null): number {
    const configured = Number(profile?.requireUpdateEveryDays);
    return Number.isFinite(configured) && configured > 0
      ? Math.trunc(configured)
      : DEFAULT_FRESHNESS_DAYS;
  }

  private resolveMeasurementUpdatedAt(profile?: SizeFitProfileForFreshness | null): Date | null {
    const value = profile?.lastUpdatedAt ?? profile?.updatedAt ?? null;
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private extractMeasurementRecord(raw: unknown): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }
    return raw as Record<string, unknown>;
  }
}
