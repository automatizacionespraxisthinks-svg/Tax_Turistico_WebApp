CREATE TABLE "roles" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Los dos roles de siempre, con lo que cada uno podía hacer antes de que los
-- permisos fueran editables: nadie gana ni pierde nada al desplegar. Tienen
-- que existir antes de la llave foránea, porque todos los usuarios tienen uno.
INSERT INTO "roles" ("key", "name", "description", "permissions", "system") VALUES
	('administrador', 'Administrador', 'Todo el panel, incluidos usuarios y roles.', '[]'::jsonb, true),
	('operador', 'Operador', 'La operación del día: despachar, corregir y cancelar carreras.',
		'["carreras.despachar","carreras.corregir","carreras.cancelar","clientes.marcar","lugares.gestionar","reportes.ver","reportes.exportar"]'::jsonb, true);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text USING "role"::text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'operador';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_roles_key_fk" FOREIGN KEY ("role") REFERENCES "public"."roles"("key") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
DROP TYPE "public"."user_role";
