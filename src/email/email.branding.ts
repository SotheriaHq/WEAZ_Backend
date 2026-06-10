import { resolveWebAppBaseUrl } from '../common/utils/web-app-url';
import {
  PRODUCT_BRAND_PALETTE,
  PRODUCT_CATEGORY,
  PRODUCT_NAME,
} from '../common/branding/product-identity.constants';

export const EMAIL_COLORS = {
  brandPrimary: '#9333EA',
  brandPrimaryStrong: '#7E22CE',
  brandPrimaryLight: '#C084FC',
  brandAccent: PRODUCT_BRAND_PALETTE.metallicGold,
  brandAccentSoft: PRODUCT_BRAND_PALETTE.highlightGold,
  brandDark: '#0B0F17',
  brandDarkElevated: '#121826',
  brandNavy: PRODUCT_BRAND_PALETTE.deepNavy,
  textPrimary: '#111827',
  textSecondary: '#374151',
  textMuted: '#6b7280',
  surfaceSoft: '#f8f6fb',
  surfaceWarm: '#fffbeb',
  borderSoft: '#eadcff',
} as const;

const DEFAULT_COMPANY_NAME = PRODUCT_NAME;
const DEFAULT_HEADER_SUBTITLE = PRODUCT_CATEGORY;
const DEFAULT_COMPANY_LOGO_PATH = '/brand/weaz-logo-mark.svg';

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

  return `<span style="color:${EMAIL_COLORS.brandPrimary};font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-weight:800;letter-spacing:0.45px;text-shadow:0 1px 0 rgba(147,51,234,0.14)">${safeAppName}</span>`;
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

function renderCompanyLogoMarkup(appName: string): string {
  const companyInitial =
    normalizeCompanyName(appName).trim().charAt(0).toUpperCase() ||
    DEFAULT_COMPANY_NAME.charAt(0);
  const safeInitial = escapeHtml(companyInitial);

  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:44px;height:44px;border-collapse:separate;border-spacing:0;background:${EMAIL_COLORS.brandPrimary};border:1px solid ${EMAIL_COLORS.brandAccent};border-radius:14px;box-shadow:0 10px 22px rgba(147,51,234,0.32)"><tr><td align="center" valign="middle" style="width:44px;height:44px;border-radius:14px;color:#ffffff;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:18px;font-weight:900;letter-spacing:0.6px;line-height:1">${safeInitial}</td></tr></table>`;
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

  return `<a href="${safeHref}" style="display:inline-block;background:${EMAIL_COLORS.brandPrimary};border:1px solid ${EMAIL_COLORS.brandPrimaryStrong};color:#ffffff;padding:${options?.padding ?? '13px 24px'};border-radius:${options?.borderRadius ?? '12px'};text-decoration:none;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:800;letter-spacing:0.2px;box-shadow:0 12px 24px rgba(147,51,234,0.24)">${safeLabel}</a>`;
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
  const logoMarkup = renderCompanyLogoMarkup(companyName);
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
            <p style="margin:6px 0 0;color:#f4df91;font-size:12px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase">${safeHeaderSubtitle}</p>
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
