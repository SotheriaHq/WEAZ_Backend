import { Injectable, Logger } from '@nestjs/common';
import { redactSensitiveLogValue } from 'src/common/utils/sensitive-log';
import {
  AlertCategory,
  OperationalAlert,
  SanitizedOperationalAlert,
} from './monitoring.types';

const MAX_BUFFERED_ALERTS = 200;

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly bufferedAlerts: SanitizedOperationalAlert[] = [];

  emitAlert(alert: OperationalAlert): SanitizedOperationalAlert {
    const sanitized = this.sanitizeAlert(alert);
    this.bufferAlert(sanitized);
    this.writeLocalLog(sanitized);
    return sanitized;
  }

  emitAuditAlert(
    alert: Omit<OperationalAlert, 'category'> & {
      category?: AlertCategory;
    },
  ): SanitizedOperationalAlert {
    return this.emitAlert({
      ...alert,
      category: alert.category ?? 'ADMIN',
    });
  }

  emitMetric(
    event: string,
    metadata: Record<string, unknown> = {},
    category: AlertCategory = 'SYSTEM',
  ): SanitizedOperationalAlert {
    return this.emitAlert({
      category,
      severity: 'info',
      event,
      message: event,
      metadata,
    });
  }

  getBufferedAlerts(): SanitizedOperationalAlert[] {
    return [...this.bufferedAlerts];
  }

  clearBufferedAlerts(): void {
    this.bufferedAlerts.splice(0, this.bufferedAlerts.length);
  }

  private sanitizeAlert(alert: OperationalAlert): SanitizedOperationalAlert {
    const metadata = redactSensitiveLogValue(alert.metadata ?? {}) as Record<
      string,
      unknown
    >;
    return {
      category: alert.category,
      severity: alert.severity,
      event: alert.event,
      message: String(alert.message || alert.event),
      correlationId: alert.correlationId ?? undefined,
      userId: alert.userId ?? undefined,
      actorId: alert.actorId ?? undefined,
      entityType: alert.entityType ?? undefined,
      entityId: alert.entityId ?? undefined,
      metadata,
      emittedAt: new Date().toISOString(),
    };
  }

  private bufferAlert(alert: SanitizedOperationalAlert): void {
    this.bufferedAlerts.push(alert);
    if (this.bufferedAlerts.length > MAX_BUFFERED_ALERTS) {
      this.bufferedAlerts.shift();
    }
  }

  private writeLocalLog(alert: SanitizedOperationalAlert): void {
    const payload = JSON.stringify({
      category: alert.category,
      event: alert.event,
      correlationId: alert.correlationId,
      userId: alert.userId,
      actorId: alert.actorId,
      entityType: alert.entityType,
      entityId: alert.entityId,
      metadata: alert.metadata,
    });

    const line = `${alert.category}.${alert.event}: ${alert.message} ${payload}`;
    switch (alert.severity) {
      case 'critical':
      case 'error':
        this.logger.error(line);
        break;
      case 'warning':
        this.logger.warn(line);
        break;
      default:
        this.logger.log(line);
        break;
    }
  }
}
