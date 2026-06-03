# FreightOS — Production Logistics Platform

A full-stack, production-ready logistics and freight transport platform inspired by Raaho, Porter, and BlackBuck. Built with React Native, NestJS, PostgreSQL, Redis, and TimescaleDB.

---

## Project Structure

```
freightos/
├── apps/
│   ├── mobile/                    # React Native app (iOS + Android)
│   │   └── src/
│   │       ├── screens/
│   │       │   ├── customer/      # Customer-facing screens
│   │       │   ├── driver/        # Driver app screens
│   │       │   ├── fleet/         # Fleet owner portal
│   │       │   └── admin/         # Admin dashboard (web)
│   │       ├── components/        # Shared UI components
│   │       ├── navigation/        # React Navigation stacks
│   │       ├── services/          # API service layer
│   │       ├── store/             # Redux Toolkit state
│   │       └── hooks/             # Custom React hooks
│   └── backend/                   # NestJS microservices
│       └── src/
│           ├── modules/
│           │   ├── auth/          # JWT, OTP, OAuth, KYC
│           │   ├── booking/       # Shipment lifecycle
│           │   ├── tracking/      # GPS, ETA, geofencing
│           │   ├── payment/       # UPI, cards, wallet, GST
│           │   ├── fleet/         # Vehicle management
│           │   ├── driver/        # Driver ops, scoring
│           │   ├── notification/  # Push, SMS, email
│           │   ├── analytics/     # Metrics and reporting
│           │   ├── ai/            # Route opt, pricing, ETA
│           │   ├── chat/          # WebSocket messaging
│           │   ├── pod/           # Proof of delivery
│           │   └── admin/         # RBAC, audit logs
│           ├── common/            # Guards, interceptors, filters
│           ├── config/            # Environment configuration
│           └── database/          # Migrations and seeds
└── shared/                        # Shared types and utilities
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Mobile | React Native 0.73 + TypeScript |
| State | Redux Toolkit + RTK Query |
| Maps | React Native Maps + Google Maps SDK |
| Backend | NestJS 10 + TypeScript |
| ORM | TypeORM + PostgreSQL 16 |
| Cache | Redis 7 (sessions, pub/sub, queues) |
| GPS data | TimescaleDB (time-series extension) |
| Search | Elasticsearch 8 |
| Queue | Bull (Redis-backed job queues) |
| Real-time | Socket.IO (WebSockets) |
| Auth | Passport.js + JWT + Google OAuth |
| Payments | Razorpay + Cashfree |
| Storage | AWS S3 / Cloudflare R2 |
| Notifications | Firebase FCM + Twilio SMS + SendGrid |
| Deployment | Docker + Kubernetes (EKS/GKE) |
| CI/CD | GitHub Actions |
| Monitoring | DataDog + Sentry |

---

## Quick Start

```bash
# Install dependencies
npm install

# Start all services with Docker
docker-compose up -d

# Run database migrations
npm run migration:run

# Seed initial data
npm run seed:run

# Start backend dev server
cd apps/backend && npm run start:dev

# Start mobile app
cd apps/mobile && npx react-native start
```

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/freightos
REDIS_URL=redis://localhost:6379
TIMESCALE_URL=postgresql://user:pass@localhost:5433/freightos_ts

# Auth
JWT_SECRET=your-256-bit-secret
JWT_EXPIRY=7d
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# SMS / OTP
TWILIO_SID=your-twilio-sid
TWILIO_TOKEN=your-twilio-token
TWILIO_FROM=+1234567890

# Payments
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_SECRET=...

# Maps
GOOGLE_MAPS_KEY=AIza...

# Storage
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=freightos-media

# Notifications
FCM_SERVER_KEY=...
SENDGRID_API_KEY=SG....
```
