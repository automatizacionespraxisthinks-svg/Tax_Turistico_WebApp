import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, MessageSquareQuote, Plus, Trash2, X } from 'lucide-react';
import type { Place, Point } from '@tax/shared';
import {
  MAX_PALABRAS_CLAVE,
  ZONA_POR_DEFECTO,
  buscarLugar,
  normalizarParaBuscar,
  nuevaZonaSchema,
  nuevoLugarSchema,
  pointInPolygon,
  poligonoCircular,
  poligonosSeTocan,
} from '@tax/shared';
import { Banner, Button, Field, Input, Modal, SectionLabel, Segmented, cn, useToast } from '@tax/ui';
import { ApiError, api } from '../api/client';
import { actions, useLive } from '../live/store';
import { SelectorDePunto } from './SelectorDePunto';

const mensajeDe = (error: unknown) =>
  error instanceof ApiError ? error.message : 'No se pudo guardar. Revisa la conexión y vuelve a intentarlo.';

/** El primer problema que encuentra un esquema, para decirlo en una línea. */
function primerError(resultado: { success: boolean; error?: { issues: { message: string }[] } }): string | null {
  return resultado.success ? null : (resultado.error?.issues[0]?.message ?? 'Revisa los datos');
}

/* --------------------------------------------------------------- zona --- */

/**
 * Crear una zona: un círculo con su centro, su radio y su tipo.
 *
 * La vista previa es el mismo polígono que guardará la API. Si se monta sobre
 * otra zona se avisa aquí mismo, antes de enviar, y la API lo vuelve a
 * comprobar: un punto en dos zonas no sabría con qué oleadas despacharse.
 */
export function FormularioZona({ open, onClose }: { open: boolean; onClose: () => void }) {
  const zonas = useLive((s) => s.zones);
  const toast = useToast();
  const [nombre, setNombre] = useState('');
  const [tipo, setTipo] = useState<'urbano' | 'rural'>('urbano');
  const [radio, setRadio] = useState<number>(ZONA_POR_DEFECTO.urbano.radiusKm);
  const [tortuosidad, setTortuosidad] = useState<number>(ZONA_POR_DEFECTO.urbano.tortuosity);
  const [centro, setCentro] = useState<Point>();
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNombre('');
    setTipo('urbano');
    setRadio(ZONA_POR_DEFECTO.urbano.radiusKm);
    setTortuosidad(ZONA_POR_DEFECTO.urbano.tortuosity);
    setCentro(undefined);
    setError(null);
  }, [open]);

  const cambiarTipo = (nuevo: 'urbano' | 'rural') => {
    setTipo(nuevo);
    setRadio(ZONA_POR_DEFECTO[nuevo].radiusKm);
    setTortuosidad(ZONA_POR_DEFECTO[nuevo].tortuosity);
  };

  const encima =
    centro && radio > 0
      ? zonas.find((z) =>
          poligonosSeTocan(
            poligonoCircular(centro.lat, centro.lng, radio).coordinates[0]!.map(([lng, lat]) => ({ lat, lng })),
            z.polygon,
          ),
        )
      : undefined;

  const entrada = { name: nombre, kind: tipo, center: centro, radiusKm: radio, tortuosity: tortuosidad };
  const invalido = centro ? primerError(nuevaZonaSchema.safeParse(entrada)) : 'Toca el mapa para poner el centro';

  const crear = async () => {
    if (invalido || encima) return;
    setGuardando(true);
    setError(null);
    try {
      await api.post('/v1/admin/zones', entrada);
      await actions.refreshZones();
      toast.push({
        tone: 'positive',
        title: 'Zona creada',
        description: `${nombre.trim()}: desde ya se despachan carreras ahí, con las oleadas de ${tipo === 'urbano' ? 'casco urbano' : 'vereda'}.`,
      });
      onClose();
    } catch (causa) {
      setError(mensajeDe(causa));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="lg"
      title="Nueva zona"
      subtitle="Un círculo donde hay servicio. Las carreras que se piden dentro se despachan con sus oleadas."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" loading={guardando} disabled={Boolean(invalido || encima)} onClick={() => void crear()}>
            Crear zona
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <div className="space-y-4">
          <Field label="Nombre" required>
            <Input autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Vereda Rincón de España" />
          </Field>

          <Field label="Tipo" hint="Decide las oleadas con que se despacha: estrechas en el casco, anchas en vereda.">
            <Segmented<'urbano' | 'rural'>
              value={tipo}
              onChange={cambiarTipo}
              options={[
                { value: 'urbano', label: 'Casco urbano' },
                { value: 'rural', label: 'Vereda' },
              ]}
            />
          </Field>

          <Field label="Radio (km)" required hint="De 0,3 a 15 km. El círculo punteado del mapa es la zona.">
            <Input
              type="number"
              step="0.1"
              min="0.3"
              max="15"
              value={Number.isFinite(radio) ? radio : ''}
              onChange={(e) => setRadio(Number(e.target.value))}
            />
          </Field>

          <Field
            label="Factor de tortuosidad"
            hint="Cuánto más larga es la ruta real que la línea recta: 1,3 en el casco, 1,8 en vereda. Afina el tiempo estimado."
          >
            <Input
              type="number"
              step="0.05"
              min="1"
              max="3"
              value={Number.isFinite(tortuosidad) ? tortuosidad : ''}
              onChange={(e) => setTortuosidad(Number(e.target.value))}
            />
          </Field>

          {encima ? (
            <Banner tone="critical" icon={<AlertTriangle className="size-4" />}>
              Se monta sobre «{encima.name}». Mueve el centro o achica el radio.
            </Banner>
          ) : null}
          {error ? (
            <Banner tone="critical" icon={<AlertTriangle className="size-4" />}>
              {error}
            </Banner>
          ) : null}
        </div>

        <SelectorDePunto
          valor={centro}
          onCambiar={setCentro}
          zonas={zonas}
          radioKm={radio}
          tipoVistaPrevia={tipo}
          className="min-h-96"
        />
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- lugar --- */

/**
 * Crear o editar un lugar del catálogo.
 *
 * Lo importante son las palabras clave: así lo nombran los clientes. Con
 * ellas el asistente ubica un pedido que llega sin ubicación y sin dirección
 * —«frente a la terminal», «donde Don Pacho»—, y el taxi va al punto del
 * lugar. El probador de abajo usa la misma búsqueda que la API.
 */
export function FormularioLugar({
  open,
  onClose,
  lugar,
  lugares,
}: {
  open: boolean;
  onClose: () => void;
  /** Con lugar, se edita; sin él, se crea. */
  lugar?: Place;
  lugares: Place[];
}) {
  const zonas = useLive((s) => s.zones);
  const toast = useToast();
  const qc = useQueryClient();
  const [nombre, setNombre] = useState('');
  const [palabras, setPalabras] = useState<string[]>([]);
  const [borrador, setBorrador] = useState('');
  const [avisoPalabra, setAvisoPalabra] = useState<string | null>(null);
  const [punto, setPunto] = useState<Point>();
  const [prueba, setPrueba] = useState('');
  const [guardando, setGuardando] = useState<'guardar' | 'quitar' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNombre(lugar?.name ?? '');
    setPalabras(lugar?.aliases ?? []);
    setPunto(lugar?.point);
    setBorrador('');
    setPrueba('');
    setAvisoPalabra(null);
    setError(null);
  }, [open, lugar]);

  // De quién es cada nombre y palabra clave, sin contar este mismo lugar.
  const ocupadas = new Map<string, string>();
  for (const otro of lugares) {
    if (otro.id === lugar?.id) continue;
    for (const p of [otro.name, ...otro.aliases]) ocupadas.set(normalizarParaBuscar(p), otro.name);
  }

  const agregar = () => {
    const palabra = borrador.trim().replace(/\s+/g, ' ');
    const clave = normalizarParaBuscar(palabra);
    if (!clave) return;
    if (clave.length < 3) return setAvisoPalabra('Necesita al menos 3 letras.');
    if (palabras.some((p) => normalizarParaBuscar(p) === clave)) return setAvisoPalabra('Ya está en la lista.');
    const dueno = ocupadas.get(clave);
    if (dueno) return setAvisoPalabra(`«${palabra}» ya es de «${dueno}»: dos lugares no pueden compartirla.`);
    if (palabras.length >= MAX_PALABRAS_CLAVE) return setAvisoPalabra(`Hasta ${MAX_PALABRAS_CLAVE} palabras clave.`);
    setPalabras([...palabras, palabra]);
    setBorrador('');
    setAvisoPalabra(null);
  };

  const alTeclear = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter o coma agregan la palabra; no envían el formulario.
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      agregar();
    } else if (e.key === 'Backspace' && !borrador && palabras.length) {
      setPalabras(palabras.slice(0, -1));
    }
  };

  const zona = punto ? zonas.find((z) => pointInPolygon(punto, z.polygon)) : undefined;
  const entrada = { name: nombre, aliases: palabras, point: punto };
  const invalido = !punto
    ? 'Toca el mapa para poner el punto del lugar'
    : !zona
      ? 'El punto queda fuera de las zonas con servicio'
      : ocupadas.get(normalizarParaBuscar(nombre))
        ? `«${nombre.trim()}» ya está en el catálogo como «${ocupadas.get(normalizarParaBuscar(nombre))}»`
        : primerError(nuevoLugarSchema.safeParse(entrada));

  const reconocido = prueba.trim()
    ? buscarLugar(prueba, [{ id: 'este', name: nombre || '—', aliases: palabras, uses: 0 }])
    : null;
  const deOtro = prueba.trim() && !reconocido ? buscarLugar(prueba, lugares.filter((l) => l.id !== lugar?.id)) : null;

  const guardar = async () => {
    if (invalido) return;
    setGuardando('guardar');
    setError(null);
    try {
      if (lugar) await api.patch(`/v1/admin/places/${lugar.id}`, entrada);
      else await api.post('/v1/admin/places', entrada);
      await qc.invalidateQueries({ queryKey: ['places'] });
      toast.push({
        tone: 'positive',
        title: lugar ? 'Lugar actualizado' : 'Lugar agregado al catálogo',
        description: palabras.length
          ? `El asistente lo reconoce por ${palabras.length} ${palabras.length === 1 ? 'palabra clave' : 'palabras clave'} y por su nombre.`
          : 'El asistente lo reconoce por su nombre. Con palabras clave lo reconocería mejor.',
      });
      onClose();
    } catch (causa) {
      setError(mensajeDe(causa));
    } finally {
      setGuardando(null);
    }
  };

  const quitar = async () => {
    if (!lugar) return;
    setGuardando('quitar');
    setError(null);
    try {
      await api.patch(`/v1/admin/places/${lugar.id}`, { active: false });
      await qc.invalidateQueries({ queryKey: ['places'] });
      toast.push({ tone: 'info', title: 'Lugar quitado del catálogo', description: `${lugar.name} ya no se reconoce en los pedidos.` });
      onClose();
    } catch (causa) {
      setError(mensajeDe(causa));
    } finally {
      setGuardando(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="lg"
      title={lugar ? `Editar «${lugar.name}»` : 'Nuevo lugar'}
      subtitle="Un sitio de Paipa que los clientes nombran sin dirección. El taxi va al punto que marques."
      footer={
        <>
          {lugar ? (
            <Button
              variant="ghost-danger"
              icon={<Trash2 className="size-3.5" />}
              loading={guardando === 'quitar'}
              onClick={() => void quitar()}
              className="mr-auto"
            >
              Quitar del catálogo
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" loading={guardando === 'guardar'} disabled={Boolean(invalido)} onClick={() => void guardar()}>
            {lugar ? 'Guardar' : 'Agregar lugar'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-5">
          <Field label="Nombre del lugar" required>
            <Input autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Terminal de transporte" />
          </Field>

          {/* Lugares frecuentes: cómo lo dice la gente. */}
          <section className="space-y-2.5 rounded-lg border border-line bg-surface-sunk p-3.5">
            <div>
              <SectionLabel>Cómo lo nombran los clientes</SectionLabel>
              <p className="mt-1 text-caption text-ink-muted">
                Palabras clave para que el asistente reconozca el lugar aunque el cliente no dé una dirección.
                Escríbelas como las dicen: «la terminal», «donde Don Pacho», «frente a la iglesia».
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {palabras.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--brand-line)] bg-accent-soft py-0.5 pl-2.5 pr-1 text-caption text-accent-ink"
                >
                  {p}
                  <button
                    type="button"
                    aria-label={`Quitar «${p}»`}
                    onClick={() => setPalabras(palabras.filter((x) => x !== p))}
                    className="flex size-4 items-center justify-center rounded-full hover:bg-surface"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {palabras.length === 0 ? (
                <span className="text-caption text-ink-muted">Todavía ninguna: solo lo reconocería por su nombre.</span>
              ) : null}
            </div>

            <div className="flex gap-2">
              <Input
                value={borrador}
                onChange={(e) => {
                  setBorrador(e.target.value);
                  setAvisoPalabra(null);
                }}
                onKeyDown={alTeclear}
                placeholder="Escribe una y pulsa Enter"
                aria-label="Nueva palabra clave"
                className="flex-1"
              />
              <Button variant="secondary" icon={<Plus className="size-3.5" />} onClick={agregar} disabled={!borrador.trim()}>
                Agregar
              </Button>
            </div>
            <p className={cn('text-micro', avisoPalabra ? 'text-[var(--t-critical-ink)]' : 'text-ink-muted')}>
              {avisoPalabra ?? `${palabras.length} de ${MAX_PALABRAS_CLAVE}. Mayúsculas y tildes no importan.`}
            </p>

            <div className="space-y-1.5 border-t border-line pt-2.5">
              <label className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-[0.06em] text-ink-muted">
                <MessageSquareQuote className="size-3.5" />
                Pruébalo como lo escribiría un cliente
              </label>
              <Input value={prueba} onChange={(e) => setPrueba(e.target.value)} placeholder="Estoy frente a la terminal, al lado de la panadería" />
              {prueba.trim() ? (
                reconocido ? (
                  <p className="flex items-center gap-1.5 text-caption text-[var(--t-positive-ink)]">
                    <CheckCircle2 className="size-3.5" />
                    Lo reconoce por «{reconocido.palabra}».
                  </p>
                ) : deOtro ? (
                  <p className="flex items-center gap-1.5 text-caption text-[var(--t-warning-ink)]">
                    <AlertTriangle className="size-3.5" />
                    Reconocería otro lugar: «{deOtro.lugar.name}», por «{deOtro.palabra}».
                  </p>
                ) : (
                  <p className="flex items-center gap-1.5 text-caption text-ink-muted">
                    <AlertTriangle className="size-3.5" />
                    No lo reconoce. Agrega la palabra que usó el cliente.
                  </p>
                )
              ) : null}
            </div>
          </section>

          {error ? (
            <Banner tone="critical" icon={<AlertTriangle className="size-4" />}>
              {error}
            </Banner>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <SectionLabel>Dónde queda</SectionLabel>
          <SelectorDePunto valor={punto} onCambiar={setPunto} zonas={zonas} className="min-h-96 flex-1" />
          {punto ? (
            zona ? (
              <p className="text-caption text-ink-secondary">
                Queda en <span className="font-semibold text-ink">{zona.name}</span> ·{' '}
                {zona.kind === 'rural' ? 'vereda' : 'casco urbano'}
              </p>
            ) : (
              <p className="flex items-center gap-1.5 text-caption text-[var(--t-critical-ink)]">
                <AlertTriangle className="size-3.5" />
                Fuera de las zonas con servicio: allí no se despacha.
              </p>
            )
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

