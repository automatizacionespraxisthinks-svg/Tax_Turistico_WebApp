import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { ToastProvider, routeTransition } from '@tax/ui';
import { AppShell } from './app/AppShell';
import { AuthGate } from './app/AuthGate';
import { startLive } from './live/store';
import { Operacion } from './pages/Operacion';
import { Carreras } from './pages/Carreras';
import { Flota } from './pages/Flota';
import { ZonasTarifas } from './pages/ZonasTarifas';
import { Reportes } from './pages/Reportes';
import { Sistema } from './pages/Sistema';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Un 401 o un 403 no se reintentan: no van a mejorar solos y cada
      // reintento retrasa el mensaje que el operador necesita ver.
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403) return false;
        return failureCount < 2;
      },
    },
  },
});

/**
 * Las rutas se cruzan dentro del marco: la barra lateral y la superior no se
 * vuelven a montar, así la navegación no parpadea ni pierde el scroll lateral.
 */
function AnimatedRoutes() {
  const location = useLocation();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        variants={routeTransition}
        initial="hidden"
        animate="visible"
        exit="exit"
        className="h-full"
      >
        <Routes location={location}>
          <Route path="/" element={<Operacion />} />
          <Route path="/carreras" element={<Carreras />} />
          <Route path="/carreras/:rideId" element={<Carreras />} />
          <Route path="/flota" element={<Flota />} />
          <Route path="/zonas" element={<ZonasTarifas />} />
          <Route path="/reportes" element={<Reportes />} />
          <Route path="/sistema" element={<Sistema />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}

/** El estado en vivo arranca solo cuando hay sesión: sin ella, todo da 401. */
function LiveWorkspace({ userName }: { userName: string }) {
  useEffect(() => startLive(), []);

  return (
    <BrowserRouter>
      <AppShell userName={userName}>
        <AnimatedRoutes />
      </AppShell>
    </BrowserRouter>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* `reducedMotion="user"` honra la preferencia del sistema en toda la app. */}
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <AuthGate>{(user) => <LiveWorkspace userName={user.name} />}</AuthGate>
        </ToastProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
