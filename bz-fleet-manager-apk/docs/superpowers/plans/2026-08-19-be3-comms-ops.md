# BE-3 — Comms & Ops Implementation Plan

> Extends `fleet-backend/`. Same patterns as BE-1/BE-2: `requireAuth`, Zod `validateBody`, ownership-by-construction (queries keyed on `req.auth.driverId`; mismatch → 404), Prisma+SQLite, Vitest+Supertest with `resetDb()`, per-unit commits scoped to `fleet-backend/`. TDD.

**Goal:** the remaining driver-facing operational flows — messaging (with unread + read-state + attachments), notifications, duty sessions, safety (panic/emergency/fuel), vehicle issues, and navigation.

**Spec:** `decompiled/API-CONTRACT.md` (Messaging, Notifications, Duty session, Safety, Vehicle, Navigation sections).

## Global Constraints
- Under `/api`, Bearer, driver-scoped. Conversations/messages/notifications/sessions/alerts belong to a driver; only the owner reads/writes → else 404.
- Message `senderType` is `"driver"` for anything this API creates (the dispatcher side arrives in BE-4). Reuse the multer upload setup from BE-2 for message attachments (`/uploads`).
- Wrong state → 409, bad input → 400, not-owner → 404.

## Data model additions (`prisma/schema.prisma`) + migration `be3_comms_ops`
```prisma
model Conversation { id String @id @default(uuid()) driverId String tripId String? createdAt DateTime @default(now()) messages Message[] @@index([driverId]) }
model Message { id String @id @default(uuid()) conversationId String senderType String text String? attachmentUrl String? readAt DateTime? createdAt DateTime @default(now()) @@index([conversationId]) }
model Notification { id String @id @default(uuid()) driverId String type String title String? body String? readAt DateTime? createdAt DateTime @default(now()) @@index([driverId, readAt]) }
model DriverSession { id String @id @default(uuid()) driverId String startedAt DateTime @default(now()) endedAt DateTime? status String @default("active") totalBreakMs Int @default(0) breakStartedAt DateTime? @@index([driverId]) }
model SafetyAlert { id String @id @default(uuid()) driverId String kind String latitude Float? longitude Float? description String? reason String? status String @default("open") createdAt DateTime @default(now()) @@index([driverId]) }
model FuelLog { id String @id @default(uuid()) driverId String vehicleId String? amount Float? cost Float? odometer Int? createdAt DateTime @default(now()) }
model VehicleIssue { id String @id @default(uuid()) vehicleId String driverId String description String severity String? status String @default("open") createdAt DateTime @default(now()) @@index([vehicleId]) }
model Incident { id String @id @default(uuid()) driverId String tripId String? type String latitude Float? longitude Float? description String? createdAt DateTime @default(now()) }
```

## Endpoints (group into `src/routes/messages.ts`, `notifications.ts`, `sessions.ts`, `safety.ts`, `vehicle.ts`, `navigation.ts`; mount in `app.ts`)
**Messaging**
| GET `/api/driver/messages?conversation=` | thread (driver's conversation) |
| POST `/api/driver/messages` `{conversationId?, tripId?, text}` | create msg (senderType driver); create conversation if none |
| POST `/api/trips/:id/messages` multipart `file`+`{text?}` | message w/ attachment on the trip's conversation |
| GET `/api/driver/messages/unread-summary` | `{conversations:[{conversationId,unread}], total}` |
| GET `/api/driver/unread-messages-count` | `{count}` |
| POST `/api/driver/messages/read-all` | mark all driver msgs read |
| PUT `/api/trips/:id/messages/read-all` | mark that trip's convo read |
| PUT `/api/messages/:id/read` | mark one read (owner only) |

**Notifications**
| GET `/api/driver/notifications` | list | POST `/api/driver/notifications/read-all` | PUT `/api/notifications/:id/read` | GET `/api/driver/notification-preferences` `{...defaults}` |

**Duty session** (guards in `src/domain/sessionState.ts`, unit-tested)
| GET `/api/driver/session` current | POST `/api/driver/session/start` (409 if active exists) | POST `/api/driver/session/break` `{}` (toggle break; accumulates `totalBreakMs`) | POST `/api/driver/session/end` (sets endedAt/status ended) |

**Safety / vehicle / navigation**
| POST `/api/driver/panic` `{latitude?,longitude?}` → SafetyAlert kind panic |
| POST `/api/driver/emergency` `{latitude?,longitude?,description?,reason?}` → kind emergency |
| POST `/api/driver/fuel` `{amount?,cost?,odometer?,vehicleId?}` → FuelLog |
| POST `/api/vehicles/:id/issues` `{description, severity?}` → VehicleIssue |
| GET `/api/driver/vehicle` → the driver's assigned vehicle (404 if none) |
| POST `/api/navigation/route` `{origin,destination,waypoints?}` → echo + `distance:null` (compute stub, not persisted; comment it) |
| POST `/api/navigation/incident` `{type,latitude?,longitude?,description?}` → Incident |

## Acceptance tests
- message create → appears in thread; unread-count reflects unread; read-all zeroes it; PUT one read marks single.
- attachment message returns a `/uploads/...` url.
- notifications list/read-all/read-one.
- session start → 409 on second start; break toggles and accumulates; end closes it; GET returns current.
- panic/emergency/fuel/vehicle-issue/incident each persist and return the record.
- navigation/route echoes input.
- **cross-driver isolation**: reading another driver's messages/notifications/session/alert → 404 (test at least messages + session + notifications).

## Done when
`npm test` green (63 + new), `tsc --noEmit` clean, migration applied, commits scoped to `fleet-backend/`.
