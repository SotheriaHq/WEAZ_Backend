"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueueWorkerModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_module_1 = require("../prisma/prisma.module");
const email_module_1 = require("../email/email.module");
const upload_module_1 = require("../upload/upload.module");
const store_module_1 = require("../store/store.module");
const notifications_module_1 = require("../notifications/notifications.module");
const analytics_module_1 = require("../analytics/analytics.module");
const queue_module_1 = require("./queue.module");
const tags_module_1 = require("../tags/tags.module");
const collections_service_1 = require("../collections/collections.service");
const Helper_service_1 = require("../collections/helper/Helper.service");
const notifications_processor_1 = require("./notifications.processor");
const bulk_upload_processor_1 = require("./bulk-upload.processor");
const categories_module_1 = require("../categories/categories.module");
const image_processing_processor_1 = require("./image-processing.processor");
const media_processing_service_1 = require("../media-processing/media-processing.service");
const search_module_1 = require("../search/search.module");
const search_processor_1 = require("./search.processor");
const reviews_module_1 = require("../reviews/reviews.module");
const review_aggregate_processor_1 = require("./review-aggregate.processor");
const review_reminder_processor_1 = require("./review-reminder.processor");
const system_config_module_1 = require("../admin/system-config/system-config.module");
let QueueWorkerModule = class QueueWorkerModule {
};
exports.QueueWorkerModule = QueueWorkerModule;
exports.QueueWorkerModule = QueueWorkerModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                envFilePath: '.env',
            }),
            prisma_module_1.PrismaModule,
            email_module_1.EmailModule,
            upload_module_1.UploadModule,
            store_module_1.StoreModule,
            notifications_module_1.NotificationsModule,
            analytics_module_1.AnalyticsModule,
            queue_module_1.QueueModule,
            search_module_1.SearchModule,
            tags_module_1.TagsModule,
            categories_module_1.CategoriesModule,
            reviews_module_1.ReviewsModule,
            system_config_module_1.SystemConfigModule,
        ],
        providers: [
            collections_service_1.CollectionsService,
            Helper_service_1.HelperService,
            notifications_processor_1.NotificationsProcessor,
            bulk_upload_processor_1.BulkUploadProcessor,
            image_processing_processor_1.ImageProcessingProcessor,
            search_processor_1.SearchProcessor,
            media_processing_service_1.MediaProcessingService,
            review_aggregate_processor_1.ReviewAggregateProcessor,
            review_reminder_processor_1.ReviewReminderProcessor,
        ],
    })
], QueueWorkerModule);
//# sourceMappingURL=queue-worker.module.js.map