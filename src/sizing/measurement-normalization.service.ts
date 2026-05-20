import { Injectable } from '@nestjs/common';

export type CanonicalMeasurementKey =
  | 'HEIGHT'
  | 'CHEST_BUST'
  | 'WAIST'
  | 'HIP_SEAT'
  | 'SHOULDER'
  | 'SLEEVE_LENGTH'
  | 'INSEAM'
  | 'NECK_COLLAR';

export type MeasurementGender = 'MEN' | 'WOMEN' | 'UNISEX';

type CandidateSource = 'CANONICAL' | 'REGISTRY' | 'ALIAS';

export interface NormalizedMeasurementEntry {
  canonicalKey: CanonicalMeasurementKey;
  valueCm: number;
  sourceKey: string;
  registryKey: string | null;
  source: CandidateSource;
}

export interface NormalizedMeasurementRecord {
  canonicalMeasurements: Record<string, number>;
  canonicalEntries: Record<string, NormalizedMeasurementEntry>;
  storedMeasurements: Record<string, string | number | boolean | null>;
  unknownMeasurements: Record<string, unknown>;
  sourceKeysByCanonical: Record<string, string[]>;
}

const CANONICAL_KEYS: CanonicalMeasurementKey[] = [
  'HEIGHT',
  'CHEST_BUST',
  'WAIST',
  'HIP_SEAT',
  'SHOULDER',
  'SLEEVE_LENGTH',
  'INSEAM',
  'NECK_COLLAR',
];

const SLOT_REGISTRY_KEYS: Record<
  CanonicalMeasurementKey,
  { men: string; women: string; neutral: string[] }
> = {
  HEIGHT: {
    men: 'MEN_HEIGHT',
    women: 'WOMEN_HEIGHT',
    neutral: ['HEIGHT', 'BODY_HEIGHT', 'STATURE'],
  },
  CHEST_BUST: {
    men: 'MEN_CHEST',
    women: 'WOMEN_CHEST_FULL_BUST',
    neutral: ['CHEST', 'BUST', 'FULL_BUST', 'CHEST_BUST'],
  },
  WAIST: {
    men: 'MEN_WAIST',
    women: 'WOMEN_WAIST',
    neutral: ['WAIST', 'NATURAL_WAIST'],
  },
  HIP_SEAT: {
    men: 'MEN_HIP',
    women: 'WOMEN_HIP',
    neutral: ['HIP', 'HIPS', 'SEAT', 'HIP_SEAT'],
  },
  SHOULDER: {
    men: 'MEN_SHOULDER',
    women: 'WOMEN_SHOULDER_WIDTH',
    neutral: ['SHOULDER', 'SHOULDER_WIDTH'],
  },
  SLEEVE_LENGTH: {
    men: 'MEN_SLEEVE_LENGTH',
    women: 'WOMEN_SLEEVE_LENGTH_LONG',
    neutral: ['SLEEVE', 'SLEEVE_LENGTH', 'ARM_LENGTH'],
  },
  INSEAM: {
    men: 'MEN_INSEAM',
    women: 'WOMEN_INSEAM',
    neutral: ['INSEAM', 'INSIDE_LEG'],
  },
  NECK_COLLAR: {
    men: 'MEN_NECK',
    women: 'WOMEN_NECK',
    neutral: ['NECK', 'COLLAR', 'COLLAR_SIZE', 'NECK_GIRTH', 'NECK_COLLAR'],
  },
};

const ALIASES: Record<string, CanonicalMeasurementKey> = {
  HEIGHT: 'HEIGHT',
  STATURE: 'HEIGHT',
  BODYHEIGHT: 'HEIGHT',
  MENHEIGHT: 'HEIGHT',
  WOMENHEIGHT: 'HEIGHT',

  CHEST: 'CHEST_BUST',
  BUST: 'CHEST_BUST',
  FULLBUST: 'CHEST_BUST',
  CHESTBUST: 'CHEST_BUST',
  CHESTFULLBUST: 'CHEST_BUST',
  MENCHEST: 'CHEST_BUST',
  WOMENCHESTFULLBUST: 'CHEST_BUST',

  WAIST: 'WAIST',
  NATURALWAIST: 'WAIST',
  MENWAIST: 'WAIST',
  WOMENWAIST: 'WAIST',

  HIP: 'HIP_SEAT',
  HIPS: 'HIP_SEAT',
  SEAT: 'HIP_SEAT',
  HIPSEAT: 'HIP_SEAT',
  MENHIP: 'HIP_SEAT',
  WOMENHIP: 'HIP_SEAT',

  SHOULDER: 'SHOULDER',
  SHOULDERWIDTH: 'SHOULDER',
  MENSHOULDER: 'SHOULDER',
  WOMENSHOULDERWIDTH: 'SHOULDER',

  SLEEVE: 'SLEEVE_LENGTH',
  SLEEVELENGTH: 'SLEEVE_LENGTH',
  ARMLENGTH: 'SLEEVE_LENGTH',
  MENSLEEVELENGTH: 'SLEEVE_LENGTH',
  WOMENSLEEVELENGTHLONG: 'SLEEVE_LENGTH',

  INSEAM: 'INSEAM',
  INSIDELEG: 'INSEAM',
  MENINSEAM: 'INSEAM',
  WOMENINSEAM: 'INSEAM',

  NECK: 'NECK_COLLAR',
  COLLAR: 'NECK_COLLAR',
  COLLARSIZE: 'NECK_COLLAR',
  NECKGIRTH: 'NECK_COLLAR',
  NECKCOLLAR: 'NECK_COLLAR',
  MENNECK: 'NECK_COLLAR',
  WOMENNECK: 'NECK_COLLAR',
};

@Injectable()
export class MeasurementNormalizationService {
  readonly canonicalBaselineKeys = CANONICAL_KEYS;

  normalizeRecord(
    raw: unknown,
    options: { gender?: MeasurementGender | null } = {},
  ): NormalizedMeasurementRecord {
    const source = this.asRecord(raw);
    const gender = this.resolveGender(source, options.gender);
    const storedMeasurements: Record<string, string | number | boolean | null> =
      {};
    const unknownMeasurements: Record<string, unknown> = {};
    const canonicalEntries: Record<string, NormalizedMeasurementEntry> = {};
    const sourceKeysByCanonical: Record<string, string[]> = {};

    for (const [rawKey, rawValue] of Object.entries(source)) {
      if (!rawKey || rawKey.startsWith('_')) {
        continue;
      }

      const preserved = this.toStoredScalar(rawValue);
      if (preserved !== undefined) {
        storedMeasurements[rawKey] = preserved;
      }

      const canonicalKey = this.resolveCanonicalKey(rawKey);
      const valueCm = this.extractValueCm(rawValue);
      if (!canonicalKey || valueCm == null) {
        unknownMeasurements[rawKey] = rawValue;
        continue;
      }

      const entry = this.createEntry(rawKey, canonicalKey, valueCm, gender);
      const existing = canonicalEntries[canonicalKey];
      if (
        !existing ||
        this.entryPriority(entry) > this.entryPriority(existing)
      ) {
        canonicalEntries[canonicalKey] = entry;
      }

      sourceKeysByCanonical[canonicalKey] = Array.from(
        new Set([...(sourceKeysByCanonical[canonicalKey] ?? []), rawKey]),
      );
    }

    for (const entry of Object.values(canonicalEntries)) {
      storedMeasurements[entry.canonicalKey] = entry.valueCm;
      if (entry.registryKey) {
        storedMeasurements[entry.registryKey] = entry.valueCm;
      }
    }

    return {
      canonicalMeasurements: Object.fromEntries(
        Object.entries(canonicalEntries).map(([key, entry]) => [
          key,
          entry.valueCm,
        ]),
      ),
      canonicalEntries,
      storedMeasurements,
      unknownMeasurements,
      sourceKeysByCanonical,
    };
  }

  mergeForStorage(
    current: unknown,
    incoming: unknown,
    options: { gender?: MeasurementGender | null } = {},
  ): NormalizedMeasurementRecord {
    const currentNormalized = this.normalizeRecord(current, options);
    const incomingNormalized = this.normalizeRecord(incoming, options);
    return this.normalizeRecord(
      {
        ...currentNormalized.storedMeasurements,
        ...incomingNormalized.storedMeasurements,
      },
      options,
    );
  }

  resolveCanonicalKey(key: string): CanonicalMeasurementKey | null {
    const upper = String(key ?? '')
      .trim()
      .toUpperCase();
    if ((CANONICAL_KEYS as string[]).includes(upper)) {
      return upper as CanonicalMeasurementKey;
    }
    const compact = this.compactKey(key);
    return ALIASES[compact] ?? null;
  }

  preferredRegistryKey(
    canonicalKey: CanonicalMeasurementKey,
    gender?: MeasurementGender | null,
  ): string | null {
    const config = SLOT_REGISTRY_KEYS[canonicalKey];
    if (!config) return null;
    if (gender === 'MEN') return config.men;
    if (gender === 'WOMEN') return config.women;
    return null;
  }

  hasUsableMeasurementValue(value: unknown): boolean {
    const numeric = this.extractValueCm(value);
    return numeric != null && numeric > 0;
  }

  extractValueCm(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0 ? value : null;
    }

    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const objectValue = value as Record<string, unknown>;
    const raw =
      objectValue.value ??
      objectValue.valueCm ??
      objectValue.cm ??
      objectValue.measurement;
    const parsed =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number(raw.trim())
          : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    const unit = String(objectValue.unit ?? objectValue.valueUnit ?? 'CM')
      .trim()
      .toUpperCase();
    if (unit === 'IN' || unit === 'INCH' || unit === 'INCHES') {
      return this.round(parsed * 2.54);
    }
    return this.round(parsed);
  }

  normalizeRegion(value: unknown): string {
    const raw = String(value ?? '')
      .trim()
      .toUpperCase();
    if (raw === 'NG' || raw === 'NIGERIA' || raw === 'WEST_AFRICA') {
      return 'NG_WEST_AFRICA';
    }
    if (['NG_WEST_AFRICA', 'UK', 'US', 'EU', 'INTERNATIONAL'].includes(raw)) {
      return raw;
    }
    return 'INTERNATIONAL';
  }

  private createEntry(
    sourceKey: string,
    canonicalKey: CanonicalMeasurementKey,
    valueCm: number,
    gender: MeasurementGender | null,
  ): NormalizedMeasurementEntry {
    const upper = sourceKey.trim().toUpperCase();
    const registryKey = this.preferredRegistryKey(canonicalKey, gender);
    const source: CandidateSource = (CANONICAL_KEYS as string[]).includes(upper)
      ? 'CANONICAL'
      : upper.startsWith('MEN_') || upper.startsWith('WOMEN_')
        ? 'REGISTRY'
        : 'ALIAS';
    return {
      canonicalKey,
      valueCm,
      sourceKey,
      registryKey,
      source,
    };
  }

  private entryPriority(entry: NormalizedMeasurementEntry): number {
    if (entry.source === 'CANONICAL') return 3;
    if (entry.source === 'REGISTRY') return 2;
    return 1;
  }

  private resolveGender(
    source: Record<string, unknown>,
    preferred?: MeasurementGender | null,
  ): MeasurementGender | null {
    if (preferred === 'MEN' || preferred === 'WOMEN') {
      return preferred;
    }
    const keys = Object.keys(source);
    if (keys.some((key) => key.toUpperCase().startsWith('MEN_'))) {
      return 'MEN';
    }
    if (keys.some((key) => key.toUpperCase().startsWith('WOMEN_'))) {
      return 'WOMEN';
    }
    return preferred === 'UNISEX' ? 'UNISEX' : null;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private toStoredScalar(
    value: unknown,
  ): string | number | boolean | null | undefined {
    const numeric = this.extractValueCm(value);
    if (numeric != null) return numeric;
    if (value == null) return null;
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'boolean') return value;
    return undefined;
  }

  private compactKey(key: string): string {
    return String(key ?? '')
      .trim()
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
