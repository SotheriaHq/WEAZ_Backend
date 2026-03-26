"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessagingModule = void 0;
const common_1 = require("@nestjs/common");
const admin_audit_service_1 = require("../admin/services/admin-audit.service");
const queue_module_1 = require("../queue/queue.module");
const prisma_module_1 = require("../prisma/prisma.module");
const custom_order_messaging_buyer_controller_1 = require("./controllers/custom-order-messaging-buyer.controller");
const custom_order_messaging_brand_controller_1 = require("./controllers/custom-order-messaging-brand.controller");
const order_messaging_buyer_controller_1 = require("./controllers/order-messaging-buyer.controller");
const order_messaging_brand_controller_1 = require("./controllers/order-messaging-brand.controller");
const admin_messaging_controller_1 = require("./controllers/admin-messaging.controller");
const messaging_summary_buyer_controller_1 = require("./controllers/messaging-summary-buyer.controller");
const messaging_summary_brand_controller_1 = require("./controllers/messaging-summary-brand.controller");
const messaging_inbox_controller_1 = require("./controllers/messaging-inbox.controller");
const messaging_attachment_service_1 = require("./messaging-attachment.service");
const messaging_policy_service_1 = require("./messaging-policy.service");
const messaging_query_service_1 = require("./messaging-query.service");
const messaging_service_1 = require("./messaging.service");
const messaging_side_effects_service_1 = require("./messaging-side-effects.service");
const upload_module_1 = require("../upload/upload.module");
const custom_orders_module_1 = require("../custom-orders/custom-orders.module");
const system_config_module_1 = require("../admin/system-config/system-config.module");
let MessagingModule = class MessagingModule {
};
exports.MessagingModule = MessagingModule;
exports.MessagingModule = MessagingModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_1.PrismaModule, queue_module_1.QueueModule, upload_module_1.UploadModule, custom_orders_module_1.CustomOrdersModule, system_config_module_1.SystemConfigModule],
        controllers: [
            custom_order_messaging_buyer_controller_1.CustomOrderMessagingBuyerController,
            custom_order_messaging_brand_controller_1.CustomOrderMessagingBrandController,
            order_messaging_buyer_controller_1.OrderMessagingBuyerController,
            order_messaging_brand_controller_1.OrderMessagingBrandController,
            admin_messaging_controller_1.AdminMessagingController,
            messaging_summary_buyer_controller_1.MessagingSummaryBuyerController,
            messaging_summary_brand_controller_1.MessagingSummaryBrandController,
            messaging_inbox_controller_1.MessagingInboxController,
        ],
        providers: [
            messaging_service_1.MessagingService,
            messaging_query_service_1.MessagingQueryService,
            messaging_policy_service_1.MessagingPolicyService,
            messaging_attachment_service_1.MessagingAttachmentService,
            messaging_side_effects_service_1.MessagingSideEffectsService,
            admin_audit_service_1.AdminAuditService,
        ],
        exports: [messaging_service_1.MessagingService],
    })
], MessagingModule);
//# sourceMappingURL=messaging.module.js.map