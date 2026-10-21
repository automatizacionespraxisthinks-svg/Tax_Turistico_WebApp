# PWA del conductor.
#
# El contexto de construcción es la RAÍZ del monorepo. Igual que el panel, la
# dirección de la API se incrusta al compilar.
#
# Esta tiene una particularidad: es una aplicación instalable con service
# worker, y servir mal el `sw.js` deja a los conductores con una versión
# vieja atrapada en el teléfono. Ver `nginx.conf`.

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app

ARG VITE_API_BASE
ENV VITE_API_BASE=$VITE_API_BASE

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tax/shared build && pnpm --filter @tax/driver build


FROM nginx:1.29-alpine AS runtime
COPY apps/driver/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/driver/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
