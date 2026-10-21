# API de Tax Turístico.
#
# El contexto de construcción es la RAÍZ del monorepo, no esta carpeta: la API
# depende de `@tax/shared`, que vive en `packages/`. En Dokploy eso significa
# dejar «Build Path» en `/` y poner esta ruta en «Docker File».
#
# Base Debian y no Alpine a propósito: `@node-rs/argon2` es un binario nativo
# y las variantes musl han dado guerra. Unas decenas de megas más a cambio de
# que el hash de las contraseñas no falle en producción es buen trato.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# La misma versión que `packageManager` en la raíz: que la imagen resuelva el
# árbol igual que la máquina de quien desarrolla.
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /app


FROM base AS build
# Sin esto, la poda de abajo aborta: pnpm necesita recrear `node_modules` al
# pasar a solo producción y se niega a borrarlo sin terminal interactiva.
ENV CI=true
COPY . .
# `--frozen-lockfile` falla si el lockfile no cuadra con los package.json, que
# es justo lo que se quiere: un despliegue no es el sitio para resolver
# versiones nuevas.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tax/shared build && pnpm --filter @tax/api build
# Se podan las dependencias de desarrollo sobre el mismo árbol, conservando
# los enlaces del workspace hacia `@tax/shared` ya compilado.
RUN pnpm install --frozen-lockfile --prod


FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
WORKDIR /app/apps/api

# El bit de ejecución no sobrevive a un `git clone` desde Windows, así que se
# pone aquí en vez de confiar en los permisos del repositorio.
RUN chmod +x docker-entrypoint.sh

# Sin privilegios: la imagen de Node ya trae el usuario `node`.
USER node

EXPOSE 3000

# El chequeo lo usa Dokploy para no mandar tráfico a un contenedor que aún
# está levantando, y para reiniciarlo si se queda colgado.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
