import { useState } from 'react';
import { Download, Search, ShieldCheck, UserX } from 'lucide-react';
import { formatDateTime } from '@tax/shared';
import { Banner, Button, Card, CardHeader, Field, Input, Modal, SectionLabel, StatusPill, useToast } from '@tax/ui';
import { ApiError, api } from '../api/client';

interface Titular {
  id: string;
  telefono: string;
  nombre: string | null;
  desde: string;
  autorizacionVersion: string | null;
  autorizacionFecha: string | null;
  autorizacionCanal: string | null;
  suprimidoAt: string | null;
  carreras: number;
  abiertas: number;
  ultimaCarrera: string | null;
}

/**
 * Solicitudes de los titulares de datos (Ley 1581 de 2012; 17/11/2026).
 *
 * Un cliente puede pedir saber qué datos suyos tiene la empresa (consulta,
 * hay 10 días hábiles para responder) o que se borren (reclamo de supresión,
 * 15 días hábiles). La oficina lo busca por su teléfono y:
 *
 * - **Descargar sus datos**: un archivo con todo lo que el sistema guarda de
 *   esa persona, para entregárselo.
 * - **Suprimir sus datos**: borra teléfono, nombre, direcciones, notas y
 *   fotos. Las carreras quedan para las cifras, sin nada que lo identifique.
 *
 * Las dos quedan en la bitácora con quién las hizo. La conversación de
 * WhatsApp vive en Chatwoot y se borra allá.
 */
export function DatosPersonales() {
  const { push } = useToast();
  const [telefono, setTelefono] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [titular, setTitular] = useState<Titular | null>(null);
  const [descargando, setDescargando] = useState(false);
  const [suprimir, setSuprimir] = useState(false);

  const buscar = async () => {
    setBuscando(true);
    setError(null);
    setTitular(null);
    try {
      setTitular(await api.get<Titular>(`/v1/admin/customers/titular?telefono=${encodeURIComponent(telefono)}`));
    } catch (causa) {
      setError(causa instanceof ApiError ? causa.message : 'No se pudo buscar.');
    } finally {
      setBuscando(false);
    }
  };

  const descargar = async () => {
    if (!titular) return;
    setDescargando(true);
    try {
      const datos = await api.get<unknown>(`/v1/admin/customers/${titular.id}/datos`);
      const archivo = new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' });
      const enlace = document.createElement('a');
      enlace.href = URL.createObjectURL(archivo);
      enlace.download = `datos-cliente-${new Date().toISOString().slice(0, 10)}.json`;
      enlace.click();
      URL.revokeObjectURL(enlace.href);
      push({ tone: 'positive', title: 'Datos descargados', description: 'Entrégaselos al titular por el canal en que los pidió.' });
    } catch (causa) {
      push({ tone: 'critical', title: 'No se pudieron descargar', description: causa instanceof ApiError ? causa.message : undefined });
    } finally {
      setDescargando(false);
    }
  };

  const suprimido = Boolean(titular?.suprimidoAt);

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <CardHeader
          title="Solicitudes de datos personales"
          subtitle="Cuando un cliente pide conocer sus datos o que se borren (Ley 1581 de 2012). Hay 10 días hábiles para responder una consulta y 15 para un reclamo."
        />
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Teléfono del cliente" htmlFor="tel-titular" className="min-w-60 flex-1">
            <Input
              id="tel-titular"
              inputMode="tel"
              value={telefono}
              maxLength={20}
              placeholder="310 123 4567"
              onChange={(e) => setTelefono(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && telefono.trim() && void buscar()}
            />
          </Field>
          <Button variant="primary" icon={<Search className="size-4" />} loading={buscando} disabled={!telefono.trim()} onClick={() => void buscar()}>
            Buscar
          </Button>
        </div>
        {error ? <Banner tone="warning">{error}</Banner> : null}
      </Card>

      {titular ? (
        <Card className="space-y-4">
          <CardHeader
            title={suprimido ? 'Datos suprimidos' : titular.nombre ?? 'Cliente sin nombre'}
            subtitle={suprimido ? `Se suprimieron el ${formatDateTime(titular.suprimidoAt!)}.` : titular.telefono}
            actions={
              titular.autorizacionVersion ? (
                <StatusPill tone="positive">Autorización registrada</StatusPill>
              ) : (
                <StatusPill tone="warning">Sin autorización registrada</StatusPill>
              )
            }
          />

          <dl className="grid gap-3 text-base sm:grid-cols-2">
            <Dato etiqueta="Cliente desde">{formatDateTime(titular.desde)}</Dato>
            <Dato etiqueta="Carreras">
              {titular.carreras}
              {titular.abiertas ? ` · ${titular.abiertas} abierta${titular.abiertas === 1 ? '' : 's'}` : ''}
            </Dato>
            <Dato etiqueta="Autorización">
              {titular.autorizacionVersion
                ? `Política v${titular.autorizacionVersion} · ${formatDateTime(titular.autorizacionFecha!)} · ${titular.autorizacionCanal ?? ''}`
                : 'No hay registro: se pidió antes de que el sistema la guardara'}
            </Dato>
            <Dato etiqueta="Última carrera">{titular.ultimaCarrera ? formatDateTime(titular.ultimaCarrera) : '—'}</Dato>
          </dl>

          <div className="flex flex-wrap gap-2">
            <Button icon={<Download className="size-4" />} loading={descargando} onClick={() => void descargar()}>
              Descargar sus datos
            </Button>
            {!suprimido ? (
              <Button variant="danger" icon={<UserX className="size-4" />} onClick={() => setSuprimir(true)}>
                Suprimir sus datos
              </Button>
            ) : null}
          </div>

          <p className="flex items-start gap-2 text-caption text-ink-muted">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            La conversación de WhatsApp vive en Chatwoot y en la memoria del asistente: para entregarla o borrarla
            hay que hacerlo allá.
          </p>
        </Card>
      ) : null}

      {titular ? (
        <ConfirmarSupresion
          abierta={suprimir}
          titular={titular}
          onCerrar={() => setSuprimir(false)}
          onHecho={() => {
            setSuprimir(false);
            void buscar();
          }}
        />
      ) : null}
    </div>
  );
}

function Dato({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-micro uppercase tracking-[0.06em] text-ink-muted">{etiqueta}</dt>
      <dd className="mt-0.5 text-ink">{children}</dd>
    </div>
  );
}

/** Suprimir no se deshace: se escribe el motivo y la palabra SUPRIMIR. */
function ConfirmarSupresion({
  abierta,
  titular,
  onCerrar,
  onHecho,
}: {
  abierta: boolean;
  titular: Titular;
  onCerrar: () => void;
  onHecho: () => void;
}) {
  const { push } = useToast();
  const [motivo, setMotivo] = useState('');
  const [confirmacion, setConfirmacion] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listo = motivo.trim().length >= 5 && confirmacion.trim().toUpperCase() === 'SUPRIMIR' && titular.abiertas === 0;

  const confirmar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = await api.post<{ carreras: number; pendienteFuera: string }>(`/v1/admin/customers/${titular.id}/suprimir`, {
        motivo: motivo.trim(),
      });
      push({
        tone: 'positive',
        title: 'Datos suprimidos',
        description: `Se limpiaron ${r.carreras} carrera${r.carreras === 1 ? '' : 's'}. ${r.pendienteFuera}`,
      });
      setMotivo('');
      setConfirmacion('');
      onHecho();
    } catch (causa) {
      setError(causa instanceof ApiError ? causa.message : 'No se pudo suprimir.');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal
      open={abierta}
      onClose={() => !enviando && onCerrar()}
      title="Suprimir los datos de este cliente"
      subtitle="No se puede deshacer. Se borran su teléfono, su nombre, las direcciones, las notas y las fotos de sus carreras; las carreras quedan en las cifras sin nada que lo identifique."
      footer={
        <>
          <Button variant="ghost" disabled={enviando} onClick={onCerrar}>
            Cancelar
          </Button>
          <Button variant="danger" loading={enviando} disabled={!listo} onClick={() => void confirmar()}>
            Suprimir
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {titular.abiertas > 0 ? (
          <Banner tone="warning">Tiene una carrera abierta: espera a que termine o cancélala primero.</Banner>
        ) : null}
        <SectionLabel>{titular.telefono}</SectionLabel>
        <Field label="Motivo o número de la solicitud" htmlFor="motivo-supresion">
          <Input
            id="motivo-supresion"
            value={motivo}
            maxLength={200}
            placeholder="Solicitud por WhatsApp del 17/11/2026"
            onChange={(e) => setMotivo(e.target.value)}
          />
        </Field>
        <Field label="Escribe SUPRIMIR para confirmar" htmlFor="confirmar-supresion" error={error ?? undefined}>
          <Input id="confirmar-supresion" value={confirmacion} onChange={(e) => setConfirmacion(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
