# Threadly Backend — Agent Context

> You are in `bthreadly/` — the NestJS API. See root `CODEMAP.md` for task routing.

## Stack

NestJS + TypeScript + Prisma + PostgreSQL + Redis + BullMQ + Socket.io + S3 (AWS)

## Architecture

- **Entry**: `src/main.ts` (bootstrap, CORS, security headers, Swagger, graceful shutdown)
- **Root module**: `src/app.module.ts` (imports 34 feature modules)
- **Database**: `prisma/schema.prisma` — single source of truth, 100+ models, 50+ enums
- **Workers**: `src/worker.ts` — separate BullMQ worker process (`npm run dev:worker`)
- **Global modules**: PrismaModule, ConfigModule (auto-injected everywhere)
- **Rate limiting**: ThrottlerModule — 120 req/min global, tiered per endpoint

## Patterns to Follow

- **Module structure**: Each domain has `module.ts`, `controller.ts`, `service.ts`, plus DTOs
- **Auth guards**: `@UseGuards(JwtAuthGuard)` default; `@Public()` for open endpoints; `@Roles('ADMIN')` for restricted
- **Response format**: All responses wrapped by `TransformInterceptor` — `{ data, message, statusCode }`
- **Pagination**: Cursor-based preferred for feeds; offset-based for admin lists
- **Idempotency**: Payment and custom order ops use idempotency keys
- **Notifications**: Via outbox pattern — write to outbox table, worker processes async
- **File uploads**: Client gets presigned S3 URL, uploads directly, then confirms — server never handles file bytes
- **Image variants**: Upload triggers BullMQ job → Sharp generates thumb/card/detail/zoom/avatar/banner in AVIF/WEBP/JPEG

## Commands

```bash
npm run dev          # API in watch mode (ts-node)
npm run dev:worker   # BullMQ worker in watch mode
npm run dev:all      # Both concurrently
npm run build        # Production build → dist/
npm run start:prod   # Run production build
npx prisma migrate dev    # Apply schema changes
npx prisma studio         # Visual DB browser
npx prisma db seed        # Seed data
```

## Key Files

| What | Where |
|---|---|
| Bootstrap & config | `src/main.ts` |
| Module registry | `src/app.module.ts` |
| Database schema | `prisma/schema.prisma` |
| Auth logic | `src/auth/auth.service.ts` |
| JWT strategy | `src/auth/strategies/jwt.strategy.ts` |
| Global guards | `src/common/guards/` |
| Global filters | `src/common/filters/` |
| WebSocket gateway | `src/realtime/events.gateway.ts` |
| BullMQ worker | `src/worker.ts`, `src/queue/` |
| Email templates | `src/email/` |
| Env config | `.env` (never commit) |
