import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import { loadEnv } from './config/env';
import { DbModule } from './db/db.module';
import { RedisModule } from './redis/redis.module';
import { RealtimeModule } from './realtime/realtime.module';
import { IdentityModule } from './modules/identity/identity.module';
import { AuditModule } from './modules/audit/audit.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { FleetModule } from './modules/fleet/fleet.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { RidesModule } from './modules/rides/rides.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { ReportsModule } from './modules/reports/reports.module';
import { PushModule } from './modules/push/push.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { StatusController } from './status.controller';
import { SystemController } from './system.controller';

const env = loadEnv();

/**
 * Monolito modular (ADR-01).
 *
 * Ocho módulos de dominio con fronteras estrictas: cada uno expone una
 * interfaz pública y ninguno lee las tablas de otro (§4). La API, las tareas
 * en segundo plano y el socket corren en este mismo proceso porque separarlos
 * en tres contenedores triplicaría la memoria base para una carga de cinco
 * posiciones por segundo.
 */
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        // Un identificador por carrera que sigue el flujo desde el webhook de
        // n8n hasta la aceptación (§10.4).
        genReqId: (req) => (req.headers['x-tax-event-id'] as string) ?? undefined,
        redact: {
          // Nunca salen a los logs: Dokploy los recoge y Sentry los recibe.
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
            'req.body.pin',
            'req.body.password',
            'req.body.customerPhone',
            'res.headers["set-cookie"]',
          ],
          censor: '[redactado]',
        },
      },
    }),

    BullModule.forRoot({
      connection: { url: env.REDIS_URL },
      // Prefijo propio de BullMQ: el usuario ACL de Redis solo puede escribir
      // bajo `tax:` (ADR-05). No se usa el `keyPrefix` de ioredis porque
      // BullMQ construye sus claves con scripts Lua.
      prefix: 'tax:bull',
      defaultJobOptions: {
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
    }),

    DbModule,
    RedisModule,
    IdentityModule,
    AuditModule,
    RealtimeModule,
    PushModule,
    MaintenanceModule,

    PricingModule,
    FleetModule,
    IntegrationsModule,
    RidesModule,
    DispatchModule,
    ReportsModule,
  ],
  controllers: [StatusController, SystemController],
})
export class AppModule {}
