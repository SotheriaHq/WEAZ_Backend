import { auditMeasurements, PLAUSIBLE_RANGE_CM } from './measurement-integrity';

describe('auditMeasurements', () => {
  it('passes an ordinary body through untouched', () => {
    const measurements = {
      HEIGHT: 182,
      CHEST_BUST: 114,
      WAIST: 92,
      HIP_SEAT: 108,
      SHOULDER: 47,
      SLEEVE_LENGTH: 65,
      INSEAM: 84,
      NECK_COLLAR: 41,
    };
    const { trusted, problems } = auditMeasurements(measurements);
    expect(problems).toEqual([]);
    expect(trusted).toEqual(measurements);
  });

  it('accepts an athletic drop and a portly build — neither is a data error', () => {
    // 34cm drop (V-taper) and a waist wider than the chest are both real bodies.
    expect(
      auditMeasurements({ CHEST_BUST: 114, WAIST: 80 }).problems,
    ).toEqual([]);
    expect(
      auditMeasurements({ CHEST_BUST: 104, WAIST: 118 }).problems,
    ).toEqual([]);
  });

  it('names a halved girth and offers the doubled value', () => {
    const { trusted, problems } = auditMeasurements({ CHEST_BUST: 45 });
    expect(trusted.CHEST_BUST).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      key: 'CHEST_BUST',
      code: 'LIKELY_HALF_GIRTH',
      suggestedValue: 90,
    });
    expect(problems[0].message).toContain('all the way around');
  });

  it('names an inches-for-centimetres entry on a LENGTH', () => {
    // 32in inseam = 81cm. Lengths are not girths, so the halving explanation
    // must not be reached for them.
    const { problems } = auditMeasurements({ INSEAM: 32 });
    expect(problems[0]).toMatchObject({
      key: 'INSEAM',
      code: 'LIKELY_INCHES',
      suggestedValue: 81.3,
    });
  });

  it('reports a value no mistake explains as simply implausible', () => {
    const { problems } = auditMeasurements({ HEIGHT: 12 });
    expect(problems[0]).toMatchObject({ key: 'HEIGHT', code: 'IMPLAUSIBLE' });
    expect(problems[0].message).toContain('re-measure');
  });

  it('catches a pair that is impossible together though each half is fine', () => {
    // The reported profile's real defect: a 59cm shoulder cannot sit on a 90cm
    // chest, and neither number is out of range on its own.
    const { trusted, problems } = auditMeasurements({
      CHEST_BUST: 90,
      SHOULDER: 59,
    });
    expect(trusted.CHEST_BUST).toBe(90);
    expect(trusted.SHOULDER).toBeUndefined();
    expect(problems[0]).toMatchObject({
      key: 'SHOULDER',
      code: 'INCONSISTENT',
      conflictsWith: 'CHEST_BUST',
    });
  });

  it('drops the dependent measurement, never the reference', () => {
    // Chest, waist and height are the three a shopper knows from memory; a
    // coherence failure must not throw away the one they are most sure of.
    const { trusted } = auditMeasurements({ HEIGHT: 182, INSEAM: 20 });
    expect(trusted.HEIGHT).toBe(182);
    expect(trusted.INSEAM).toBeUndefined();
  });

  it('does not report the same bad number twice', () => {
    // CHEST_BUST fails plausibility, so the SHOULDER/CHEST coherence rule must
    // not also fire against it — being told two things about one value is how a
    // shopper ends up fixing neither.
    const { problems } = auditMeasurements({ CHEST_BUST: 45, SHOULDER: 59 });
    expect(problems).toHaveLength(1);
    expect(problems[0].key).toBe('CHEST_BUST');
  });

  it('ignores keys it does not size against, and non-positive values', () => {
    const { trusted, problems } = auditMeasurements({
      CHEST_BUST: 100,
      EXTRA_AGBADA_DROP: 40,
      WAIST: 0,
      HIP_SEAT: Number.NaN,
    } as unknown as Record<string, number>);
    expect(trusted).toEqual({ CHEST_BUST: 100 });
    expect(problems).toEqual([]);
  });

  it('keeps the plausible range wider than any size chart', () => {
    // The seeded INTERNATIONAL ladder tops out at a 156cm chest and a 148cm
    // waist. If the audit were tighter than the chart it would reject the very
    // shoppers the biggest rows exist for.
    expect(PLAUSIBLE_RANGE_CM.CHEST_BUST.max).toBeGreaterThan(156);
    expect(PLAUSIBLE_RANGE_CM.WAIST.max).toBeGreaterThan(148);
    expect(PLAUSIBLE_RANGE_CM.HEIGHT.max).toBeGreaterThan(200);
  });
});
