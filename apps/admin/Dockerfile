# Panel de oficina.
#
# El contexto de construcción es la RAÍZ del monorepo: el panel depende de
# `@tax/shared` y `@tax/ui`, que viven en `packages/`.
#
# Vite incrusta las variables `VITE_*` en el paquete al compilar, así que la
# dirección de la API es un argumento de construcción y no una variable de
# entorno del contenedor: si cambia, hay que reconstruir. Es la contrapartida
# de servir ficheros estáticos sin servidor de aplicación detrás.

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app

ARG VITE_API_BASE
ENV VITE_API_BASE=$VITE_API_BASE

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tax/shared build && pnpm --filter @tax/admin build


FROM nginx:1.29-alpine AS runtime
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
