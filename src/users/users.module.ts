import { Module } from '@nestjs/common';
import { UserProfileController } from './user-profile.controller';
import { UserProfileService } from './user-profile.service';
import { SavedItemsController } from './saved-items.controller';
import { SavedItemsService } from './saved-items.service';
import {
  PatchingController,
  UserPatchesController,
  PatchStatusBatchController,
} from './patching.controller';
import { PatchingService } from './patching.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SizeFitController } from './size-fit.controller';
import { SizeFitService } from './size-fit.service';
import { SizeFitReminderService } from './size-fit-reminder.service';
import { SizingModule } from 'src/sizing/sizing.module';
import { FeedPreferencesController } from './feed-preferences.controller';
import { FeedPreferencesService } from './feed-preferences.service';

@Module({
  imports: [PrismaModule, NotificationsModule, SizingModule],
  controllers: [
    UserProfileController,
    SavedItemsController,
    PatchingController,
    UserPatchesController,
    PatchStatusBatchController,
    SizeFitController,
    FeedPreferencesController,
  ],
  providers: [
    UserProfileService,
    SavedItemsService,
    PatchingService,
    SizeFitService,
    SizeFitReminderService,
    FeedPreferencesService,
  ],
  exports: [
    UserProfileService,
    SavedItemsService,
    PatchingService,
    SizeFitService,
  ],
})
export class UsersModule {}
