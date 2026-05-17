import { resolveWebAppBaseUrl } from './web-app-url';

function resolveAuthLinkBaseUrl(): string {
  return resolveWebAppBaseUrl().replace(/\/+$/, '');
}

function encodeToken(token: string): string {
  return encodeURIComponent(String(token));
}

export function sanitizeAuthNextPath(nextPath?: string | null): string | null {
  const candidate = String(nextPath ?? '').trim();
  if (!candidate) {
    return null;
  }

  if (!candidate.startsWith('/')) {
    return null;
  }

  if (candidate.startsWith('//')) {
    return null;
  }

  return candidate;
}

export function buildPasswordResetLink(token: string): string {
  return `${resolveAuthLinkBaseUrl()}/reset-password?token=${encodeToken(token)}`;
}

export function buildAdminPasswordResetLink(token: string): string {
  return `${resolveAuthLinkBaseUrl()}/admin/reset-password?token=${encodeToken(token)}`;
}

export function buildEmailVerificationLink(
  token: string,
  nextPath?: string | null,
): string {
  const sanitizedNextPath = sanitizeAuthNextPath(nextPath);
  const nextQuery = sanitizedNextPath
    ? `&next=${encodeURIComponent(sanitizedNextPath)}`
    : '';

  return `${resolveAuthLinkBaseUrl()}/verify-email?token=${encodeToken(token)}${nextQuery}`;
}

export function buildEmailChangeConfirmationLink(token: string): string {
  return `${resolveAuthLinkBaseUrl()}/change-email/confirm?token=${encodeToken(token)}`;
}
