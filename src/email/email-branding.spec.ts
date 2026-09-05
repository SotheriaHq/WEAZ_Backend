import {
  BRAND_COLORS,
  PRODUCT_NAME,
} from '../common/branding/product-identity.constants';
import {
  EMAIL_COLORS,
  renderEmailShell,
  resolveCompanyLogoUrl,
} from './email.branding';

/**
 * Transactional email was the last surface still dressed as the old brand.
 *
 * It drew a gold rule across the top, a gold subtitle, and — instead of the
 * logo — the company's first letter in a rounded tile, which was a fourth
 * distinct "logo" beside the two files that shipped under one filename stem.
 * Emails are the one surface nobody sees while developing, so nothing caught it.
 */
describe('email branding', () => {
  const shell = () =>
    renderEmailShell({
      appName: PRODUCT_NAME,
      title: 'Verify your email',
      bodyHtml: '<p>body</p>',
    });

  it('draws the real mark, not a letter in a tile', () => {
    const html = shell();
    expect(html).toContain(resolveCompanyLogoUrl());
    expect(html).toMatch(/<img[^>]+width="44"[^>]+height="44"/);
  });

  it('serves the mark as a raster', () => {
    // A good share of email clients strip or refuse remote SVG, which is how a
    // logo can be present in the markup and absent in the inbox.
    expect(resolveCompanyLogoUrl()).toMatch(/\.png$/);
  });

  it('leaves the logo unnamed, because the name is the text beside it', () => {
    expect(shell()).toMatch(/<img[^>]+alt=""/);
  });

  it('carries no trace of the retired gold-and-navy palette', () => {
    const html = shell().toLowerCase();
    for (const retired of ['#d8b24a', '#fff1a8', '#9f6419', '#16233f', '#4b5670', '#f4df91']) {
      expect(html).not.toContain(retired);
    }
  });

  it('takes every brand colour from the shared palette', () => {
    expect(EMAIL_COLORS.brandPrimary).toBe(BRAND_COLORS.primary);
    expect(EMAIL_COLORS.brandOnDark).toBe(BRAND_COLORS.onDark);
    expect(EMAIL_COLORS.brandDark).toBe(BRAND_COLORS.ink);
  });

  it('does not paint the light-ground violet on the dark header', () => {
    /*
     * The header block sits on `brandDark`. `brandPrimary` is 1.9:1 against it
     * — the same failure that made the old logo vanish on the dark theme — so
     * anything drawn on the header has to use `brandOnDark`.
     */
    const html = shell();
    const headerStart = html.indexOf(EMAIL_COLORS.brandDark);
    const headerEnd = html.indexOf('background:#ffffff');
    expect(headerStart).toBeGreaterThan(-1);
    expect(headerEnd).toBeGreaterThan(headerStart);

    const header = html.slice(headerStart, headerEnd);
    expect(header).not.toContain(EMAIL_COLORS.brandPrimary);
  });
});
