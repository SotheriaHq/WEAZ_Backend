import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private readonly fromAddress: string;
  private readonly appName: string;

  constructor(private readonly config: ConfigService) {
    this.fromAddress = config.get<string>('DEFAULT_MAILER', 'noreply@threadly.app');
    this.appName = config.get<string>('APP_NAME', 'Threadly');

    const host = config.get<string>('SMTP_HOST');
    const port = Number(config.get<string>('SMTP_PORT', '587'));
    const user = config.get<string>('SMTP_USER');
    const pass = config.get<string>('SMTP_PASS');

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      this.logger.log(`Email transport configured: ${host}:${port}`);
    } else {
      this.logger.warn(
        'SMTP credentials not configured — emails will be logged to console only',
      );
    }
  }

  async send(
    to: string,
    subject: string,
    html: string,
    text?: string,
  ): Promise<void> {
    if (!this.transporter) {
      this.logger.log(`[EMAIL-DEV] To: ${to} | Subject: ${subject}`);
      this.logger.debug(`[EMAIL-DEV] Body:\n${text || '(html only)'}`);
      return;
    }

    try {
      await this.transporter.sendMail({
        from: `"${this.appName}" <${this.fromAddress}>`,
        to,
        subject,
        html,
        text: text || undefined,
      });
      this.logger.log(`Email sent to ${to}: "${subject}"`);
    } catch (error: any) {
      this.logger.error(`Failed to send email to ${to}: ${error.message}`);
      // Don't throw — email failures should not break business flows
    }
  }

  getAppName(): string {
    return this.appName;
  }
}
