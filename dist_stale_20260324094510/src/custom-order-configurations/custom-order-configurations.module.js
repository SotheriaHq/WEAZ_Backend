"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomOrderConfigurationsModule = void 0;
const common_1 = require("@nestjs/common");
const prisma_module_1 = require("../prisma/prisma.module");
const custom_order_pricing_module_1 = require("../custom-order-pricing/custom-order-pricing.module");
const custom_order_configurations_controller_1 = require("./custom-order-configurations.controller");
const custom_order_configurations_service_1 = require("./custom-order-configurations.service");
let CustomOrderConfigurationsModule = class CustomOrderConfigurationsModule {
};
exports.CustomOrderConfigurationsModule = CustomOrderConfigurationsModule;
exports.CustomOrderConfigurationsModule = CustomOrderConfigurationsModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_1.PrismaModule, custom_order_pricing_module_1.CustomOrderPricingModule],
        controllers: [custom_order_configurations_controller_1.CustomOrderConfigurationsController],
        providers: [custom_order_configurations_service_1.CustomOrderConfigurationsService],
        exports: [custom_order_configurations_service_1.CustomOrderConfigurationsService],
    })
], CustomOrderConfigurationsModule);
//# sourceMappingURL=custom-order-configurations.module.js.map