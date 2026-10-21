import { Module } from '@nestjs/common';
import { PushService } from './push.service';
import { PushController } from './push.controller';

/**
 * Web Push.
 *
 * Canal de salida hacia el conductor, hermano del socket: el socket cuando la
 * aplicación está abierta, el push cuando no. No es dueño de datos propios;
 * la suscripción vive con el dispositivo, en Identidad, para que revocar un
 * celular perdido se lleve también sus avisos.
 */
@Module({
  providers: [PushService],
  controllers: [PushController],
  exports: [PushService],
})
export class PushModule {}
