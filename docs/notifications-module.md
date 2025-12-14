# Notifications Module Documentation

## Overview

The Notifications Module is a core component of the Threadly backend application responsible for managing user notifications. It handles creation, storage, retrieval, real-time broadcasting, and user interactions with notifications. The module supports various notification types (e.g., login, signup, likes, comments) and ensures secure, performant, and scalable notification delivery.

> [!IMPORTANT]
> **Multi-Target Notification Pattern RFC**: For the comprehensive architectural design of the notification system including multi-target click zones, deep-link resolution, accessibility, and frontend component architecture, see the implementation plan maintained by the frontend team.
>
> Frontend Files:
> - `fthreadly/src/types/notificationTypes.ts` - Type registry (single source of truth)
> - `fthreadly/src/utils/notificationAdapter.ts` - Backward compatibility layer
> - `fthreadly/src/utils/notificationRouting.ts` - Centralized routing
> - `fthreadly/src/utils/notificationTelemetry.ts` - Analytics hooks
> - `fthreadly/src/components/notifications/` - UI components

## Architecture

The module follows a clean architecture pattern with separation of concerns:
- **Controller**: Handles HTTP requests and responses
- **Service**: Contains business logic and database operations
- **Registry**: Manages notification type configurations
- **DTOs**: Define request/response structures
- **Types**: Define TypeScript interfaces
- **Module**: Configures dependency injection

## Files and Their Functions

### 1. `notifications.service.ts`
**Purpose**: Core business logic for notification operations.

**Key Functions**:
- `create()`: Creates and stores notifications with validation, deduplication, and real-time emission
- `list()`: Retrieves paginated notifications for a user
- `unreadCount()`: Returns cached count of unread notifications
- `markRead()` / `markAllRead()`: Updates read status and invalidates cache

**Connections**:
- Uses `PrismaService` for database operations
- Integrates with `EventsGateway` for WebSocket broadcasting
- Depends on `NotificationRegistry` for type configurations
- Uses Redis cache via `CACHE_MANAGER` for performance

**Flow Integration**: Called by other services (e.g., auth, collections) to create notifications. Emits events to connected clients.

### 2. `notifications.controller.ts`
**Purpose**: REST API endpoints for notification operations.

**Endpoints**:
- `GET /notifications`: List user's notifications with pagination
- `GET /notifications/unread-count`: Get unread count
- `PATCH /notifications/:id/read`: Mark single notification as read
- `POST /notifications/mark-all-read`: Mark all as read (rate-limited)

**Connections**:
- Uses `NotificationsService` for business logic
- Protected by `JwtAuthGuard` for authentication
- Rate-limited using `@Throttle` decorator

**Flow Integration**: Receives HTTP requests from clients, delegates to service, returns responses.

### 3. `notifications.module.ts`
**Purpose**: NestJS module configuration for dependency injection.

**Providers**:
- `NotificationsService`
- `PrismaService`
- `EventsGateway`
- `NotificationRegistry` (factory-created with defaults)

**Connections**:
- Exports `NotificationsService` for use by other modules
- Imports cache and other shared services implicitly

**Flow Integration**: Bootstraps the module and its dependencies.

### 4. `notifications.types.ts`
**Purpose**: TypeScript type definitions.

**Key Types**:
- `TargetType`: Enum for notification targets (POST, COLLECTION, etc.)
- `CreateNotificationOptions`: Interface for notification creation parameters

**Connections**:
- Used by service and other modules for type safety

**Flow Integration**: Ensures type safety across the notification system.

### 5. `dto.ts`
**Purpose**: Data Transfer Objects for API validation.

**Classes**:
- `ListNotificationsQueryDto`: Validates query parameters for listing
- `MarkReadDto`: Placeholder for future use

**Connections**:
- Used by controller for request validation via `class-validator`

**Flow Integration**: Ensures incoming data is valid before processing.

### 6. `notifications.registry.ts`
**Purpose**: Centralized configuration for notification types.

**Key Features**:
- `NotificationConfig` interface: Defines schema, formatter, and type
- `register()`: Adds new notification types at runtime
- `getConfig()`: Retrieves configuration for a type
- `createDefault()`: Pre-registers all existing types

**Connections**:
- Injected into `NotificationsService` for validation and formatting
- Allows dynamic extension without code changes

**Flow Integration**: Provides schemas for payload validation and formatters for message generation.

### 7. `notifications.service.spec.ts`
**Purpose**: Unit tests for the notification service.

**Test Coverage**:
- Service instantiation
- Notification listing with pagination
- Unread count caching
- Mark as read operations
- Notification creation with validation and deduplication
- Error handling for invalid payloads

**Connections**:
- Mocks dependencies (Prisma, Events, Cache, Registry)
- Ensures reliability and prevents regressions

**Flow Integration**: Validates that the service behaves correctly in isolation.

## Notification Flow

### 1. Creation Flow
1. **Trigger**: Another service (e.g., `AuthService`) calls `NotificationsService.create()`
2. **Validation**: Registry validates payload against type schema
3. **Deduplication**: Checks for recent similar notifications
4. **Storage**: Saves to database with proper relations
5. **Caching**: Invalidates unread count cache
6. **Broadcasting**: Emits WebSocket event to user's room
7. **Logging**: Records creation details for monitoring

### 2. Retrieval Flow
1. **Request**: Client calls `GET /notifications` with pagination params
2. **Authentication**: JWT guard verifies user
3. **Query**: Service fetches from database with filters
4. **Formatting**: Applies message formatters to each notification
5. **Response**: Returns paginated list with metadata

### 3. Read Status Flow
1. **Request**: Client marks notifications as read
2. **Update**: Service updates database
3. **Cache**: Invalidates unread count cache
4. **Response**: Confirms success

### 4. Real-time Flow
1. **Connection**: Client connects via WebSocket
2. **Room Join**: Joins user-specific room (`USER:{userId}`)
3. **Emission**: Service emits events when notifications are created
4. **Reception**: Client receives and updates UI instantly

## Database Schema

The `Notification` model includes:
- `id`: UUID primary key
- `recipientId`: Foreign key to User
- `actorId`: Optional foreign key to User
- `type`: NotificationType enum
- `payload`: JSON field for type-specific data
- `isRead`: Boolean flag
- `createdAt`: Timestamp

Indexes on `recipientId`, `recipientId + isRead`, `recipientId + createdAt` for performance.

## Security Considerations

- JWT authentication on all endpoints
- Payload sanitization before WebSocket emission (removes sensitive data)
- Rate limiting on bulk operations
- Input validation via DTOs and Joi schemas
- Authorization checks ensure users only access their notifications

## Performance Optimizations

- Redis caching for unread counts (5-minute TTL)
- Database indexes for efficient queries
- Pagination to limit response sizes
- Deduplication to prevent spam
- Lazy loading of related data

## Extensibility

The registry pattern allows adding new notification types by:
1. Defining a new `NotificationType` in Prisma schema
2. Creating a config with schema and formatter
3. Registering it in the registry factory

This enables feature development without touching core notification logic.


A. Explanation for Junior Developer
1. Future-Proofing: NotificationRegistry Class
What it is: Imagine you have a toy box where you keep different types of toys. Each toy has its own rules (like "this toy needs batteries" or "this toy makes this sound"). The NotificationRegistry is like that toy box for notifications. Instead of hardcoding all the notification types directly in the code, we put them in this registry.

Why we added it:

Easy to add new notifications: If we want to add a new type like "user mentioned you in a comment", we just add a new entry to the registry without changing the main code.
No code changes needed: We can configure new notifications at runtime (when the app starts) instead of recompiling.
Better organization: All notification logic (validation rules and message formatting) is in one place, making it easier to maintain.
Future-proof: As the app grows, we can add new features without touching the core notification system.
Example: Before, if we added a new notification type, we'd have to add if (type === 'NEW_TYPE') everywhere. Now, we just call registry.register(newConfig) and it's done.

2. Added Logging and Monitoring
What it is: Logging is like keeping a diary of what the app is doing. Every time something important happens (like creating a notification), we write it down. Monitoring means we can check these logs to see if everything is working correctly.

Why we added it:

Debugging: If something goes wrong, we can look at the logs to see exactly what happened and when.
Auditing: We can track who did what (like "user X created notification Y at time Z").
Performance monitoring: We can see how long things take and if there are bottlenecks.
Security: We can detect unusual patterns, like someone trying to spam notifications.
Production safety: In a live app, logs help us understand issues without having to guess.
Example: Instead of just create(notification), we now do console.log('Creating notification:', details) so we know exactly what's happening.

B. Documentation File Created
I've created a comprehensive documentation file at bthreadly/docs/notifications-module.md that covers:

Module overview and architecture
Detailed description of each file and its responsibilities
How files connect to each other and the broader system
Complete notification flow from creation to delivery
Database schema and performance considerations
Security measures and extensibility patterns