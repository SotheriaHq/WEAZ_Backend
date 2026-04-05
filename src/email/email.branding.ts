import { resolveWebAppBaseUrl } from '../common/utils/web-app-url';

export const EMAIL_COLORS = {
  brandPrimary: '#6b21a8',
  brandPrimaryLight: '#9333ea',
  brandAccent: '#d4af37',
  textPrimary: '#111827',
  textSecondary: '#374151',
  textMuted: '#6b7280',
  surfaceSoft: '#f5f3ff',
} as const;

const DEFAULT_COMPANY_NAME = 'Threadly';
const DEFAULT_HEADER_SUBTITLE = "Africa's fashion social commerce community";
const DEFAULT_COMPANY_LOGO_PATH = '/threadly-logo-mark.png';

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

  return `<span style="color:${EMAIL_COLORS.brandPrimary};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-weight:800;letter-spacing:0.35px;text-shadow:0 1px 0 rgba(147,51,234,0.2)">${safeAppName}</span>`;
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function renderInlineThreadlyLogoMarkup(): string {
  return `<svg width="40" height="40" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;width:40px;height:40px;object-fit:contain">
    <defs>
      <linearGradient id="threadly-logo-gradient-email" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#9333ea" />
        <stop offset="0.5" stop-color="#d4af37" />
        <stop offset="1" stop-color="#6b21a8" />
      </linearGradient>
    </defs>
    <path d="M8 20C8 16.5 13 16.5 13 13C13 9.5 8 9.5 8 13" stroke="url(#threadly-logo-gradient-email)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M24 12C24 15.5 19 15.5 19 19C19 22.5 24 22.5 24 19" stroke="url(#threadly-logo-gradient-email)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="16" cy="16" r="2.5" fill="url(#threadly-logo-gradient-email)" />
  </svg>`;
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

function renderCompanyLogoMarkup(logoUrl?: string): string {
  const preferred = String(logoUrl ?? '').trim() || resolveCompanyLogoUrl();
  const safeUrl = escapeHtml(preferred);

  // Most major email clients (including Gmail) are inconsistent with inline SVG,
  // so prefer a hosted raster logo for reliability.
  if (safeUrl) {
    return `<img src="${safeUrl}" width="40" height="40" alt="${escapeHtml(DEFAULT_COMPANY_NAME)} logo" style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;object-fit:contain" />`;
  }

  return renderInlineThreadlyLogoMarkup();
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

  return `<a href="${safeHref}" style="display:inline-block;background:${EMAIL_COLORS.brandPrimary};color:#fff;padding:${options?.padding ?? '12px 24px'};border-radius:${options?.borderRadius ?? '10px'};text-decoration:none;font-weight:700;box-shadow:0 8px 20px rgba(107,33,168,0.25)">${safeLabel}</a>`;
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
  const logoMarkup = renderCompanyLogoMarkup(args.logoUrl);
  const headerSubtitle =
    String(args.headerSubtitle ?? '').trim() || DEFAULT_HEADER_SUBTITLE;
  const safeHeaderSubtitle = escapeHtml(headerSubtitle);
  const title = String(args.title ?? '').trim();
  const titleMarkup = title
    ? `<h2 style="color:${EMAIL_COLORS.textPrimary};margin:0 0 16px;font-size:24px;line-height:1.25">${escapeHtml(title)}</h2>`
    : '';

  const footerContext =
    String(args.footerContextText ?? '').trim() ||
    `This email was sent because there was activity on your ${companyName} account.`;
  const safeFooterContext = escapeHtml(footerContext);
  const safeSupportLine = escapeHtml(
    `Need help getting started? Reach out to the ${companyName} support team anytime.`,
  );

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:${EMAIL_COLORS.surfaceSoft}">
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
