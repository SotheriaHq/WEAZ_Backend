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
var BulkUploadProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BulkUploadProcessor = void 0;
const common_1 = require("@nestjs/common");
const bullmq_1 = require("@nestjs/bullmq");
const collections_service_1 = require("../collections/collections.service");
const queue_constants_1 = require("./queue.constants");
let BulkUploadProcessor = BulkUploadProcessor_1 = class BulkUploadProcessor extends bullmq_1.WorkerHost {
    constructor(collections) {
        super();
        this.collections = collections;
        this.logger = new common_1.Logger(BulkUploadProcessor_1.name);
    }
    async process(job) {
        try {
            if (job.name === queue_constants_1.BULK_UPLOAD_PROCESS_JOB) {
                const data = job.data;
                await this.collections.processBulkUploadJob(data.jobId);
                return;
            }
            if (job.name === queue_constants_1.BULK_UPLOAD_RETRY_JOB) {
                const data = job.data;
                await this.collections.processBulkUploadRetry(data.jobId, data.ownerId, data.rowIndices ?? []);
                return;
            }
        }
        catch (error) {
            this.logger.error(`Bulk upload job failed (${job.name}): ${String(error)}`);
            throw error;
        }
    }
};
exports.BulkUploadProcessor = BulkUploadProcessor;
exports.BulkUploadProcessor = BulkUploadProcessor = BulkUploadProcessor_1 = __decorate([
    (0, bullmq_1.Processor)(queue_constants_1.BULK_UPLOAD_QUEUE),
    __metadata("design:paramtypes", [collections_service_1.CollectionsService])
], BulkUploadProcessor);
//# sourceMappingURL=bulk-upload.processor.js.map