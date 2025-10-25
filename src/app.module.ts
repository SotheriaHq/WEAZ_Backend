import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaService } from './prisma/prisma.service';
import { ConfigModule } from '@nestjs/config';
import { UploadModule } from './upload/upload.module';
import { DevToolsModule } from './dev-tools/dev-tools.module';
import { BrandsModule } from './brands/brands.module';
import { FollowsModule } from './follows/follows.module';
import { CollectionsModule } from './collections/collections.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    AuthModule,
    UploadModule,
    BrandsModule,
    // Social follows (sews)
    FollowsModule,
    // Collections for brands
    CollectionsModule,
    DevToolsModule,
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService],
})
export class AppModule {}
