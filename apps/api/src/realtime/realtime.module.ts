import { Global, Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Tiempo real. Global porque casi todos los módulos avisan de algo, pero el
 * canal es de salida: nadie recibe órdenes por socket, solo noticias.
 */
@Global()
@Module({
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
