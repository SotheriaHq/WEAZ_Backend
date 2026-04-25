import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { BreakGlassService } from './break-glass.service';
import { EmailService } from 'src/email/email.service';
import { breakGlassCodeEmail } from 'src/email/email.templates';

@Injectable()
export class BreakGlassCronService {
  private readonly logger = new Logger(BreakGlassCronService.name);

  constructor(
    private readonly breakGlassService: BreakGlassService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async rotateDailyBreakGlassCode() {
    const rawCode = await this.breakGlassService.generateDailyCode();
    await this.breakGlassService.pruneExpiredRecoveryTokens();

    const recoveryEmail = this.config.get<string>('BREAK_GLASS_RECOVERY_EMAIL');
    if (recoveryEmail) {
      const email = breakGlassCodeEmail(rawCode, this.emailService.getAppName());
      await this.emailService.send(recoveryEmail, email.subject, email.html, email.text);
      this.logger.log('Daily break-glass code rotated and delivered via email.');
    } else {
      this.logger.warn(
        'Daily break-glass code rotated but BREAK_GLASS_RECOVERY_EMAIL is not set. Code not delivered.',
      );
    }
  }
}
