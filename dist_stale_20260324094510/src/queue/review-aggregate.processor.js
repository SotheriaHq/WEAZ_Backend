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
var ReviewAggregateProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewAggregateProcessor = void 0;
const bullmq_1 = require("@nestjs/bullmq");
const common_1 = require("@nestjs/common");
const queue_constants_1 = require("./queue.constants");
const reviews_service_1 = require("../reviews/reviews.service");
let ReviewAggregateProcessor = ReviewAggregateProcessor_1 = class ReviewAggregateProcessor extends bullmq_1.WorkerHost {
    constructor(reviewsService) {
        super();
        this.reviewsService = reviewsService;
        this.logger = new common_1.Logger(ReviewAggregateProcessor_1.name);
    }
    async process(job) {
        this.logger.log(`Processing review aggregate job: ${job.name} id=${job.id}`);
        try {
            switch (job.name) {
                case queue_constants_1.REVIEW_AGGREGATE_PRODUCT_JOB: {
                    const { productId } = job.data;
                    await this.reviewsService.recalculateProductAggregate(productId);
                    break;
                }
                case queue_constants_1.REVIEW_AGGREGATE_BRAND_JOB: {
                    const { brandId } = job.data;
                    await this.reviewsService.recalculateBrandAggregate(brandId);
                    break;
                }
                default:
                    this.logger.warn(`Unknown review aggregate job name: ${job.name}`);
            }
        }
        catch (error) {
            this.logger.error(`Review aggregate job failed: ${job.name} id=${job.id} error=${error.message}`, error.stack);
            throw error;
        }
    }
};
exports.ReviewAggregateProcessor = ReviewAggregateProcessor;
exports.ReviewAggregateProcessor = ReviewAggregateProcessor = ReviewAggregateProcessor_1 = __decorate([
    (0, bullmq_1.Processor)(queue_constants_1.REVIEW_AGGREGATE_QUEUE),
    __metadata("design:paramtypes", [reviews_service_1.ReviewsService])
], ReviewAggregateProcessor);
//# sourceMappingURL=review-aggregate.processor.js.map