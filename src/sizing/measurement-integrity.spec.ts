import {
  auditMeasurements,
  expectedBandForHeight,
  PLAUSIBLE_RANGE_CM,
} from './measurement-integrity';

describe('auditMeasurements', () => {
  /*
    The bar for "must pass clean" is deliberately high. A false positive here is
    worse than a false negative: it tells someone their own body is wrong.
  */
  it.each([
    [
      'a large 182cm body',
      { HEIGHT: 182, CHEST_BUST: 120, WAIST: 104, HIP_SEAT: 114, SHOULDER: 49, SLEEVE_LENGTH: 66, NECK_COLLAR: 43, INSEAM: 84 },
    ],
    [
      'a slim 165cm body',
      { HEIGHT: 165, CHEST_BUST: 88, WAIST: 72, HIP_SEAT: 92, SHOULDER: 41, SLEEVE_LENGTH: 58, NECK_COLLAR: 36, INSEAM: 76 },
    ],
    [
      'a very heavy 175cm body',
      { HEIGHT: 175, CHEST_BUST: 134, WAIST: 128, HIP_SEAT: 136, SHOULDER: 50, NECK_COLLAR: 46 },
    ],
    [
      'an athletic V-taper',
      { HEIGHT: 182, CHEST_BUST: 114, WAIST: 80, HIP_SEAT: 98, SHOULDER: 48 },
    ],
    [
      'a portly build, waist wider than chest',
      { HEIGHT: 178, CHEST_BUST: 108, WAIST: 118, HIP_SEAT: 116 },
    ],
  ])('passes %s through untouched', (_label, measurements) => {
    const { trusted, problems } = auditMeasurements(measurements);
    expect(problems).toEqual([]);
    expect(trusted).toEqual(measurements);
  });

  it('asks rather than asserts, and never says what the shopper did', () => {
    const { problems } = auditMeasurements({ HEIGHT: 182, CHEST_BUST: 45 });
    const message = problems[0].message;

    expect(message).toContain('Should this be 90 cm?');
    // The reference range is what makes this checkable rather than arguable.
    expect(message).toContain('182 cm');
    expect(message).toContain('82–142 cm');
    // Phrasings that tell a shopper they were wrong about their own measuring.
    expect(message).not.toMatch(/looks like|you (typed|entered|measured)|switch your units/i);
  });

  it('only offers a correction that lands inside the height-anchored band', () => {
    /*
      The regression that made this rule necessary. A 26cm hip on a 182cm body
      was "explained" as inches and corrected to 66cm purely because 66 sits
      inside the wide GLOBAL band — the shopper accepted it and the profile
      gained a new wrong number with our name on it. 66 is nowhere near the
      84–142 a 182cm body's hip occupies, so no correction may be offered.
    */
    const { problems } = auditMeasurements({ HEIGHT: 182, HIP_SEAT: 26 });
    expect(problems[0].suggestedValue).toBeUndefined();
    expect(problems[0].message).toContain('84–142 cm');
    expect(problems[0].message).toContain('all the way around');
  });

  it('catches a value that is possible on some body but not on this one', () => {
    // 59cm shoulder is a real measurement — on nobody 182cm tall.
    const { trusted, problems } = auditMeasurements({ HEIGHT: 182, SHOULDER: 59 });
    expect(trusted.SHOULDER).toBeUndefined();
    expect(problems[0]).toMatchObject({
      key: 'SHOULDER',
      code: 'OUT_OF_PROPORTION',
      expected: { min: 35, max: 53 },
    });
  });

  it('keeps height itself, because it is the reference everything else is judged against', () => {
    const { trusted } = auditMeasurements({ HEIGHT: 182, HIP_SEAT: 26, WAIST: 56 });
    expect(trusted.HEIGHT).toBe(182);
  });

  it('offers no correction at all when height is unknown', () => {
    // With no anchor there is no band we trust enough to correct against, so
    // the shopper gets the range and the guide and no guess.
    const { problems } = auditMeasurements({ INSEAM: 32 });
    expect(problems[0].suggestedValue).toBeUndefined();
    expect(problems[0].expected).toBeUndefined();
    expect(problems[0].message).toContain('50–110 cm');
    expect(problems[0].message).toContain('an inseam');
  });

  it('ignores keys it does not size against, and non-positive values', () => {
    const { trusted, problems } = auditMeasurements({
      HEIGHT: 180,
      CHEST_BUST: 100,
      EXTRA_AGBADA_DROP: 40,
      WAIST: 0,
      HIP_SEAT: Number.NaN,
    } as unknown as Record<string, number>);
    expect(trusted).toEqual({ HEIGHT: 180, CHEST_BUST: 100 });
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

  it('bands a 4XL body inside the height-anchored chest range', () => {
    // A 156cm chest is the top of the seeded ladder. On a 182cm frame it must
    // still be believable, or the audit blocks the shoppers it exists to serve.
    const band = expectedBandForHeight('CHEST_BUST', 182);
    expect(band).not.toBeNull();
    expect(band!.max).toBeGreaterThanOrEqual(142);
    expect(156).toBeLessThanOrEqual(PLAUSIBLE_RANGE_CM.CHEST_BUST.max);
  });
});
