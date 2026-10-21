import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { Check, Copy, Download, KeyRound, ShieldCheck, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { Button, Field, Input, transition } from '@tax/ui';
import { ApiError, api } from '../api/client';

interface User {
  id: string;
  name: string;
  role: 'administrador' | 'operador';
  /** Si no, la sesión solo sirve para darlo de alta (§8.1). */
  totpEnabled: boolean;
}

/**
 * Acceso de la oficina (§8.1).
 *
 * El panel pregunta primero si ya hay sesión: la cookie es HttpOnly, así que
 * el navegador la tiene pero JavaScript no puede leerla. Un 401 significa
 * «muestra el acceso», y es la única señal fiable.
 *
 * Hay un tercer estado entre «sin sesión» y «dentro»: con sesión pero sin
 * segundo factor. El servidor responde `TOTP_SETUP_REQUIRED` a todo lo demás,
 * así que no es una recomendación de la interfaz sino una puerta cerrada.
 */
export function AuthGate({ children }: { children: (user: User) => ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    api
      .get<{ user: User }>('/v1/auth/me')
      .then((response) => {
        if (!cancelled) setUser(response.user);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (checking) {
    return (
      <div className="flex h-dvh items-center justify-center bg-canvas">
        <p className="animate-breathe text-base text-ink-muted">Comprobando la sesión…</p>
      </div>
    );
  }

  if (!user) return <LoginScreen onSuccess={setUser} />;

  if (!user.totpEnabled) {
    return <TotpEnrollment onDone={() => setUser({ ...user, totpEnabled: true })} />;
  }

  return <>{children(user)}</>;
}

/** Marco común de las tres pantallas previas al panel. */
function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-5 py-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transition.panel}
        className={`w-full ${wide ? 'max-w-md' : 'max-w-sm'} space-y-6 rounded-lg border border-line bg-surface p-6`}
      >
        {children}
      </motion.div>
    </div>
  );
}

function Logo() {
  return (
    <div
      aria-hidden="true"
      className="mb-5 flex size-10 items-center justify-center rounded-md border border-line bg-surface-sunk"
    >
      <svg viewBox="0 0 16 16" className="size-5 text-ink-secondary" fill="none">
        <path
          d="M2.5 11.5 8 3l5.5 8.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="11.6" r="1.4" fill="currentColor" />
      </svg>
    </div>
  );
}

/* ----------------------------------------------------------- el acceso --- */

function LoginScreen({ onSuccess }: { onSuccess: (user: User) => void }) {
  const [email, setEmail] = useState('operadora@taxturistico.local');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  // El código no se pide de entrada: hasta que la contraseña no es correcta,
  // el servidor ni siquiera dice si esta cuenta tiene segundo factor.
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (needsCode) codeRef.current?.focus();
  }, [needsCode]);

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);

    try {
      const response = await api.post<{ user: User }>('/v1/auth/session', {
        email,
        password,
        totp: totp.trim() || undefined,
      });
      onSuccess(response.user);
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : undefined;

      if (code === 'TOTP_REQUIRED') {
        setNeedsCode(true);
        setError(undefined);
        return;
      }

      if (code === 'TOTP_INVALID') {
        setNeedsCode(true);
        setTotp('');
        setError('Código incorrecto o ya usado. Mira el siguiente en tu teléfono.');
        return;
      }

      // El mensaje no distingue si el correo existe: enumerar usuarios es el
      // primer paso de cualquier ataque por fuerza bruta (§8.2).
      setError(
        code === 'NETWORK'
          ? 'No hay conexión con el servidor.'
          : 'Correo o contraseña incorrectos.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Shell>
      <div>
        <Logo />
        <h1 className="text-title font-semibold text-ink">Panel de oficina</h1>
        <p className="mt-1 text-caption text-ink-muted">Tax Turístico · despacho de carreras</p>
      </div>

      <div className="space-y-4">
        <Field label="Correo" htmlFor="email" required>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            disabled={needsCode}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field label="Contraseña" htmlFor="password" required error={needsCode ? undefined : error}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            disabled={needsCode}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void submit()}
          />
        </Field>

        {needsCode ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            transition={transition.enter}
          >
            <Field
              label="Código de tu aplicación"
              htmlFor="totp"
              required
              error={error}
              hint="Seis dígitos, o uno de tus códigos de respaldo si perdiste el teléfono."
            >
              <Input
                ref={codeRef}
                id="totp"
                inputMode="text"
                autoComplete="one-time-code"
                placeholder="000000"
                value={totp}
                onChange={(event) => setTotp(event.target.value.toUpperCase())}
                onKeyDown={(event) => event.key === 'Enter' && void submit()}
                className="font-mono text-lg tracking-[0.3em]"
              />
            </Field>
          </motion.div>
        ) : null}
      </div>

      <Button
        variant="primary"
        size="lg"
        className="w-full"
        loading={submitting}
        onClick={() => void submit()}
      >
        {needsCode ? 'Confirmar' : 'Entrar'}
      </Button>

      <p className="flex items-start gap-2 text-micro text-ink-muted">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        La sesión caduca a las 12 horas y la cuenta se bloquea 15 minutos tras cinco intentos
        fallidos.
      </p>
    </Shell>
  );
}

/* -------------------------------------------------------------- el alta --- */

/**
 * Alta del segundo factor, obligatoria antes de usar el panel.
 *
 * Tres momentos: escanear, confirmar y guardar los repuestos. El tercero no
 * se puede repetir —en la base solo queda el hash— y por eso hay que marcar
 * explícitamente que se guardaron.
 */
function TotpEnrollment({ onDone }: { onDone: () => void }) {
  const [secret, setSecret] = useState<string>();
  const [qr, setQr] = useState<string>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();

  useEffect(() => {
    let cancelled = false;

    api
      .post<{ secret: string; uri: string }>('/v1/auth/totp/setup')
      .then(async (response) => {
        if (cancelled) return;
        setSecret(response.secret);
        // `margin: 0` porque el marco lo pone el contenedor; el QR necesita
        // su zona de silencio, y se la da el padding blanco de abajo.
        setQr(await QRCode.toString(response.uri, { type: 'svg', margin: 0 }));
      })
      .catch(() => {
        if (!cancelled) setError('No se pudo preparar el segundo factor. Recarga la página.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const activate = async () => {
    setSubmitting(true);
    setError(undefined);

    try {
      const response = await api.post<{ recoveryCodes: string[] }>('/v1/auth/totp/activate', {
        code: code.trim(),
      });
      setRecoveryCodes(response.recoveryCodes);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === 'TOTP_INVALID'
          ? 'El código no coincide. Comprueba que la hora del teléfono sea la correcta.'
          : 'No se pudo activar. Inténtalo de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (recoveryCodes) return <RecoveryCodes codes={recoveryCodes} onDone={onDone} />;

  return (
    <Shell wide>
      <div>
        <Logo />
        <h1 className="text-title font-semibold text-ink">Activa el segundo factor</h1>
        <p className="mt-1 text-base text-ink-secondary">
          El panel ve el teléfono y la dirección de todos los clientes. Una contraseña sola no
          basta para abrirlo.
        </p>
      </div>

      <ol className="space-y-5">
        <Step number={1} icon={<Smartphone className="size-4" />} title="Escanea este código">
          <p className="text-base text-ink-secondary">
            Con Google Authenticator, Aegis, 1Password o la aplicación que ya uses.
          </p>

          {/*
            El QR va siempre sobre blanco, también en modo oscuro: invertido,
            muchos lectores no lo reconocen y el operador se queda mirando un
            cuadro que no hace nada.
          */}
          <div className="mt-3 flex justify-center">
            {qr ? (
              <div
                className="rounded-md bg-white p-4 [&>svg]:size-44"
                dangerouslySetInnerHTML={{ __html: qr }}
              />
            ) : (
              <div className="animate-breathe size-[13rem] rounded-md border border-line bg-surface-sunk" />
            )}
          </div>

          {secret ? (
            <div className="mt-3">
              <p className="text-caption text-ink-muted">Si la cámara no coopera, escríbelo:</p>
              <p className="mt-1 select-all break-all font-mono text-caption tracking-[0.12em] text-ink-secondary">
                {secret.replace(/(.{4})/g, '$1 ').trim()}
              </p>
            </div>
          ) : null}
        </Step>

        <Step number={2} icon={<KeyRound className="size-4" />} title="Escribe el código que aparece">
          <Field label="Código de seis dígitos" htmlFor="code" required error={error}>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              onKeyDown={(event) => event.key === 'Enter' && void activate()}
              className="font-mono text-lg tracking-[0.3em]"
            />
          </Field>
        </Step>
      </ol>

      <Button
        variant="primary"
        size="lg"
        className="w-full"
        loading={submitting}
        disabled={code.length !== 6 || !secret}
        onClick={() => void activate()}
      >
        Activar
      </Button>
    </Shell>
  );
}

function Step({
  number,
  icon,
  title,
  children,
}: {
  number: number;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface-sunk text-ink-secondary"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-medium text-ink">
          <span className="text-ink-muted">{number}.</span> {title}
        </h2>
        <div className="mt-1.5">{children}</div>
      </div>
    </li>
  );
}

/* ------------------------------------------------------ los repuestos --- */

/**
 * Los códigos de respaldo, que solo se ven una vez.
 *
 * En la base queda el hash, así que no hay forma de volver a enseñarlos. Es
 * incómodo a propósito, pero el día del teléfono roto son la diferencia entre
 * una llamada y una oficina parada.
 */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const texto = [
    'Códigos de respaldo · Panel de Tax Turístico',
    'Cada uno sirve una sola vez. Guárdalos donde no estén junto a la contraseña.',
    '',
    ...codes,
  ].join('\n');

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sin permiso de portapapeles quedan la descarga y el papel.
    }
  };

  const descargar = () => {
    const url = URL.createObjectURL(new Blob([texto], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'codigos-respaldo-tax-turistico.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Shell wide>
      <div>
        <Logo />
        <h1 className="text-title font-semibold text-ink">Guarda estos códigos</h1>
        <p className="mt-1 text-base text-ink-secondary">
          Son tu única forma de entrar si pierdes el teléfono. Cada uno sirve una vez y no se
          pueden volver a mostrar.
        </p>
      </div>

      <ul className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface-sunk p-4">
        {codes.map((code) => (
          <li key={code} className="select-all font-mono text-base tracking-[0.06em] text-ink">
            {code}
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <Button
          className="flex-1"
          icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          onClick={() => void copiar()}
        >
          {copied ? 'Copiados' : 'Copiar'}
        </Button>
        <Button className="flex-1" icon={<Download className="size-4" />} onClick={descargar}>
          Descargar
        </Button>
      </div>

      <label className="flex cursor-pointer items-start gap-2.5 text-base text-ink-secondary">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          className="mt-1 size-4 accent-[var(--c-accent)]"
        />
        Los guardé en un sitio seguro, separado de mi contraseña.
      </label>

      <Button variant="primary" size="lg" className="w-full" disabled={!saved} onClick={onDone}>
        Entrar al panel
      </Button>
    </Shell>
  );
}
