"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomOrdersModule = void 0;
const common_1 = require("@nestjs/common");
const payment_module_1 = require("../payment/payment.module");
const prisma_module_1 = require("../prisma/prisma.module");
const queue_module_1 = require("../queue/queue.module");
const custom_order_pricing_module_1 = require("../custom-order-pricing/custom-order-pricing.module");
const system_config_module_1 = require("../admin/system-config/system-config.module");
const finance_module_1 = require("../finance/finance.module");
const custom_orders_brand_controller_1 = require("./custom-orders-brand.controller");
const custom_orders_buyer_controller_1 = require("./custom-orders-buyer.controller");
const custom_orders_payments_service_1 = require("./custom-orders-payments.service");
const custom_order_refund_service_1 = require("./custom-order-refund.service");
const custom_order_side_effects_service_1 = require("./custom-order-side-effects.service");
const custom_orders_service_1 = require("./custom-orders.service");
let CustomOrdersModule = class CustomOrdersModule {
};
exports.CustomOrdersModule = CustomOrdersModule;
exports.CustomOrdersModule = CustomOrdersModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_1.PrismaModule, payment_module_1.PaymentModule, queue_module_1.QueueModule, custom_order_pricing_module_1.CustomOrderPricingModule, system_config_module_1.SystemConfigModule, finance_module_1.FinanceModule],
        controllers: [custom_orders_buyer_controller_1.CustomOrdersBuyerController, custom_orders_brand_controller_1.CustomOrdersBrandController],
        providers: [
            custom_orders_service_1.CustomOrdersService,
            custom_orders_payments_service_1.CustomOrdersPaymentsService,
            custom_order_refund_service_1.CustomOrderRefundService,
            custom_order_side_effects_service_1.CustomOrderSideEffectsService,
        ],
        exports: [
            custom_orders_service_1.CustomOrdersService,
            custom_orders_payments_service_1.CustomOrdersPaymentsService,
            custom_order_refund_service_1.CustomOrderRefundService,
            custom_order_side_effects_service_1.CustomOrderSideEffectsService,
        ],
    })
], CustomOrdersModule);
//# sourceMappingURL=custom-orders.module.js.map