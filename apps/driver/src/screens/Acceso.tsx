import { useState } from 'react';
import { motion } from 'motion/react';
import { ShieldCheck } from 'lucide-react';
import { Instalar } from '../components/Instalar';
import { Button, Field, Input, transition } from '@tax/ui';
import { Screen } from '../components/Chrome';
import logo from '../assets/logo-tax-turistico.png';

/**
 * Acceso del conductor: código + placa + PIN personal (§8.1).
 *
 * El código circula entre compañeros y la placa es pública, así que ninguno de
 * los dos basta: el PIN es personal y el dispositivo queda registrado, de modo
 * que la oficina puede revocar un celular perdido.
 */
export function Acceso({
  onSubmit,
}: {
  onSubmit: (code: string, plate: string, pin: string) => Promise<string | null>;
}) {
  const [code, setCode] = useState('101');
  const [plate, setPlate] = useState('UBP472');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (pin.length < 4) {
      setError('El PIN tiene entre 4 y 6 dígitos.');
      return;
    }

    setError(undefined);
    setSubmitting(true);
    try {
      const failure = await onSubmit(code.trim(), plate.trim().toUpperCase(), pin);
      if (failure) setError(failure);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen className="justify-center">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transition.panel}
        className="space-y-6"
      >
        <div>
          {/* El logo grande va aquí: es lo primero que ve el conductor y lo
              que le dice que esta es la aplicación de la empresa. */}
          <img
            src={logo}
            alt="Logo Tax Turístico"
            width={64}
            height={64}
            className="mb-5 size-16 rounded-full bg-surface shadow-sm"
          />
          <h1 className="text-display font-semibold tracking-[-0.02em] text-ink">Entrar al turno</h1>
          <p className="mt-1.5 text-lg text-ink-secondary">
            Tax Turístico · aplicación de conductores
          </p>
        </div>

        <div className="space-y-4">
          <Field label="Código de conductor" htmlFor="code" required>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="username"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-14 text-xl"
            />
          </Field>

          <Field label="Placa del vehículo" htmlFor="plate" required>
            <Input
              id="plate"
              autoCapitalize="characters"
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
              className="h-14 font-mono text-xl tracking-[0.08em]"
            />
          </Field>

          <Field
            label="PIN personal"
            htmlFor="pin"
            required
            error={error}
            hint="Entre 4 y 6 dígitos. No lo compartas con nadie."
          >
            <Input
              id="pin"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              className="h-14 text-xl tracking-[0.5em]"
            />
          </Field>
        </div>

        <Instalar />

        <Button variant="primary" size="touch" loading={submitting} onClick={() => void submit()}>
          Entrar
        </Button>

        <p className="flex items-start gap-2 text-caption text-ink-muted">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          Este celular queda registrado en tu cuenta. Si lo pierdes, avisa a la oficina para que lo
          revoquen.
        </p>
      </motion.div>
    </Screen>
  );
}
