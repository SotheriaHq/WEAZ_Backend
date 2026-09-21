import { Module } from '@nestjs/common';
import { PayoutController } from './payout.controller';
import { PayoutService } from './payout.service';
import { FinanceModule } from 'src/finance/finance.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import { PasswordService } from 'src/auth/helper/password.service';

/*
  `PasswordService` is provided directly rather than by importing AuthModule.
  It hashes and verifies the payout confirmation code, and it has no
  constructor dependencies of its own — it is a thin argon2 wrapper. Pulling in
  the whole of AuthModule to reach it would add an import edge between two large
  modules for no benefit, and this repo has already lost the worker to a
  circular import once.

  `EmailService` needs no wiring at all: EmailModule is @Global.
*/

@Module({
  imports: [FinanceModule, PrismaModule],
  controllers: [PayoutController],
  providers: [
    PayoutService,
    BrandPermissionService,
    AdminAuditService,
    PasswordService,
  ],
})
export class PayoutModule {}
