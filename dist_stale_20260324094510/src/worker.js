"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const queue_worker_module_1 = require("./queue/queue-worker.module");
async function bootstrap() {
    const app = await core_1.NestFactory.createApplicationContext(queue_worker_module_1.QueueWorkerModule, {
        logger: ['log', 'warn', 'error'],
    });
    await app.init();
    const shutdown = async () => {
        await app.close();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
void bootstrap();
//# sourceMappingURL=worker.js.map