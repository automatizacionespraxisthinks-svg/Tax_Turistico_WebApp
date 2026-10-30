import type { Point } from './geo';

/**
 * El enlace de ubicación que manda el cliente por WhatsApp.
 *
 * Al compartir la ubicación, a n8n le llega un enlace de mapa
 * (`https://www.google.com/maps?q=5.7788146,-73.1092632`, o el que arme la
 * integración). La carrera lo guarda tal cual: el botón «Ir con Maps» del
 * conductor abre ese mismo enlace, y «Ir con Waze» el mismo punto, leído de
 * él (Waze no abre enlaces de Google).
 *
 * Solo se aceptan enlaces de servicios de mapas conocidos. El enlace lo abre
 * el teléfono del conductor, así que uno cualquiera —que llega desde un chat
 * con un desconocido— no puede pasar.
 */

const HOSTS_DE_MAPA = [
  /^(www\.)?google\.[a-z.]+$/,
  /^maps\.google\.[a-z.]+$/,
  /^maps\.app\.goo\.gl$/,
  /^goo\.gl$/,
  /^(www\.)?waze\.com$/,
  /^maps\.apple\.com$/,
  /^(www\.)?openstreetmap\.org$/,
];

/** El enlace, si es de un servicio de mapas; si no, nada. */
export function enlaceDeMapaValido(enlace: string | null | undefined): string | null {
  if (!enlace) return null;
  let url: URL;
  try {
    url = new URL(enlace.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (!HOSTS_DE_MAPA.some((re) => re.test(host))) return null;
  // `google.com/algo` no es un mapa: tiene que ir por /maps, salvo en los
  // hosts que solo sirven mapas.
  if (/^(www\.)?google\./.test(host) && !url.pathname.startsWith('/maps')) return null;
  if (host === 'goo.gl' && !url.pathname.startsWith('/maps')) return null;
  return url.toString();
}

const LAT = '(-?\\d{1,2}\\.\\d{3,})';
const LNG = '(-?\\d{1,3}\\.\\d{3,})';
const PATRONES = [
  // ?q=5.77,-73.10  ?query=  ?ll=  ?destination=  ?daddr=  (también con %2C)
  new RegExp(`[?&](?:q|query|ll|sll|destination|daddr|center)=(?:loc:)?\\s*${LAT}\\s*(?:,|%2C)\\s*${LNG}`, 'i'),
  // /@5.77,-73.10,17z
  new RegExp(`@${LAT},${LNG}`),
  // !3d5.77!4d-73.10 (el punto marcado de un lugar de Google)
  new RegExp(`!3d${LAT}!4d${LNG}`),
  // geo:5.77,-73.10
  new RegExp(`geo:${LAT},${LNG}`, 'i'),
];

/**
 * Las coordenadas que trae el enlace, o nada si no las trae (un enlace corto
 * de `maps.app.goo.gl` no las trae hasta que se abre).
 */
export function puntoDeEnlace(enlace: string | null | undefined): Point | null {
  if (!enlace) return null;
  // `!3d…!4d…` es el punto exacto; `@` es el centro de la vista. Si vienen
  // los dos, manda el primero.
  const ordenados = [PATRONES[2]!, PATRONES[0]!, PATRONES[1]!, PATRONES[3]!];
  for (const re of ordenados) {
    const m = enlace.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) {
      return { lat, lng };
    }
  }
  return null;
}
