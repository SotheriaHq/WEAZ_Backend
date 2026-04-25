"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const app_controller_1 = require("./app.controller");
const app_service_1 = require("./app.service");
const auth_module_1 = require("./auth/auth.module");
const prisma_module_1 = require("./prisma/prisma.module");
const config_1 = require("@nestjs/config");
const upload_module_1 = require("./upload/upload.module");
const dev_tools_module_1 = require("./dev-tools/dev-tools.module");
const brands_module_1 = require("./brands/brands.module");
const collections_module_1 = require("./collections/collections.module");
const throttler_1 = require("@nestjs/throttler");
const events_gateway_1 = require("./realtime/events.gateway");
const analytics_module_1 = require("./analytics/analytics.module");
const posts_module_1 = require("./posts/posts.module");
const commentsv2_module_1 = require("./commentsv2/commentsv2.module");
const notifications_module_1 = require("./notifications/notifications.module");
const tags_module_1 = require("./tags/tags.module");
const categories_module_1 = require("./categories/categories.module");
const order_module_1 = require("./order/order.module");
const payout_module_1 = require("./payout/payout.module");
const store_module_1 = require("./store/store.module");
const users_module_1 = require("./users/users.module");
const schedule_1 = require("@nestjs/schedule");
const measurement_points_module_1 = require("./measurement-points/measurement-points.module");
const admin_module_1 = require("./admin/admin.module");
const email_module_1 = require("./email/email.module");
const featured_module_1 = require("./featured/featured.module");
const payment_module_1 = require("./payment/payment.module");
const search_module_1 = require("./search/search.module");
const reviews_module_1 = require("./reviews/reviews.module");
const custom_order_configurations_module_1 = require("./custom-order-configurations/custom-order-configurations.module");
const custom_orders_module_1 = require("./custom-orders/custom-orders.module");
const custom_order_admin_module_1 = require("./custom-order-admin/custom-order-admin.module");
const custom_order_ops_module_1 = require("./custom-order-ops/custom-order-ops.module");
const messaging_module_1 = require("./messaging/messaging.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                envFilePath: '.env',
            }),
            schedule_1.ScheduleModule.forRoot(),
            email_module_1.EmailModule,
            prisma_module_1.PrismaModule,
            auth_module_1.AuthModule,
            throttler_1.ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
            upload_module_1.UploadModule,
            brands_module_1.BrandsModule,
            collections_module_1.CollectionsModule,
            posts_module_1.PostsModule,
            commentsv2_module_1.CommentsV2Module,
            analytics_module_1.AnalyticsModule,
            dev_tools_module_1.DevToolsModule,
            notifications_module_1.NotificationsModule,
            tags_module_1.TagsModule,
            categories_module_1.CategoriesModule,
            order_module_1.OrderModule,
            payout_module_1.PayoutModule,
            store_module_1.StoreModule,
            users_module_1.UsersModule,
            measurement_points_module_1.MeasurementPointsModule,
            admin_module_1.AdminModule,
            featured_module_1.FeaturedModule,
            payment_module_1.PaymentModule,
            search_module_1.SearchModule,
            reviews_module_1.ReviewsModule,
            custom_order_configurations_module_1.CustomOrderConfigurationsModule,
            custom_orders_module_1.CustomOrdersModule,
            custom_order_admin_module_1.CustomOrderAdminModule,
            custom_order_ops_module_1.CustomOrderOpsModule,
            messaging_module_1.MessagingModule,
        ],
        controllers: [app_controller_1.AppController],
        providers: [app_service_1.AppService, events_gateway_1.EventsGateway],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map