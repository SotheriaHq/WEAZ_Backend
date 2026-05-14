import { Injectable } from '@nestjs/common';
import {
  isNonLocalEnvironment,
  resolveWebAppBaseUrl,
} from '../common/utils/web-app-url';

export type BrandProfileLinkPayload = {
  publicProfileUrl: string;
  qrTargetUrl: string;
  shareUrl: string;
};

type BrandProfileLinkInput = {
  ownerId: string;
  username?: string | null;
};

const LOCAL_WEB_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

function resolvePublicWebAppBaseUrl(): string {
  const baseUrl = resolveWebAppBaseUrl();

  if (!isNonLocalEnvironment()) {
    return baseUrl;
  }

  const hostname = new URL(baseUrl).hostname.toLowerCase();
  if (LOCAL_WEB_HOSTS.has(hostname)) {
    throw new Error(
      'WEB_APP_URL (or FRONTEND_URL) must be a public web URL for non-local environments.',
    );
  }

  return baseUrl;
}

function buildAbsoluteWebUrl(path: string): string {
  return new URL(path, `${resolvePublicWebAppBaseUrl()}/`).toString();
}

@Injectable()
export class BrandProfileLinkService {
  getPublicProfileUrl({ ownerId, username }: BrandProfileLinkInput): string {
    const normalizedUsername = username?.trim();

    if (normalizedUsername) {
      return buildAbsoluteWebUrl(
        `/u/${encodeURIComponent(normalizedUsername)}`,
      );
    }

    return buildAbsoluteWebUrl(`/profile/${encodeURIComponent(ownerId)}`);
  }

  getBrandProfileLinks(input: BrandProfileLinkInput): BrandProfileLinkPayload {
    const publicProfileUrl = this.getPublicProfileUrl(input);

    return {
      publicProfileUrl,
      qrTargetUrl: publicProfileUrl,
      shareUrl: publicProfileUrl,
    };
  }
}
