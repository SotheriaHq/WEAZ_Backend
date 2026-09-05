import { resolveWebAppBaseUrl } from '../common/utils/web-app-url';
import {
  BRAND_COLORS,
  PRODUCT_CATEGORY,
  PRODUCT_NAME,
} from '../common/branding/product-identity.constants';

/**
 * Every colour an email is allowed to use, all of them derived from the one
 * palette. `brandAccent` used to be the brand gold, which drew a gold rule
 * across the top of every transactional email while the product itself was
 * violet — two brands in one message.
 *
 * The header sits on `brandDark`, so anything drawn on it takes `brandOnDark`.
 * `brandPrimary` is for the white body only: it sits at 1.9:1 on the header
 * ground, which is the same mistake the old logo made.
 */
export const EMAIL_COLORS = {
  brandPrimary: BRAND_COLORS.primary,
  brandPrimaryStrong: BRAND_COLORS.primaryStrong,
  brandPrimaryLight: BRAND_COLORS.soft,
  brandOnDark: BRAND_COLORS.onDark,
  brandAccent: BRAND_COLORS.soft,
  brandAccentSoft: BRAND_COLORS.soft,
  brandDark: BRAND_COLORS.ink,
  brandDarkElevated: '#171226',
  textPrimary: '#111827',
  textSecondary: '#374151',
  textMuted: '#6b7280',
  surfaceSoft: '#f8f6fb',
  surfaceWarm: '#fffbeb',
  borderSoft: '#eadcff',
} as const;

const DEFAULT_COMPANY_NAME = PRODUCT_NAME;
const DEFAULT_HEADER_SUBTITLE = PRODUCT_CATEGORY;
const DEFAULT_COMPANY_LOGO_PATH = '/brand/wiez-email-logo.png';

export function normalizeCompanyName(_value: string): string {
  return DEFAULT_COMPANY_NAME;
}

export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderBrandedAppName(appName: string): string {
  const safeAppName = escapeHtml(normalizeCompanyName(appName));

  return `<span style="color:${EMAIL_COLORS.brandPrimary};font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-weight:800;letter-spacing:0.45px;text-shadow:0 1px 0 rgba(96,21,226,0.14)">${safeAppName}</span>`;
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function resolveCompanyLogoUrl(): string {
  const explicitLogoUrl = String(process.env.EMAIL_BRAND_LOGO_URL ?? '').trim();
  if (explicitLogoUrl) {
    if (isAbsoluteHttpUrl(explicitLogoUrl)) {
      return explicitLogoUrl;
    }

    if (explicitLogoUrl.startsWith('/')) {
      return `${resolveWebAppBaseUrl()}${explicitLogoUrl}`;
    }

    return explicitLogoUrl;
  }

  return `${resolveWebAppBaseUrl()}${DEFAULT_COMPANY_LOGO_PATH}`;
}

export function resolveAppUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${resolveWebAppBaseUrl()}${normalizedPath}`;
}

/**
 * The header mark.
 *
 * This drew the company's first letter in a rounded violet tile — a fourth
 * distinct "logo" alongside the two files that shipped under one filename stem
 * and the wordmark. It is the real mark now, served from the web app.
 *
 * A PNG rather than the SVG: a good share of email clients strip or refuse
 * inline and remote SVG. `alt` is empty on purpose — the company name is the
 * text immediately beside it, so naming the image repeats it to a screen
 * reader. Explicit width/height because Outlook ignores CSS sizing.
 */
function renderCompanyLogoMarkup(): string {
  const src = escapeHtml(resolveCompanyLogoUrl());

  return `<img src="${src}" width="44" height="44" alt="" style="display:block;width:44px;height:44px;border:0;outline:none;text-decoration:none">`;
}

export function renderEmailButton(
  href: string,
  label: string,
  options?: {
    padding?: string;
    borderRadius?: string;
  },
): string {
  const safeHref = escapeHtml(String(href ?? '').trim());
  const safeLabel = escapeHtml(String(label ?? '').trim());

  return `<a href="${safeHref}" style="display:inline-block;background:${EMAIL_COLORS.brandPrimary};border:1px solid ${EMAIL_COLORS.brandPrimaryStrong};color:#ffffff;padding:${options?.padding ?? '13px 24px'};border-radius:${options?.borderRadius ?? '12px'};text-decoration:none;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:800;letter-spacing:0.2px;box-shadow:0 12px 24px rgba(96,21,226,0.24)">${safeLabel}</a>`;
}

export function renderEmailShell(args: {
  appName: string;
  bodyHtml: string;
  title?: string;
  headerSubtitle?: string;
  footerContextText?: string;
  logoUrl?: string;
}): string {
  const companyName = normalizeCompanyName(args.appName);
  const safeCompanyName = escapeHtml(companyName);
  const logoMarkup = renderCompanyLogoMarkup();
  const headerSubtitle =
    String(args.headerSubtitle ?? '').trim() || DEFAULT_HEADER_SUBTITLE;
  const safeHeaderSubtitle = escapeHtml(headerSubtitle);
  const title = String(args.title ?? '').trim();
  const titleMarkup = title
    ? `<h1 style="color:${EMAIL_COLORS.textPrimary};margin:0 0 10px;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:30px;line-height:1.18;font-weight:900;letter-spacing:0">${escapeHtml(title)}</h1><div style="width:54px;height:4px;background:${EMAIL_COLORS.brandAccent};border-radius:999px;margin:0 0 22px"></div>`
    : '';

  const footerContext =
    String(args.footerContextText ?? '').trim() ||
    `This email was sent because there was activity on your ${companyName} account.`;
  const safeFooterContext = escapeHtml(footerContext);
  const safeSupportLine = escapeHtml(
    `Need help? Reply to this email and the ${companyName} support team will help.`,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;background:${EMAIL_COLORS.surfaceSoft}">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;padding:24px 12px">
  <tr>
    <td style="height:4px;background:${EMAIL_COLORS.brandAccent};border-radius:18px 18px 0 0;font-size:0;line-height:0">&nbsp;</td>
  </tr>
  <tr>
    <td style="padding:24px 28px;background:${EMAIL_COLORS.brandDark};border-radius:0">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="width:58px;vertical-align:middle">
            ${logoMarkup}
          </td>
          <td style="vertical-align:middle">
            <p style="margin:0;color:#ffffff;font-size:24px;font-weight:900;letter-spacing:0.8px;line-height:1">${safeCompanyName}</p>
            <p style="margin:6px 0 0;color:${EMAIL_COLORS.brandOnDark};font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase">${safeHeaderSubtitle}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr><td style="padding:36px 32px 30px;background:#ffffff;border-left:1px solid ${EMAIL_COLORS.borderSoft};border-right:1px solid ${EMAIL_COLORS.borderSoft}">
    ${titleMarkup}
    ${args.bodyHtml}
  </td></tr>
  <tr><td style="padding:18px 32px;background:${EMAIL_COLORS.brandDark};border:1px solid ${EMAIL_COLORS.brandDark};border-top:1px solid ${EMAIL_COLORS.brandAccent};border-radius:0 0 18px 18px">
    <p style="margin:0 0 6px;color:#e5e7eb;font-size:12px;line-height:1.6">${safeSupportLine}</p>
    <p style="margin:0;color:#aab2c0;font-size:12px;line-height:1.6">${safeFooterContext}</p>
  </td></tr>
</table>
</body></html>`;
}
