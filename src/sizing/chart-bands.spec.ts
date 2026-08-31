import {
  applyBodyBands,
  bandsFor,
  inseamLengthClass,
  sleeveLengthClass,
} from './chart-bands';

describe('chart-bands', () => {
  it('designates a 90 cm chest as S on the men EN table and M on the women table', () => {
    const men = bandsFor('UK', 'MEN');
    const women = bandsFor('UK', 'WOMEN');
    expect(men.S.chestBust[0]).toBeLessThanOrEqual(90);
    expect(men.S.chestBust[1]).toBeGreaterThanOrEqual(90);
    expect(women.M.chestBust[0]).toBeLessThanOrEqual(90);
    expect(women.M.chestBust[1]).toBeGreaterThanOrEqual(90);
    expect(90 < men.M.chestBust[0]).toBe(true);
  });

  it('keeps a US 50–52 inch (127–132 cm) chest inside XXL, not 3XL', () => {
    const us = bandsFor('US', 'MEN');
    expect(us.XXL.chestBust[0]).toBeLessThanOrEqual(127);
    expect(us.XXL.chestBust[1]).toBeGreaterThanOrEqual(132);
    expect(us['3XL'].chestBust[0]).toBeGreaterThan(132);
  });

  it('overlays girth columns and leaves length columns on the row', () => {
    const rows = [
      {
        sizeLabel: 'S',
        chestBustMinCm: 84,
        chestBustMaxCm: 91,
        sleeveLengthMinCm: 56,
        sleeveLengthMaxCm: 60,
        shoulderMinCm: 37,
        shoulderMaxCm: 40,
      },
    ];
    const next = applyBodyBands(rows, 'UK', 'MEN');
    expect(next[0].chestBustMinCm).toBe(86);
    expect(next[0].chestBustMaxCm).toBe(94);
    expect(next[0].sleeveLengthMinCm).toBe(56);
    expect(next[0].shoulderMinCm).toBe(37);
  });

  it('classifies sleeve and inseam as length, not size', () => {
    expect(sleeveLengthClass(71)).toBe('LONG');
    expect(sleeveLengthClass(62)).toBe('REGULAR');
    expect(inseamLengthClass(85)).toBe('LONG');
    expect(inseamLengthClass(80)).toBe('REGULAR');
  });
});
