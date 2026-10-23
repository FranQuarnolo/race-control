# Imagen del portal. Construye en una etapa y corre en otra, para que el compilador de
# TypeScript y las devDependencies no viajen a producción.
#
# `slim` y no `alpine`: el portal forkea un proceso por liga y abre sockets UDP, y la musl de
# Alpine ya dio problemas con `dgram` en otros proyectos. La diferencia de tamaño no justifica
# depurar eso en producción.

FROM node:22-slim AS build
WORKDIR /app

# Las dependencias primero y el código después: mientras el package-lock no cambie, Docker
# reutiliza la capa de `npm ci`, que es la que tarda.
COPY package.json package-lock.json ./
# `--ignore-scripts`: las dependencias son JavaScript puro y ninguna necesita compilar nada. Las
# devDependencies que sí traen binarios (el empaquetador del .exe, rcedit) son de Windows y acá no
# se usan; sin esta bandera el build se iría a bajarlas para nada.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# --- runtime -------------------------------------------------------------------------------------

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/dist ./dist

# El proceso corre como root, que es lo normal en una microVM de Fly dedicada a una sola app.
#
# Se probó `USER node` y no sirve: Fly monta el volumen en /data DESPUÉS de construir la imagen y
# con dueño root, así que cualquier `chown` de acá se pierde y el portal no podría ni crear su
# `portal.json`. Bajar privilegios de verdad pediría un entrypoint que haga el chown en caliente y
# después use `setpriv`; se gana poco (todos los workers comparten usuario igual, y quien ejecute
# código en el portal ya ve los datos de todas las ligas) y se arriesga un arranque roto.
RUN mkdir -p /data

EXPOSE 8080
CMD ["node", "dist/portal/index.js"]
