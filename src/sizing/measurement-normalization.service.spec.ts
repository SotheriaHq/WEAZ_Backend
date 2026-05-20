import { MeasurementNormalizationService } from './measurement-normalization.service';

describe('MeasurementNormalizationService', () => {
  let service: MeasurementNormalizationService;

  beforeEach(() => {
    service = new MeasurementNormalizationService();
  });

  it('normalizes mobile generic keys into canonical backend keys', () => {
    const result = service.normalizeRecord({
      height: 178,
      chest: 104,
      waist: 90,
      hip: 106,
      shoulder: 45,
      sleeve: 63,
      inseam: 82,
      neck: 41,
    });

    expect(result.canonicalMeasurements).toMatchObject({
      HEIGHT: 178,
      CHEST_BUST: 104,
      WAIST: 90,
      HIP_SEAT: 106,
      SHOULDER: 45,
      SLEEVE_LENGTH: 63,
      INSEAM: 82,
      NECK_COLLAR: 41,
    });
    expect(result.storedMeasurements.chest).toBe(104);
    expect(result.storedMeasurements.CHEST_BUST).toBe(104);
    expect(result.storedMeasurements.WOMEN_CHEST_FULL_BUST).toBeUndefined();
  });

  it('passes canonical backend keys through unchanged', () => {
    const result = service.normalizeRecord({
      HEIGHT: 170,
      CHEST_BUST: 96,
      WAIST: 80,
      HIP_SEAT: 101,
    });

    expect(result.canonicalMeasurements).toMatchObject({
      HEIGHT: 170,
      CHEST_BUST: 96,
      WAIST: 80,
      HIP_SEAT: 101,
    });
    expect(result.sourceKeysByCanonical.CHEST_BUST).toEqual(['CHEST_BUST']);
  });

  it('supports mixed old registry keys and newer aliases', () => {
    const result = service.normalizeRecord({
      MEN_CHEST: 108,
      naturalWaist: 94,
      insideLeg: { value: 32, unit: 'IN' },
      collarSize: '42',
    });

    expect(result.canonicalMeasurements.CHEST_BUST).toBe(108);
    expect(result.canonicalMeasurements.WAIST).toBe(94);
    expect(result.canonicalMeasurements.INSEAM).toBe(81.28);
    expect(result.canonicalMeasurements.NECK_COLLAR).toBe(42);
    expect(result.storedMeasurements.MEN_CHEST).toBe(108);
    expect(result.storedMeasurements.MEN_INSEAM).toBe(81.28);
  });

  it('preserves unknown keys without treating them as canonical measurements', () => {
    const result = service.normalizeRecord({
      chestBust: 100,
      agbadaCapDrop: 18,
      notes: 'prefers loose sleeves',
    });

    expect(result.canonicalMeasurements.CHEST_BUST).toBe(100);
    expect(result.unknownMeasurements).toMatchObject({
      agbadaCapDrop: 18,
      notes: 'prefers loose sleeves',
    });
    expect(result.storedMeasurements.agbadaCapDrop).toBe(18);
    expect(result.storedMeasurements.notes).toBe('prefers loose sleeves');
  });

  it('resolves duplicate aliases predictably when a canonical key already exists', () => {
    const result = service.normalizeRecord({
      chest: 98,
      WOMEN_CHEST_FULL_BUST: 101,
      CHEST_BUST: 103,
    });

    expect(result.canonicalMeasurements.CHEST_BUST).toBe(103);
    expect(result.sourceKeysByCanonical.CHEST_BUST).toEqual([
      'chest',
      'WOMEN_CHEST_FULL_BUST',
      'CHEST_BUST',
    ]);
  });

  it('merges incoming measurements without losing existing values or unknown fields', () => {
    const result = service.mergeForStorage(
      {
        shoulder: 43,
        legacySleeveEase: 'plus two',
      },
      {
        chest: 102,
        waist: 88,
      },
    );

    expect(result.canonicalMeasurements).toMatchObject({
      SHOULDER: 43,
      CHEST_BUST: 102,
      WAIST: 88,
    });
    expect(result.storedMeasurements.legacySleeveEase).toBe('plus two');
  });
});
