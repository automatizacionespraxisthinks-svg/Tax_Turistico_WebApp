-- Segundo factor de la oficina (§8.1).
--
-- `totp_last_counter` guarda el último intervalo de 30 s aceptado: dentro de
-- su ventana un código TOTP es válido muchas veces, y sin esto quien lo vea
-- por encima del hombro puede reutilizarlo hasta que caduque.
--
-- Los códigos de respaldo son de un solo uso y van con el mismo Argon2 que
-- las contraseñas: son una llave de repuesto al panel entero.

CREATE TABLE "user_recovery_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_counter" bigint;--> statement-breakpoint
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_recovery_codes_user_idx" ON "user_recovery_codes" USING btree ("user_id");--> statement-breakpoint
