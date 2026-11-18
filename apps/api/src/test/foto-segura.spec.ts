import { describe, expect, it } from 'vitest';
import { esPrivada } from '../modules/rides/fotos.service';

/** Las direcciones a las que la API nunca le pide una foto del lugar. */
describe('esPrivada', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.18.0.5', '192.168.1.10', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1'])(
    '%s es privada',
    (direccion) => expect(esPrivada(direccion)).toBe(true),
  );

  it.each(['8.8.8.8', '190.24.10.5', '2800:3f0:4005:409::200e', '::ffff:8.8.8.8'])('%s es pública', (direccion) =>
    expect(esPrivada(direccion)).toBe(false),
  );
});
