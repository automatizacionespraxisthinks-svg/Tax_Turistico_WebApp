CREATE TYPE "public"."driver_status" AS ENUM('OFF_SHIFT', 'AVAILABLE', 'ON_RIDE', 'PAUSED');--> statement-breakpoint
CREATE TYPE "public"."offer_response" AS ENUM('pending', 'accepted', 'rejected', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."outbox_event_type" AS ENUM('ride.created', 'ride.assigned', 'ride.reassigned', 'ride.eta_updated', 'ride.driver_arrived', 'ride.started', 'ride.completed', 'ride.cancelled', 'ride.no_driver');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'delivering', 'delivered', 'dead');--> statement-breakpoint
CREATE TYPE "public"."ride_status" AS ENUM('PENDING', 'NOTIFIED', 'ASSIGNED', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'UNASSIGNED');--> statement-breakpoint
CREATE TYPE "public"."transition_actor" AS ENUM('system', 'driver', 'operator', 'customer');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('administrador', 'operador');--> statement-breakpoint
CREATE TYPE "public"."vehicle_type" AS ENUM('sedan', 'camioneta', 'van');--> statement-breakpoint
CREATE TYPE "public"."zone_kind" AS ENUM('urbano', 'rural', 'vereda', 'referencia');--> statement-breakpoint
CREATE SEQUENCE "public"."ride_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "driver_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"driver_id" uuid NOT NULL,
	"label" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"push_subscription" text,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver_positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"driver_id" uuid NOT NULL,
	"shift_id" uuid,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"accuracy_meters" integer,
	"ride_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver_shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"driver_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"document_encrypted" text,
	"phone" text NOT NULL,
	"pin_hash" text NOT NULL,
	"status" "driver_status" DEFAULT 'OFF_SHIFT' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plate" text NOT NULL,
	"type" "vehicle_type" DEFAULT 'sedan' NOT NULL,
	"capacity" integer DEFAULT 4 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "zone_kind" NOT NULL,
	"zone_id" uuid,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "zone_kind" NOT NULL,
	"polygon" jsonb NOT NULL,
	"tortuosity" double precision DEFAULT 1.4 NOT NULL,
	"waves" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"consent_version" text,
	"consent_at" timestamp with time zone,
	"consent_channel" text,
	"last_lat" double precision,
	"last_lng" double precision,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ride_address_edits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ride_id" uuid NOT NULL,
	"field" text NOT NULL,
	"previous_value" text,
	"new_value" text NOT NULL,
	"actor" "transition_actor" NOT NULL,
	"actor_name" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ride_offers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ride_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"wave" integer NOT NULL,
	"distance_km" double precision NOT NULL,
	"eta_minutes" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"response" "offer_response" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ride_status_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ride_id" uuid NOT NULL,
	"from_status" "ride_status",
	"to_status" "ride_status" NOT NULL,
	"actor" "transition_actor" NOT NULL,
	"actor_name" text NOT NULL,
	"actor_id" uuid,
	"lat" double precision,
	"lng" double precision,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"status" "ride_status" DEFAULT 'PENDING' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"customer_id" uuid NOT NULL,
	"pickup_text" text NOT NULL,
	"pickup_reference" text,
	"pickup_lat" double precision,
	"pickup_lng" double precision,
	"dropoff_text" text,
	"dropoff_lat" double precision,
	"dropoff_lng" double precision,
	"zone_id" uuid,
	"vehicle_type" "vehicle_type" DEFAULT 'sedan' NOT NULL,
	"passengers" integer DEFAULT 1 NOT NULL,
	"fare_estimate" integer NOT NULL,
	"fare_rule_version" text NOT NULL,
	"driver_id" uuid,
	"vehicle_id" uuid,
	"line" text,
	"chatwoot_conversation_id" integer,
	"eta_minutes" integer,
	"notes" text,
	"wave" integer,
	"cancel_reason" text,
	"allows_concurrent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fare_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"origin_kind" "zone_kind" NOT NULL,
	"destination_kind" "zone_kind" NOT NULL,
	"base_fare" integer NOT NULL,
	"per_km" integer NOT NULL,
	"minimum_fare" integer NOT NULL,
	"surcharges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"legal_reference" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"body_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"type" "outbox_event_type" NOT NULL,
	"ride_id" uuid,
	"ride_code" text,
	"ride_version" integer,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waha_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"phone" text NOT NULL,
	"status" text NOT NULL,
	"last_check_at" timestamp with time zone,
	"messages_today" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"webhook_secret" text,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'operador' NOT NULL,
	"totp_secret_encrypted" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"role" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" "inet",
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "driver_devices" ADD CONSTRAINT "driver_devices_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_positions" ADD CONSTRAINT "driver_positions_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_positions" ADD CONSTRAINT "driver_positions_shift_id_driver_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."driver_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_address_edits" ADD CONSTRAINT "ride_address_edits_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_offers" ADD CONSTRAINT "ride_offers_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_offers" ADD CONSTRAINT "ride_offers_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_status_history" ADD CONSTRAINT "ride_status_history_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "driver_devices_driver_idx" ON "driver_devices" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "driver_positions_recorded_idx" ON "driver_positions" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "driver_positions_driver_idx" ON "driver_positions" USING btree ("driver_id","recorded_at");--> statement-breakpoint
CREATE INDEX "driver_shifts_driver_idx" ON "driver_shifts" USING btree ("driver_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_shift_per_driver" ON "driver_shifts" USING btree ("driver_id") WHERE "driver_shifts"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "one_open_shift_per_vehicle" ON "driver_shifts" USING btree ("vehicle_id") WHERE "driver_shifts"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "drivers_code_key" ON "drivers" USING btree ("code");--> statement-breakpoint
CREATE INDEX "drivers_status_idx" ON "drivers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_plate_key" ON "vehicles" USING btree ("plate");--> statement-breakpoint
CREATE INDEX "places_zone_idx" ON "places" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "places_name_idx" ON "places" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "zones_name_key" ON "zones" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_phone_key" ON "customers" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "ride_address_edits_ride_idx" ON "ride_address_edits" USING btree ("ride_id","at");--> statement-breakpoint
CREATE INDEX "ride_offers_ride_idx" ON "ride_offers" USING btree ("ride_id","wave");--> statement-breakpoint
CREATE INDEX "ride_offers_driver_open_idx" ON "ride_offers" USING btree ("driver_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_offer_per_driver_per_wave" ON "ride_offers" USING btree ("ride_id","driver_id","wave");--> statement-breakpoint
CREATE INDEX "ride_status_history_ride_idx" ON "ride_status_history" USING btree ("ride_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "rides_code_key" ON "rides" USING btree ("code");--> statement-breakpoint
CREATE INDEX "rides_status_idx" ON "rides" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "rides_driver_idx" ON "rides" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "rides_customer_idx" ON "rides" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_ride_per_driver" ON "rides" USING btree ("driver_id") WHERE "rides"."status" in ('ASSIGNED','DRIVER_ARRIVED','IN_PROGRESS');--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_ride_per_customer" ON "rides" USING btree ("customer_id") WHERE "rides"."status" in ('PENDING','NOTIFIED','ASSIGNED','DRIVER_ARRIVED','IN_PROGRESS','UNASSIGNED') and "rides"."allows_concurrent" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "fare_rules_version_pair_key" ON "fare_rules" USING btree ("version","origin_kind","destination_kind");--> statement-breakpoint
CREATE INDEX "fare_rules_effective_idx" ON "fare_rules" USING btree ("effective_from","effective_to");--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_ride_idx" ON "outbox_events" USING btree ("ride_id","ride_version");--> statement-breakpoint
CREATE UNIQUE INDEX "waha_sessions_phone_key" ON "waha_sessions" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");