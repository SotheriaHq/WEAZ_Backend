import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard } from './guard/app-throttler.guard';
import { RedisThrottlerStorage } from './guard/redis-throttler.storage';

@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: new RedisThrottlerStorage(config),
        // Every throttler listed here applies to every route, and @Throttle
        // overrides only the one it names. A shorter window would also cap
        // the routes that are deliberately allowed more, such as signed URLs.
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class RateLimitingModule {}
