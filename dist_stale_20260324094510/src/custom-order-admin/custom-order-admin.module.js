"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomOrderAdminModule = void 0;
const common_1 = require("@nestjs/common");
const custom_orders_module_1 = require("../custom-orders/custom-orders.module");
const prisma_module_1 = require("../prisma/prisma.module");
const custom_order_admin_controller_1 = require("./custom-order-admin.controller");
const custom_order_admin_service_1 = require("./custom-order-admin.service");
let CustomOrderAdminModule = class CustomOrderAdminModule {
};
exports.CustomOrderAdminModule = CustomOrderAdminModule;
exports.CustomOrderAdminModule = CustomOrderAdminModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_1.PrismaModule, custom_orders_module_1.CustomOrdersModule],
        controllers: [custom_order_admin_controller_1.CustomOrderAdminController],
        providers: [custom_order_admin_service_1.CustomOrderAdminService],
    })
], CustomOrderAdminModule);
//# sourceMappingURL=custom-order-admin.module.js.map