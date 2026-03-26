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
var ReviewReminderProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewReminderProcessor = void 0;
const bullmq_1 = require("@nestjs/bullmq");
const common_1 = require("@nestjs/common");
const queue_constants_1 = require("./queue.constants");
const reviews_service_1 = require("../reviews/reviews.service");
let ReviewReminderProcessor = ReviewReminderProcessor_1 = class ReviewReminderProcessor extends bullmq_1.WorkerHost {
    constructor(reviewsService) {
        super();
        this.reviewsService = reviewsService;
        this.logger = new common_1.Logger(ReviewReminderProcessor_1.name);
    }
    async process(job) {
        if (job.name !== queue_constants_1.REVIEW_REMINDER_JOB) {
            this.logger.warn(`Unknown review reminder job name: ${job.name}`);
            return;
        }
        try {
            const summary = await this.reviewsService.processDueReviewReminders();
            this.logger.log(`Review reminder job complete: processed=${summary.processed} sent=${summary.sent} skipped=${summary.skipped} failed=${summary.failed}`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'unknown error';
            this.logger.error(`Review reminder job failed: id=${job.id} error=${message}`, error instanceof Error ? error.stack : undefined);
            throw error;
        }
    }
};
exports.ReviewReminderProcessor = ReviewReminderProcessor;
exports.ReviewReminderProcessor = ReviewReminderProcessor = ReviewReminderProcessor_1 = __decorate([
    (0, bullmq_1.Processor)(queue_constants_1.REVIEW_REMINDER_QUEUE),
    __metadata("design:paramtypes", [reviews_service_1.ReviewsService])
], ReviewReminderProcessor);
//# sourceMappingURL=review-reminder.processor.js.map