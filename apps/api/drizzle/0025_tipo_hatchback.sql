-- Tipo de vehículo «Hatchback» (19/11/2026). Atiende los mismos pedidos que
-- el sedán (VEHICULOS_QUE_ATIENDEN en @tax/shared). ADD VALUE se puede
-- correr dentro de la transacción de la migración (PostgreSQL 12 o más);
-- el valor nuevo no se usa en esta misma migración.
ALTER TYPE "public"."vehicle_type" ADD VALUE 'hatchback' BEFORE 'camioneta';
