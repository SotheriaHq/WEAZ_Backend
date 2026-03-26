"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var NotificationsProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationsProcessor = void 0;
const common_1 = require("@nestjs/common");
const bullmq_1 = require("@nestjs/bullmq");
const notifications_service_1 = require("../notifications/notifications.service");
const queue_constants_1 = require("./queue.constants");
let NotificationsProcessor = NotificationsProcessor_1 = class NotificationsProcessor extends bullmq_1.WorkerHost {
    constructor(notifications) {
        super();
        this.notifications = notifications;
        this.logger = new common_1.Logger(NotificationsProcessor_1.name);
    }
    async process(job) {
        if (job.name !== queue_constants_1.NOTIFICATION_FANOUT_JOB)
            return;
        const { recipientIds, notificationType, actorId, payload, target, dedupeMs, } = job.data;
        const uniqueRecipients = Array.from(new Set((recipientIds || []).filter(Boolean)));
        if (uniqueRecipients.length === 0)
            return;
        const chunkSize = 25;
        for (let i = 0; i < uniqueRecipients.length; i += chunkSize) {
            const chunk = uniqueRecipients.slice(i, i + chunkSize);
            await Promise.all(chunk.map(async (recipientId) => {
                try {
                    await this.notifications.create(recipientId, notificationType, {
                        actorId,
                        payload,
                        target,
                        dedupeMs,
                    });
                }
                catch (error) {
                    this.logger.warn(`Failed notification fanout to ${recipientId}: ${String(error)}`);
                }
            }));
        }
    }
};
exports.NotificationsProcessor = NotificationsProcessor;
exports.NotificationsProcessor = NotificationsProcessor = NotificationsProcessor_1 = __decorate([
    (0, bullmq_1.Processor)(queue_constants_1.NOTIFICATIONS_QUEUE),
    __metadata("design:paramtypes", [notifications_service_1.NotificationsService])
], NotificationsProcessor);
//# sourceMappingURL=notifications.processor.js.map