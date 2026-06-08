import { resolveWebAppBaseUrl } from '../common/utils/web-app-url';
import {
  PRODUCT_BRAND_PALETTE,
  PRODUCT_CATEGORY,
  PRODUCT_NAME,
} from '../common/branding/product-identity.constants';

export const EMAIL_COLORS = {
  brandPrimary: PRODUCT_BRAND_PALETTE.deepNavy,
  brandPrimaryLight: PRODUCT_BRAND_PALETTE.softNavy,
  brandAccent: PRODUCT_BRAND_PALETTE.metallicGold,
  textPrimary: '#111827',
  textSecondary: '#374151',
  textMuted: '#6b7280',
  surfaceSoft: '#f6f4ef',
} as const;

const DEFAULT_COMPANY_NAME = PRODUCT_NAME;
const DEFAULT_HEADER_SUBTITLE = PRODUCT_CATEGORY;
const DEFAULT_COMPANY_LOGO_PATH = '/brand/weaz-logo-mark.svg';

export function normalizeCompanyName(value: string): string {
  const trimmed = String(value ?? '').trim();
  return trimmed || DEFAULT_COMPANY_NAME;
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

  return `<span style="color:${EMAIL_COLORS.brandPrimary};font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-weight:800;letter-spacing:0.45px;text-shadow:0 1px 0 rgba(147,51,234,0.18)">${safeAppName}</span>`;
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

  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:40px;height:40px;border-collapse:separate;border-spacing:0;background:${EMAIL_COLORS.brandPrimary};border-radius:12px;box-shadow:0 8px 18px rgba(107,33,168,0.28)"><tr><td align="center" valign="middle" style="width:40px;height:40px;border-radius:12px;color:#ffffff;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:17px;font-weight:800;letter-spacing:0.6px;line-height:1">${safeInitial}</td></tr></table>`;
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

  return `<a href="${safeHref}" style="display:inline-block;background:${EMAIL_COLORS.brandPrimary};color:#fff;padding:${options?.padding ?? '12px 24px'};border-radius:${options?.borderRadius ?? '12px'};text-decoration:none;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.2px;box-shadow:0 10px 20px rgba(107,33,168,0.22)">${safeLabel}</a>`;
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
    ? `<h2 style="color:${EMAIL_COLORS.textPrimary};margin:0 0 16px;font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;font-size:26px;line-height:1.18;font-weight:800;letter-spacing:-0.02em">${escapeHtml(title)}</h2>`
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
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;padding:20px 12px">
  <tr>
    <td style="padding:22px 26px;background:linear-gradient(135deg, ${EMAIL_COLORS.brandPrimary}, ${EMAIL_COLORS.brandPrimaryLight});border-radius:16px 16px 0 0">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="width:52px;vertical-align:middle">
            ${logoMarkup}
          </td>
          <td style="vertical-align:middle">
            <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.2px">${safeCompanyName}</p>
            <p style="margin:2px 0 0;color:#ede9fe;font-size:12px">${safeHeaderSubtitle}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr><td style="padding:30px 30px 26px;background:#ffffff;border-left:1px solid #e9d5ff;border-right:1px solid #e9d5ff">
    ${titleMarkup}
    ${args.bodyHtml}
  </td></tr>
  <tr><td style="padding:16px 30px;background:#faf5ff;border:1px solid #e9d5ff;border-top:none;border-radius:0 0 16px 16px">
    <p style="margin:0 0 6px;color:${EMAIL_COLORS.textMuted};font-size:12px">${safeSupportLine}</p>
    <p style="margin:0;color:${EMAIL_COLORS.textMuted};font-size:12px;line-height:1.6">${safeFooterContext}</p>
  </td></tr>
</table>
</body></html>`;
}
