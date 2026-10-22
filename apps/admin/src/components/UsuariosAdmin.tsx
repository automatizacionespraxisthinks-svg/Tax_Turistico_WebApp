import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Check, Copy, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { formatRelative } from '@tax/shared';
import {
  Banner,
  Button,
  Card,
  CardHeader,
  Sheet,
  StatusPill,
  transition,
  useToast,
} from '@tax/ui';
import { api } from '../api/client';

/**
 * Usuarios de la oficina (§8.1). Solo lo ven los administradores.
 *
 * Dos cosas y nada más: ver quiénes son y generar una contraseña nueva. La
 * anterior no se puede consultar —en la base vive su hash Argon2—, así que
 * «recuperar el acceso» siempre significa generar otra.
 *
 * Aquí NO se reinicia el segundo factor de nadie, y es deliberado: si un
 * administrador pudiera reiniciar contraseña y 2FA de otro, podría entrar en
 * su cuenta. Eso se queda en el terminal del servidor.
 */

interface Usuario {
  id: string;
  email: string;
  name: string;
  role: 'administrador' | 'operador';
  active: boolean;
  totpEnabled: boolean;
  lastLoginAt: string | null;
  locked: boolean;
}

function ClaveUnaVez({
  email,
  password,
  onCerrar,
}: {
  email: string;
  password: string;
  onCerrar: () => void;
}) {
  const [copiado, setCopiado] = useState(false);

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // Sin permiso de portapapeles queda leerla de la pantalla.
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition.enter}
      className="space-y-4"
    >
      <Banner tone="warning">
        Esta contraseña no se vuelve a mostrar. Entrégasela a {email} por un canal seguro.
      </Banner>

      <div className="rounded-lg border border-line bg-surface-sunk p-5 text-center">
        <p className="text-caption text-ink-muted">Contraseña nueva</p>
        <p className="mt-1 select-all break-all font-mono text-title font-semibold text-ink">
          {password}
        </p>
      </div>

      <Banner tone="info">
        Su segundo factor sigue activo: al entrar le pedirá el código de su aplicación. Y sus
        sesiones abiertas quedaron cerradas.
      </Banner>

      <div className="flex gap-2">
        <Button
          className="flex-1"
          icon={copiado ? <Check className="size-4" /> : <Copy className="size-4" />}
          onClick={() => void copiar()}
        >
          {copiado ? 'Copiada' : 'Copiar'}
        </Button>
        <Button variant="primary" className="flex-1" onClick={onCerrar}>
          Ya la entregué
        </Button>
      </div>
    </motion.div>
  );
}

export function UsuariosAdmin() {
  const [reiniciando, setReiniciando] = useState<Usuario | null>(null);
  const [clave, setClave] = useState<{ email: string; password: string } | null>(null);
  const toast = useToast();
  const qc = useQueryClient();

  const usuarios = useQuery({
    queryKey: ['usuarios'],
    queryFn: () => api.get<Usuario[]>('/v1/admin/users'),
  });

  const reiniciar = useMutation({
    mutationFn: (userId: string) =>
      api.post<{ email: string; password: string }>(`/v1/admin/users/${userId}/password`),
    onSuccess: async (r) => {
      setClave(r);
      await qc.invalidateQueries({ queryKey: ['usuarios'] });
    },
    onError: () => toast.push({ tone: 'critical', title: 'No se pudo reiniciar la contraseña' }),
  });

  return (
    <>
      <Card className="space-y-3">
        <CardHeader
          title="Usuarios de la oficina"
          subtitle="La contraseña no se puede consultar: solo existe su hash. Si alguien la olvida, se genera otra."
        />

        <div className="space-y-2">
          {usuarios.isLoading ? (
            <p className="text-caption text-ink-muted">Cargando…</p>
          ) : (
            (usuarios.data ?? []).map((u) => (
              <div
                key={u.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-ink">{u.name}</p>
                  <p className="truncate text-micro text-ink-muted">{u.email}</p>
                  <p className="mt-1 text-micro text-ink-muted">
                    {u.lastLoginAt ? `Último acceso ${formatRelative(u.lastLoginAt)}` : 'Nunca ha entrado'}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <StatusPill tone={u.role === 'administrador' ? 'info' : 'neutral'}>
                    {u.role}
                  </StatusPill>

                  {/* El 2FA se enseña porque es lo que decide si esa persona
                      puede usar el panel: sin él, el servidor no la deja pasar. */}
                  <StatusPill tone={u.totpEnabled ? 'positive' : 'warning'}>
                    {u.totpEnabled ? (
                      <>
                        <ShieldCheck className="size-3" /> 2FA
                      </>
                    ) : (
                      <>
                        <ShieldOff className="size-3" /> sin 2FA
                      </>
                    )}
                  </StatusPill>

                  {u.locked ? <StatusPill tone="critical">bloqueado</StatusPill> : null}

                  <Button
                    size="sm"
                    icon={<KeyRound className="size-4" />}
                    onClick={() => setReiniciando(u)}
                  >
                    Reiniciar contraseña
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        <p className="text-micro text-ink-muted">
          Crear usuarios y reiniciar un segundo factor perdido se hacen desde el terminal del
          servidor. Lo segundo a propósito: desde aquí, un administrador podría entrar en la cuenta
          de otro.
        </p>
      </Card>

      <Sheet
        open={reiniciando !== null}
        onClose={clave ? () => undefined : () => setReiniciando(null)}
        title={clave ? 'Contraseña reiniciada' : 'Reiniciar contraseña'}
        subtitle={clave ? undefined : reiniciando?.email}
      >
        {clave ? (
          <ClaveUnaVez
            email={clave.email}
            password={clave.password}
            onCerrar={() => {
              toast.push({ tone: 'positive', title: 'Contraseña reiniciada' });
              setClave(null);
              setReiniciando(null);
            }}
          />
        ) : reiniciando ? (
          <div className="space-y-4">
            <p className="text-base text-ink-secondary">
              Se generará una contraseña nueva para <strong className="text-ink">{reiniciando.name}</strong> y
              se mostrará una sola vez.
            </p>

            <ul className="space-y-2 rounded-md border border-line p-3 text-base text-ink-secondary">
              <li>Sus sesiones abiertas se cerrarán.</li>
              <li>
                Su segundo factor {reiniciando.totpEnabled ? 'sigue activo' : 'sigue sin activarse'}:
                no se toca desde aquí.
              </li>
              <li>La contraseña anterior deja de servir de inmediato.</li>
            </ul>

            <Button
              variant="primary"
              size="lg"
              className="w-full"
              loading={reiniciar.isPending}
              onClick={() => reiniciar.mutate(reiniciando.id)}
            >
              Generar contraseña nueva
            </Button>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}
