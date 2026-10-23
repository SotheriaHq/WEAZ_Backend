import { Injectable } from '@nestjs/common';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';
import { cleanText, safeUrl } from './telegram-message.format';
import { extractEventDetails, SentryEventDetails } from './sentry-alert.parser';

const SENTRY_TIMEOUT_MS = 6_000;

export type SentryIssueSummary = {
  id: string;
  shortId: string | null;
  title: string;
  level: string | null;
  count: number | null;
  userCount: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  permalink: string | null;
  project: string | null;
};

export class SentryApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SentryApiUnavailableError';
  }
}

/**
 * Read-only Sentry REST client (issue details + issue search). Optional: when
 * SENTRY_API_TOKEN / SENTRY_ORG_SLUG are absent every call throws
 * SentryApiUnavailableError and callers degrade to webhook-only data.
 */
@Injectable()
export class SentryApiClient {
  constructor(private readonly config: TelegramMonitoringConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.sentryApiToken && this.config.sentryOrgSlug);
  }

  async getIssue(issueId: string): Promise<SentryIssueSummary> {
    if (!/^\d{1,20}$/.test(issueId)) {
      throw new SentryApiUnavailableError('invalid issue id');
    }
    const issue = await this.get<any>(
      `/api/0/organizations/${encodeURIComponent(this.config.sentryOrgSlug)}/issues/${issueId}/`,
    );
    return toSummary(issue);
  }

  /**
   * Triage details from the issue's most recent event. The REST event shape
   * keeps exception/request under `entries[]`; it is folded into the webhook
   * shape so one extractor (with one set of scrubbing rules) serves both.
   */
  async getLatestEventDetails(issueId: string): Promise<SentryEventDetails> {
    if (!/^\d{1,20}$/.test(issueId)) {
      throw new SentryApiUnavailableError('invalid issue id');
    }
    const event = await this.get<any>(
      `/api/0/organizations/${encodeURIComponent(this.config.sentryOrgSlug)}/issues/${issueId}/events/latest/`,
    );
    const entries: any[] = Array.isArray(event?.entries) ? event.entries : [];
    const entry = (type: string) =>
      entries.find((candidate) => candidate?.type === type)?.data;
    return extractEventDetails({
      event_id: event?.eventID ?? event?.id,
      exception: entry('exception'),
      request: entry('request'),
      message: event?.message,
      metadata: event?.metadata,
      contexts: event?.contexts,
      tags: event?.tags,
      transaction: event?.transaction ?? event?.title,
      user: event?.user ? { id: event.user.id } : undefined,
      server_name: undefined,
      logger: undefined,
    });
  }

  /**
   * Issues matching `query` in one environment between start and end. The
   * `count`/`userCount` Sentry returns are scoped to the requested period.
   */
  async searchIssues(params: {
    query: string;
    start: Date;
    end: Date;
    environments: string[];
    sort?: 'freq' | 'date' | 'new' | 'user';
    limit?: number;
  }): Promise<SentryIssueSummary[]> {
    const search = new URLSearchParams();
    search.set('query', params.query);
    search.set('start', params.start.toISOString());
    search.set('end', params.end.toISOString());
    search.set('sort', params.sort ?? 'freq');
    search.set('limit', String(Math.min(Math.max(params.limit ?? 10, 1), 100)));
    for (const env of params.environments) search.append('environment', env);
    const issues = await this.get<any[]>(
      `/api/0/organizations/${encodeURIComponent(this.config.sentryOrgSlug)}/issues/?${search.toString()}`,
    );
    return Array.isArray(issues) ? issues.map(toSummary) : [];
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.isConfigured()) {
      throw new SentryApiUnavailableError(
        'SENTRY_API_TOKEN/SENTRY_ORG_SLUG not configured',
      );
    }
    let response: Response;
    try {
      response = await fetch(`${this.config.sentryApiBaseUrl}${path}`, {
        headers: { authorization: `Bearer ${this.config.sentryApiToken}` },
        signal: AbortSignal.timeout(SENTRY_TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      throw new SentryApiUnavailableError(
        name === 'TimeoutError'
          ? `Sentry API timed out after ${SENTRY_TIMEOUT_MS}ms`
          : `Sentry API network failure (${name})`,
      );
    }
    if (!response.ok) {
      throw new SentryApiUnavailableError(
        `Sentry API responded ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toSummary(issue: any): SentryIssueSummary {
  return {
    id: String(issue?.id ?? ''),
    shortId: issue?.shortId ? cleanText(issue.shortId, 40) : null,
    title: cleanText(issue?.title ?? issue?.metadata?.title ?? 'Untitled', 160),
    level: issue?.level ? cleanText(issue.level, 16) : null,
    count: num(issue?.count),
    userCount: num(issue?.userCount),
    firstSeen: issue?.firstSeen ? String(issue.firstSeen) : null,
    lastSeen: issue?.lastSeen ? String(issue.lastSeen) : null,
    permalink: safeUrl(issue?.permalink),
    project: issue?.project?.slug ? cleanText(issue.project.slug, 64) : null,
  };
}
