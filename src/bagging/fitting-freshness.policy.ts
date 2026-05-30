import { Injectable } from '@nestjs/common';
import type {
  BagFittingState,
  BagFreshnessState,
  FittingFreshnessResult,
  SizeFitProfileForFreshness,
} from './bagging.types';

const DEFAULT_FRESHNESS_DAYS = 14;
const DEFAULT_VERY_STALE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class FittingFreshnessPolicy {
  evaluate(input: {
    requiredMeasurementKeys: string[];
    profile?: SizeFitProfileForFreshness | null;
    now?: Date;
  }): FittingFreshnessResult {
    const requiredMeasurementKeys = this.normalizeKeys(
      input.requiredMeasurementKeys,
    );
    const staleAfterDays = this.resolveFreshnessDays(input.profile);
    const veryStaleAfterDays = this.resolveVeryStaleDays(staleAfterDays);

    if (requiredMeasurementKeys.length === 0) {
      return this.buildResult(
        'NOT_REQUIRED',
        'NOT_REQUIRED',
        [],
        [],
        [],
        null,
        staleAfterDays,
        null,
        veryStaleAfterDays,
        null,
        false,
      );
    }

    const measurementRecord = this.extractMeasurementRecord(
      input.profile?.measurements,
    );
    const missingMeasurementKeys = requiredMeasurementKeys.filter((key) => {
      const raw = measurementRecord[key];
      const value =
        raw &&
        typeof raw === 'object' &&
        'value' in (raw as Record<string, unknown>)
          ? (raw as Record<string, unknown>).value
          : raw;
      const numeric = Number(value);
      return !Number.isFinite(numeric) || numeric <= 0;
    });

    if (missingMeasurementKeys.length === requiredMeasurementKeys.length) {
      return this.buildResult(
        'MISSING',
        'MISSING',
        missingMeasurementKeys,
        [],
        [],
        null,
        staleAfterDays,
        null,
        veryStaleAfterDays,
        null,
        false,
      );
    }

    if (missingMeasurementKeys.length > 0) {
      return this.buildResult(
        'PARTIAL',
        'PARTIAL',
        missingMeasurementKeys,
        [],
        [],
        null,
        staleAfterDays,
        null,
        veryStaleAfterDays,
        null,
        false,
      );
    }

    const updatedAt = this.resolveMeasurementUpdatedAt(input.profile);
    if (!updatedAt) {
      return this.buildResult(
        'COMPLETE',
        'STALE',
        [],
        requiredMeasurementKeys,
        [],
        null,
        staleAfterDays,
        null,
        veryStaleAfterDays,
        null,
        true,
      );
    }

    const staleAt = new Date(updatedAt.getTime() + staleAfterDays * MS_PER_DAY);
    const veryStaleAt = new Date(
      updatedAt.getTime() + veryStaleAfterDays * MS_PER_DAY,
    );
    const now = input.now ?? new Date();
    const freshnessState: BagFreshnessState =
      veryStaleAt.getTime() <= now.getTime()
        ? 'VERY_STALE'
        : staleAt.getTime() <= now.getTime()
          ? 'STALE'
          : 'FRESH';
    const staleMeasurementKeys =
      freshnessState === 'STALE' || freshnessState === 'VERY_STALE'
        ? requiredMeasurementKeys
        : [];
    const veryStaleMeasurementKeys =
      freshnessState === 'VERY_STALE' ? requiredMeasurementKeys : [];

    return this.buildResult(
      'COMPLETE',
      freshnessState,
      [],
      staleMeasurementKeys,
      veryStaleMeasurementKeys,
      updatedAt.toISOString(),
      staleAfterDays,
      staleAt.toISOString(),
      veryStaleAfterDays,
      veryStaleAt.toISOString(),
      freshnessState === 'STALE' || freshnessState === 'VERY_STALE',
    );
  }

  private buildResult(
    fittingState: BagFittingState,
    freshnessState: BagFreshnessState,
    missingMeasurementKeys: string[],
    staleMeasurementKeys: string[],
    veryStaleMeasurementKeys: string[],
    measurementUpdatedAt: string | null,
    staleAfterDays: number,
    staleAt: string | null,
    veryStaleAfterDays: number,
    veryStaleAt: string | null,
    requiresStaleConfirmation: boolean,
  ): FittingFreshnessResult {
    return {
      fittingState,
      freshnessState,
      missingMeasurementKeys,
      staleMeasurementKeys,
      veryStaleMeasurementKeys,
      measurementUpdatedAt,
      staleAfterDays,
      staleAt,
      veryStaleAfterDays,
      veryStaleAt,
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

  private resolveFreshnessDays(
    profile?: SizeFitProfileForFreshness | null,
  ): number {
    const configured = Number(profile?.requireUpdateEveryDays);
    return Number.isFinite(configured) && configured > 0
      ? Math.trunc(configured)
      : DEFAULT_FRESHNESS_DAYS;
  }

  private resolveVeryStaleDays(staleAfterDays: number): number {
    return Math.max(staleAfterDays, DEFAULT_VERY_STALE_DAYS);
  }

  private resolveMeasurementUpdatedAt(
    profile?: SizeFitProfileForFreshness | null,
  ): Date | null {
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
