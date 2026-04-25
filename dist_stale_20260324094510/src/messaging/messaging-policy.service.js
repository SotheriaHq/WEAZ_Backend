"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessagingPolicyService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
let MessagingPolicyService = class MessagingPolicyService {
    constructor() {
        this.customOrderWritable = new Set([
            client_1.CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
            client_1.CustomOrderStatus.ACCEPTED,
            client_1.CustomOrderStatus.IN_PRODUCTION,
            client_1.CustomOrderStatus.READY_FOR_DISPATCH,
            client_1.CustomOrderStatus.IN_TRANSIT,
            client_1.CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
            client_1.CustomOrderStatus.DELIVERY_ISSUE_REPORTED,
            client_1.CustomOrderStatus.REFUND_IN_PROGRESS,
            client_1.CustomOrderStatus.DISPUTED,
        ]);
        this.standardOrderWritable = new Set([
            client_1.OrderStatus.PENDING,
            client_1.OrderStatus.PROCESSING,
            client_1.OrderStatus.SHIPPED,
        ]);
    }
    resolveThreadStatusForCustomOrder(status) {
        return this.customOrderWritable.has(status)
            ? client_1.MessageThreadStatus.OPEN
            : client_1.MessageThreadStatus.READ_ONLY;
    }
    resolveThreadStatusForOrder(status) {
        return this.standardOrderWritable.has(status)
            ? client_1.MessageThreadStatus.OPEN
            : client_1.MessageThreadStatus.READ_ONLY;
    }
    assertCanSend(status) {
        if (status !== client_1.MessageThreadStatus.OPEN) {
            throw new common_1.ForbiddenException('Thread is read-only');
        }
    }
    buildContextFilter(contextType, contextId) {
        return contextType === client_1.MessageContextType.CUSTOM_ORDER
            ? { contextType, customOrderId: contextId }
            : { contextType, orderId: contextId };
    }
};
exports.MessagingPolicyService = MessagingPolicyService;
exports.MessagingPolicyService = MessagingPolicyService = __decorate([
    (0, common_1.Injectable)()
], MessagingPolicyService);
//# sourceMappingURL=messaging-policy.service.js.map