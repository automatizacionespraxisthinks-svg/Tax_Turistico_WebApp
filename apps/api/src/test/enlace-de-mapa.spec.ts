import { describe, expect, it } from 'vitest';
import { enlaceDeMapaValido, puntoDeEnlace } from '@tax/shared';

describe('enlace de ubicación del cliente', () => {
  it('lee el punto del enlace que arma WAHA al compartir la ubicación', () => {
    expect(puntoDeEnlace('https://www.google.com/maps?q=5.7788146,-73.1092632')).toEqual({
      lat: 5.7788146,
      lng: -73.1092632,
    });
  });

  it('en un lugar de Google prefiere el punto marcado al centro de la vista', () => {
    const enlace =
      'https://www.google.com/maps/place/Terminal/@5.7801,-73.1150,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d5.7803456!4d-73.1142345';
    expect(puntoDeEnlace(enlace)).toEqual({ lat: 5.7803456, lng: -73.1142345 });
  });

  it('también entiende query=, %2C, geo: y Waze', () => {
    expect(puntoDeEnlace('https://www.google.com/maps/search/?api=1&query=5.78%2C-73.11')).toBeNull();
    expect(puntoDeEnlace('https://www.google.com/maps/search/?api=1&query=5.780%2C-73.114')).toEqual({ lat: 5.78, lng: -73.114 });
    expect(puntoDeEnlace('geo:5.7803,-73.1142')).toEqual({ lat: 5.7803, lng: -73.1142 });
    expect(puntoDeEnlace('https://waze.com/ul?ll=5.7803,-73.1142&navigate=yes')).toEqual({ lat: 5.7803, lng: -73.1142 });
  });

  it('un enlace corto no trae el punto hasta abrirlo', () => {
    expect(puntoDeEnlace('https://maps.app.goo.gl/AbCdEf123')).toBeNull();
  });

  it('solo acepta enlaces de servicios de mapas', () => {
    expect(enlaceDeMapaValido('https://www.google.com/maps?q=5.7788146,-73.1092632')).not.toBeNull();
    expect(enlaceDeMapaValido('https://maps.app.goo.gl/AbCdEf123')).not.toBeNull();
    expect(enlaceDeMapaValido('https://waze.com/ul?ll=5.78,-73.11')).not.toBeNull();
    // Un enlace cualquiera que llegue por el chat no se le abre al conductor.
    expect(enlaceDeMapaValido('https://estafa.example.com/maps?q=5.78,-73.11')).toBeNull();
    expect(enlaceDeMapaValido('https://www.google.com/url?q=https://estafa.example.com')).toBeNull();
    expect(enlaceDeMapaValido('javascript:alert(1)')).toBeNull();
    expect(enlaceDeMapaValido('no es un enlace')).toBeNull();
  });
});
