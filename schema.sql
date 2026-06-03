-- =============================================================
-- FreightOS Database Schema — PostgreSQL 16 + TimescaleDB
-- =============================================================

-- -------------------------
-- EXTENSIONS
-- -------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgis;      -- spatial queries
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy search

-- -------------------------
-- ENUMS
-- -------------------------
CREATE TYPE user_role AS ENUM ('customer', 'driver', 'fleet_owner', 'admin', 'ops_manager');
CREATE TYPE kyc_status AS ENUM ('pending', 'submitted', 'approved', 'rejected');
CREATE TYPE booking_status AS ENUM (
  'draft', 'confirmed', 'driver_assigned', 'pickup_en_route',
  'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'cancelled', 'disputed'
);
CREATE TYPE vehicle_type AS ENUM ('mini_truck', 'truck', 'trailer', 'container', 'tanker', 'refrigerated');
CREATE TYPE payment_method AS ENUM ('upi', 'card', 'netbanking', 'wallet', 'cod', 'credit_line');
CREATE TYPE payment_status AS ENUM ('pending', 'processing', 'success', 'failed', 'refunded');
CREATE TYPE driver_status AS ENUM ('offline', 'available', 'on_trip', 'suspended');
CREATE TYPE vehicle_status AS ENUM ('active', 'idle', 'maintenance', 'retired');
CREATE TYPE notification_type AS ENUM ('push', 'sms', 'email', 'in_app');

-- ========================
-- CORE TABLES
-- ========================

-- Users (all roles)
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name       VARCHAR(120) NOT NULL,
  phone           VARCHAR(15) UNIQUE,
  email           VARCHAR(180) UNIQUE,
  role            user_role NOT NULL DEFAULT 'customer',
  kyc_status      kyc_status NOT NULL DEFAULT 'pending',
  avatar_url      TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_login_at   TIMESTAMPTZ,
  device_tokens   JSONB DEFAULT '[]',        -- FCM tokens for push
  preferences     JSONB DEFAULT '{}',        -- dark_mode, lang, etc.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_phone ON users (phone);
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_role  ON users (role);

-- Auth credentials
CREATE TABLE auth_credentials (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        VARCHAR(30) NOT NULL,   -- 'local', 'google', 'apple'
  provider_id     TEXT,                   -- OAuth subject
  password_hash   TEXT,
  refresh_token   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

-- OTP store
CREATE TABLE otp_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone       VARCHAR(15) NOT NULL,
  code        VARCHAR(6) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_otp_phone_exp ON otp_codes (phone, expires_at);

-- ========================
-- ADDRESSES
-- ========================
CREATE TABLE saved_addresses (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       VARCHAR(60),                        -- 'Home', 'Warehouse A'
  address     TEXT NOT NULL,
  latitude    DOUBLE PRECISION NOT NULL,
  longitude   DOUBLE PRECISION NOT NULL,
  geom        GEOGRAPHY(POINT, 4326),            -- PostGIS for spatial ops
  city        VARCHAR(80),
  state       VARCHAR(80),
  pincode     VARCHAR(10),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_addr_user  ON saved_addresses (user_id);
CREATE INDEX idx_addr_geom  ON saved_addresses USING GIST (geom);

-- ========================
-- FLEET & VEHICLES
-- ========================
CREATE TABLE fleet_owners (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name    VARCHAR(200),
  gst_number      VARCHAR(15) UNIQUE,
  pan_number      VARCHAR(10) UNIQUE,
  bank_account    JSONB,                -- { acc_no, ifsc, holder_name }
  rating          NUMERIC(3,2) DEFAULT 5.0,
  total_vehicles  INT DEFAULT 0,
  is_verified     BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vehicles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fleet_owner_id  UUID REFERENCES fleet_owners(id),
  registration_no VARCHAR(15) NOT NULL UNIQUE,
  type            vehicle_type NOT NULL,
  make            VARCHAR(60),
  model           VARCHAR(60),
  year            SMALLINT,
  capacity_tons   NUMERIC(6,2),
  status          vehicle_status NOT NULL DEFAULT 'idle',
  current_driver  UUID REFERENCES users(id),
  documents       JSONB DEFAULT '{}',   -- { rc, insurance, puc, fitness }
  maintenance_due TIMESTAMPTZ,
  gps_device_id   VARCHAR(40),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_vehicles_fleet  ON vehicles (fleet_owner_id);
CREATE INDEX idx_vehicles_status ON vehicles (status);

-- ========================
-- DRIVERS
-- ========================
CREATE TABLE drivers (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  license_number      VARCHAR(20) UNIQUE NOT NULL,
  license_expiry      DATE,
  status              driver_status NOT NULL DEFAULT 'offline',
  vehicle_id          UUID REFERENCES vehicles(id),
  rating              NUMERIC(3,2) DEFAULT 5.0,
  total_trips         INT DEFAULT 0,
  performance_score   NUMERIC(5,2) DEFAULT 100.0,   -- composite driver score
  documents           JSONB DEFAULT '{}',
  bank_account        JSONB,
  emergency_contact   JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_drivers_user   ON drivers (user_id);
CREATE INDEX idx_drivers_status ON drivers (status);
CREATE INDEX idx_drivers_vehicle ON drivers (vehicle_id);

-- ========================
-- GPS TRACKING (TimescaleDB hypertable)
-- ========================
CREATE TABLE driver_locations (
  time          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  driver_id     UUID NOT NULL REFERENCES users(id),
  latitude      DOUBLE PRECISION NOT NULL,
  longitude     DOUBLE PRECISION NOT NULL,
  geom          GEOGRAPHY(POINT, 4326),
  speed_kmh     REAL,
  heading       REAL,
  accuracy_m    REAL,
  booking_id    UUID,
  battery_pct   SMALLINT
);

-- Convert to TimescaleDB hypertable (partitioned by time)
SELECT create_hypertable('driver_locations', 'time');

CREATE INDEX idx_dloc_driver_time ON driver_locations (driver_id, time DESC);
CREATE INDEX idx_dloc_geom        ON driver_locations USING GIST (geom);

-- ========================
-- BOOKINGS / SHIPMENTS
-- ========================
CREATE TABLE bookings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tracking_id     VARCHAR(12) NOT NULL UNIQUE,   -- e.g. SHP-20847
  customer_id     UUID NOT NULL REFERENCES users(id),
  driver_id       UUID REFERENCES users(id),
  vehicle_id      UUID REFERENCES vehicles(id),
  status          booking_status NOT NULL DEFAULT 'draft',

  -- Locations
  pickup_address  TEXT NOT NULL,
  pickup_lat      DOUBLE PRECISION NOT NULL,
  pickup_lng      DOUBLE PRECISION NOT NULL,
  pickup_geom     GEOGRAPHY(POINT, 4326),
  delivery_address TEXT NOT NULL,
  delivery_lat    DOUBLE PRECISION NOT NULL,
  delivery_lng    DOUBLE PRECISION NOT NULL,
  delivery_geom   GEOGRAPHY(POINT, 4326),

  -- Cargo
  cargo_type      VARCHAR(80),
  cargo_weight_kg NUMERIC(10,2),
  cargo_volume_m3 NUMERIC(8,2),
  cargo_notes     TEXT,
  vehicle_type    vehicle_type,

  -- Pricing
  base_amount     NUMERIC(12,2),
  gst_amount      NUMERIC(12,2),
  toll_amount     NUMERIC(10,2) DEFAULT 0,
  freight_amount  NUMERIC(12,2) NOT NULL,
  commission_pct  NUMERIC(5,2) DEFAULT 10.0,

  -- Scheduling
  pickup_time     TIMESTAMPTZ,
  eta             TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  distance_km     NUMERIC(8,2),

  -- E-way bill
  eway_bill_no    VARCHAR(20),
  eway_bill_data  JSONB,

  cancellation_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bookings_customer  ON bookings (customer_id);
CREATE INDEX idx_bookings_driver    ON bookings (driver_id);
CREATE INDEX idx_bookings_status    ON bookings (status);
CREATE INDEX idx_bookings_created   ON bookings (created_at DESC);
CREATE INDEX idx_bookings_tracking  ON bookings (tracking_id);

-- Multi-stop delivery points
CREATE TABLE delivery_stops (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id  UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  sequence    SMALLINT NOT NULL,
  address     TEXT NOT NULL,
  latitude    DOUBLE PRECISION,
  longitude   DOUBLE PRECISION,
  contact_name    VARCHAR(120),
  contact_phone   VARCHAR(15),
  notes       TEXT,
  arrived_at  TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (booking_id, sequence)
);

-- Tracking events log
CREATE TABLE tracking_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id  UUID NOT NULL REFERENCES bookings(id),
  event_type  VARCHAR(40) NOT NULL,   -- 'status_change', 'location_update', 'geofence_alert'
  status      booking_status,
  latitude    DOUBLE PRECISION,
  longitude   DOUBLE PRECISION,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tevents_booking ON tracking_events (booking_id, created_at DESC);

-- ========================
-- PAYMENTS
-- ========================
CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id      UUID NOT NULL REFERENCES bookings(id),
  amount          NUMERIC(12,2) NOT NULL,
  currency        VARCHAR(3) NOT NULL DEFAULT 'INR',
  method          payment_method NOT NULL,
  status          payment_status NOT NULL DEFAULT 'pending',
  gateway         VARCHAR(20),           -- 'razorpay', 'cashfree'
  gateway_order_id TEXT,
  gateway_payment_id TEXT,
  gateway_signature TEXT,
  gst_details     JSONB,                 -- { cgst, sgst, igst, hsn }
  invoice_number  VARCHAR(30),
  invoice_url     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payments_booking ON payments (booking_id);
CREATE INDEX idx_payments_status  ON payments (status);

-- Wallet
CREATE TABLE wallets (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) UNIQUE,
  balance     NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency    VARCHAR(3) DEFAULT 'INR',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallet_transactions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id   UUID NOT NULL REFERENCES wallets(id),
  type        VARCHAR(10) NOT NULL,   -- 'credit', 'debit'
  amount      NUMERIC(12,2) NOT NULL,
  description TEXT,
  reference   UUID,                  -- booking_id or payment_id
  balance_after NUMERIC(12,2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wallet_tx ON wallet_transactions (wallet_id, created_at DESC);

-- ========================
-- EARNINGS
-- ========================
CREATE TABLE earnings (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id   UUID NOT NULL REFERENCES drivers(id),
  booking_id  UUID NOT NULL REFERENCES bookings(id),
  gross       NUMERIC(10,2) NOT NULL,
  commission  NUMERIC(10,2) NOT NULL,
  fuel_deduction NUMERIC(10,2) DEFAULT 0,
  net_earning NUMERIC(10,2) NOT NULL,
  settled     BOOLEAN DEFAULT false,
  settled_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_earnings_driver ON earnings (driver_id, created_at DESC);

-- ========================
-- PROOF OF DELIVERY
-- ========================
CREATE TABLE pod_records (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id      UUID NOT NULL REFERENCES bookings(id) UNIQUE,
  photo_urls      JSONB DEFAULT '[]',
  signature_url   TEXT,
  qr_code         TEXT,
  receiver_name   VARCHAR(120),
  receiver_phone  VARCHAR(15),
  notes           TEXT,
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  delivered_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ========================
-- CHAT
-- ========================
CREATE TABLE chat_threads (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id  UUID NOT NULL REFERENCES bookings(id) UNIQUE,
  participants JSONB NOT NULL,           -- [customer_id, driver_id]
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE chat_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  thread_id   UUID NOT NULL REFERENCES chat_threads(id),
  sender_id   UUID NOT NULL REFERENCES users(id),
  content     TEXT,
  media_url   TEXT,
  msg_type    VARCHAR(10) DEFAULT 'text',  -- 'text', 'image', 'location'
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_chat_messages ON chat_messages (thread_id, created_at DESC);

-- ========================
-- REVIEWS & RATINGS
-- ========================
CREATE TABLE reviews (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id  UUID NOT NULL REFERENCES bookings(id),
  reviewer_id UUID NOT NULL REFERENCES users(id),
  reviewee_id UUID NOT NULL REFERENCES users(id),
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  tags        JSONB DEFAULT '[]',   -- ['on_time', 'professional', 'careful']
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (booking_id, reviewer_id)
);

-- ========================
-- GEOFENCES
-- ========================
CREATE TABLE geofences (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(120) NOT NULL,
  description TEXT,
  geom        GEOGRAPHY(POLYGON, 4326) NOT NULL,
  radius_m    NUMERIC(8,2),
  is_active   BOOLEAN DEFAULT true,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_geofences_geom ON geofences USING GIST (geom);

-- ========================
-- AUDIT LOGS
-- ========================
CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id    UUID REFERENCES users(id),
  action      VARCHAR(80) NOT NULL,
  resource    VARCHAR(40) NOT NULL,
  resource_id UUID,
  old_value   JSONB,
  new_value   JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_actor    ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_logs (resource, resource_id);

-- ========================
-- MAINTENANCE SCHEDULE
-- ========================
CREATE TABLE maintenance_records (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vehicle_id  UUID NOT NULL REFERENCES vehicles(id),
  type        VARCHAR(60),    -- 'oil_change', 'tyre', 'brake', 'puc', 'fitness'
  description TEXT,
  cost        NUMERIC(10,2),
  scheduled_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  vendor_name VARCHAR(120),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_maint_vehicle ON maintenance_records (vehicle_id);

-- ========================
-- FUEL LOGS
-- ========================
CREATE TABLE fuel_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id   UUID NOT NULL REFERENCES drivers(id),
  vehicle_id  UUID REFERENCES vehicles(id),
  booking_id  UUID REFERENCES bookings(id),
  litres      NUMERIC(8,2),
  cost        NUMERIC(10,2),
  odometer_km NUMERIC(10,2),
  station     VARCHAR(120),
  receipt_url TEXT,
  logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ========================
-- SUPPORT TICKETS
-- ========================
CREATE TABLE support_tickets (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id),
  booking_id  UUID REFERENCES bookings(id),
  category    VARCHAR(40),
  subject     VARCHAR(200),
  description TEXT,
  status      VARCHAR(20) DEFAULT 'open',   -- 'open', 'in_progress', 'resolved', 'closed'
  priority    VARCHAR(10) DEFAULT 'medium', -- 'low', 'medium', 'high', 'critical'
  assigned_to UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ========================
-- NOTIFICATION LOG
-- ========================
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id),
  type        notification_type NOT NULL,
  title       VARCHAR(120),
  body        TEXT,
  data        JSONB DEFAULT '{}',
  read_at     TIMESTAMPTZ,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notifs_user ON notifications (user_id, created_at DESC);
