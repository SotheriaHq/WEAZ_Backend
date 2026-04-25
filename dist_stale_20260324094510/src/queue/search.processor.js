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
var SearchProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchProcessor = void 0;
const common_1 = require("@nestjs/common");
const bullmq_1 = require("@nestjs/bullmq");
const search_service_1 = require("../search/search.service");
const queue_constants_1 = require("./queue.constants");
let SearchProcessor = SearchProcessor_1 = class SearchProcessor extends bullmq_1.WorkerHost {
    constructor(searchService) {
        super();
        this.searchService = searchService;
        this.logger = new common_1.Logger(SearchProcessor_1.name);
    }
    async process(job) {
        if (job.name !== queue_constants_1.SEARCH_SYNC_JOB) {
            return;
        }
        try {
            await this.searchService.processSearchSyncJob(job.data);
        }
        catch (error) {
            this.logger.warn(`Failed search sync job ${job.id}: ${String(error)}`);
            throw error;
        }
    }
};
exports.SearchProcessor = SearchProcessor;
exports.SearchProcessor = SearchProcessor = SearchProcessor_1 = __decorate([
    (0, bullmq_1.Processor)(queue_constants_1.SEARCH_QUEUE),
    __metadata("design:paramtypes", [search_service_1.SearchService])
], SearchProcessor);
//# sourceMappingURL=search.processor.js.map