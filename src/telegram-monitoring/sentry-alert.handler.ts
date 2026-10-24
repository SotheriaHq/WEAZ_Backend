import { Injectable, Logger } from '@nestjs/common';
import { stableId } from './monitoring-keys';
import {
  NormalizedSentryAlert,
  SentryEventDetails,
  sentrySeverity,
} from './sentry-alert.parser';
import { SentryApiClient, SentryIssueSummary } from './sentry-api.client';
import { renderMessage, safeUrl } from './telegram-message.format';
import {
  describe,
  DeliveryOutcome,
  TelegramDeliveryService,
} from './telegram-delivery.service';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';

/** Same issue + rule + level within this window is one message, not many. */
const REPEAT_SUPPRESSION_SECONDS = 30 * 60;

export type SentryHandleOutcome =
  | DeliveryOutcome
  | { status: 'suppressed' | 'ignored'; reason: string };

@Injectable()
export class SentryAlertHandler {
  private readonly logger = new Logger(SentryAlertHandler.name);

  constructor(
    private readonly config: TelegramMonitoringConfig,
    private readonly delivery: TelegramDeliveryService,
    private readonly sentryApi: SentryApiClient,
  ) {}

  /** Environment gate, shared by the webhook controller and the processor. */
  belongsHere(alert: NormalizedSentryAlert): boolean {
    const allowed = this.config.sentryAlertEnvironments;
    if (!alert.environment) return false;
    return allowed.includes(alert.environment.toLowerCase());
  }

  async handle(
    alert: NormalizedSentryAlert,
    idempotencyId: string,
  ): Promise<SentryHandleOutcome> {
    if (!this.belongsHere(alert)) {
      return {
        status: 'ignored',
        reason: `environment ${alert.environment ?? 'unknown'} not forwarded`,
      };
    }

    // Level is part of the key: an issue escalating error → fatal, a metric
    // alert going warning → critical, or a resolve are NEW information and
    // always pass. Only the identical alert repeating is held back.
    const repeatKey = stableId(
      'sentry-repeat',
      alert.resource,
      alert.issueId ?? alert.title,
      alert.ruleName,
      alert.level,
      alert.resource === 'metric_alert' ? alert.action : '',
    );
    const fresh = await this.delivery.acquireCooldown(
      repeatKey,
      REPEAT_SUPPRESSION_SECONDS,
    );
    if (!fresh) {
      return {
        status: 'suppressed',
        reason: 'same alert delivered within 30 minutes',
      };
    }

    const issue = await this.enrichIssue(alert);
    const details =
      alert.details?.endpoint || alert.details?.errorType
        ? alert.details
        : await this.enrichLatestEvent(alert, alert.details);
    const text = this.render(alert, issue, details);
    try {
      return await this.delivery.deliverOnce(idempotencyId, text);
    } catch (error) {
      // Otherwise the BullMQ retry of THIS alert would be "suppressed" by the
      // marker we just set, and the alert would be lost.
      await this.delivery.releaseCooldown(repeatKey);
      throw error;
    }
  }

  private async enrichIssue(
    alert: NormalizedSentryAlert,
  ): Promise<SentryIssueSummary | null> {
    if (
      !alert.issueId ||
      alert.resource === 'metric_alert' ||
      !this.sentryApi.isConfigured()
    )
      return null;
    try {
      return await this.sentryApi.getIssue(alert.issueId);
    } catch (error) {
      this.logger.warn(`Sentry issue enrichment skipped: ${describe(error)}`);
      return null;
    }
  }

  private async enrichLatestEvent(
    alert: NormalizedSentryAlert,
    fallback: SentryEventDetails | null,
  ): Promise<SentryEventDetails | null> {
    if (
      !alert.issueId ||
      alert.resource === 'metric_alert' ||
      !this.sentryApi.isConfigured()
    )
      return fallback;
    try {
      return await this.sentryApi.getLatestEventDetails(alert.issueId);
    } catch (error) {
      this.logger.warn(
        `Sentry latest-event enrichment skipped: ${describe(error)}`,
      );
      return fallback;
    }
  }

  render(
    alert: NormalizedSentryAlert,
    issue: SentryIssueSummary | null,
    details: SentryEventDetails | null,
  ): string {
    const severity = sentrySeverity(alert.level);
    const kind =
      alert.resource === 'metric_alert'
        ? `Metric alert ${alert.action}`
        : alert.resource === 'issue'
          ? `Issue ${alert.action}`
          : 'Issue alert';
    const issueLink = issue?.permalink ?? this.issueUrl(alert);
    const eventLink = alert.resource === 'event_alert' ? alert.webUrl : null;
    const endpoint = details?.endpoint
      ? `${details.method ? `${details.method} ` : ''}${details.endpoint}`
      : null;

    return renderMessage(
      {
        environment: this.config.environment,
        severity,
        title: `Sentry ${alert.level.toUpperCase()}: ${alert.title}`,
        summary: alert.culprit ?? alert.description,
        fields: [
          ['Project', issue?.project ?? alert.project],
          ['Sentry environment', alert.environment],
          ['Trigger', [kind, alert.ruleName].filter(Boolean).join(' — ')],
          [
            'Issue',
            issue?.shortId
              ? `${issue.shortId} (${alert.issueId})`
              : alert.issueId,
          ],
          ['Occurrences', issue?.count ?? 'unavailable (no Sentry API token)'],
          [
            'Users affected',
            issue?.userCount ?? 'unavailable (no Sentry API token)',
          ],
          ['Release', alert.release],
        ],
        sections: details
          ? [
              {
                heading: '🧭 Request',
                fields: [
                  ['Endpoint', endpoint],
                  ['Response status', details.statusCode],
                  ['Transaction', details.transaction],
                  ['Request ID', details.requestId],
                  ['Server', details.serverName],
                ],
              },
              {
                heading: '🧩 Error',
                fields: [
                  ['Type', details.errorType],
                  ['Message', details.errorMessage],
                  ['Location', details.inAppFrame],
                  ['Handled', details.handled],
                  ['Mechanism', details.mechanism],
                  ['Logger', details.logger],
                ],
              },
              {
                heading: '💻 Context',
                fields: [
                  ['Runtime', details.runtime],
                  ['OS', details.os],
                  ['Browser', details.browser],
                  ['Device', details.device],
                  ['User ID', details.userId],
                  ['Event ID', details.eventId],
                ],
              },
            ]
          : [],
        timeline: [
          ['This event', alert.occurredAt],
          ['First seen', issue?.firstSeen],
          ['Last seen', issue?.lastSeen],
        ],
        links: [
          ['Issue', issueLink],
          ['This event', eventLink],
          ['Alert', alert.resource === 'metric_alert' ? alert.webUrl : null],
        ],
      },
      {
        includeIdentity: this.config.includeUserIdentity,
        timeZone: this.config.reportTimeZone,
      },
    );
  }

  private issueUrl(alert: NormalizedSentryAlert): string | null {
    if (alert.webUrl) {
      // Event URLs look like …/issues/<id>/events/<eventId>/; trim to the issue.
      const trimmed = alert.webUrl.replace(/\/events\/[^/]+\/?$/, '/');
      return safeUrl(trimmed);
    }
    if (alert.issueId && this.config.sentryOrgSlug) {
      return safeUrl(
        `https://${this.config.sentryOrgSlug}.sentry.io/issues/${alert.issueId}/`,
      );
    }
    return null;
  }
}
