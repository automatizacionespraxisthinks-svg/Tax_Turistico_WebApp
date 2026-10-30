import 'dotenv/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { VEHICLE_TYPES, type VehicleType } from '@tax/shared';
import { DbModule } from '../db/db.module';
import { AuditService } from '../modules/audit/audit.service';
import { FleetAdminService } from '../modules/fleet/fleet-admin.service';
import { FleetService } from '../modules/fleet/fleet.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * Da de alta un conductor desde el servidor.
 *
 * Usa el MISMO servicio que el panel (`FleetAdminService`) en vez de repetir
 * la lógica: una sola implementación del PIN, del alta del vehículo y de la
 * entrada en la bitácora. Antes esto insertaba por su cuenta y el alta por
 * terminal no quedaba registrada en ninguna parte.
 *
 * Levanta solo la base y la auditoría, no la aplicación entera: no hace falta
 * Redis ni las colas para crear una fila.
 *
 *   node dist/cli/crear-conductor.js 106 "Pedro Ramírez" +573118889900 WXY123 sedan
 */

/*
 * Se provee `AuditService` directamente en vez de importar `AuditModule`.
 *
 * Ese modulo trae consigo su controlador, el controlador usa `SessionGuard` y
 * el guardia necesita `IdentityService`: nada de eso tiene sentido en un
 * comando de terminal, y compilado hace que Nest falle al arrancar con
 * «can't resolve dependencies of the SessionGuard». El servicio por su cuenta
 * solo depende de la base.
 *
 * `FleetService` y `RealtimeGateway` van vacíos por lo mismo: el servicio los
 * usa solo al suspender (cerrar el turno y avisar a la PWA), que necesita
 * Redis y el socket. Aquí solo se crea, y crear no los toca.
 */
@Module({
  imports: [DbModule],
  providers: [
    AuditService,
    FleetAdminService,
    { provide: FleetService, useValue: {} },
    { provide: RealtimeGateway, useValue: {} },
  ],
})
class CliModule {}

async function main(): Promise<void> {
  const [code, name, phone, plate, tipo = 'sedan'] = process.argv.slice(2);

  if (!code || !name || !phone || !plate) {
    console.error(
      'Uso: crear-conductor.js <código> "<nombre>" <teléfono> <placa> [sedan|camioneta|van]',
    );
    process.exitCode = 1;
    return;
  }
  if (!VEHICLE_TYPES.includes(tipo as VehicleType)) {
    console.error(`Tipo inválido: «${tipo}». Usa ${VEHICLE_TYPES.join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });

  try {
    const fleet = app.get(FleetAdminService);
    const { code: codigo, pin } = await fleet.createDriver(
      { code, name, phone, plate, vehicleType: tipo as VehicleType },
      // Sin actorId: no hay persona identificada detrás. Queda en la
      // bitácora como lo que es, una operación hecha desde el servidor.
      { name: 'Terminal del servidor', role: 'system' },
    );

    console.log(`\nConductor creado: ${name} · código ${codigo} · placa ${plate.toUpperCase()} (${tipo})`);
    console.log(`PIN (no se vuelve a mostrar):\n\n  ${pin}\n`);
    console.log('Entrégaselo por un canal distinto del que usa para su código.');
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // Se imprime el error entero, no solo `.message`: los de Nest y los de
  // Postgres llevan la causa real en `cause` o en el `stack`, y quedarse con
  // el mensaje deja «Falló la creación:» a secas, que no ayuda a nadie.
  console.error('Falló la creación:');
  console.error(error);
  process.exitCode = 1;
});
