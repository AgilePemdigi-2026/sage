ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG PHP_IMAGE=php:8.4-cli-bookworm@sha256:836ac6c672d1372a47c8fd61b625015bd07760f493fb2eaab2087636498a2b4b
ARG COMPOSER_IMAGE=composer:2.9.7@sha256:02062f7719ec9433a9d4256cfba1c792db96dc9db60a4a92e48264c9e166b877

FROM ${COMPOSER_IMAGE} AS composer
FROM ${NODE_IMAGE} AS node-base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@11.17.0 && rm -rf /root/.npm

FROM ${PHP_IMAGE} AS worker-base
WORKDIR /app
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY --from=node-base /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
RUN apt-get update && apt-get install -y --no-install-recommends git unzip ca-certificates openssl && rm -rf /var/lib/apt/lists/*

FROM worker-base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/analyzer-js/package.json packages/analyzer-js/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/analyzer-php/package.json packages/analyzer-php/package.json
COPY packages/documents/package.json packages/documents/package.json
RUN npm ci --cache /tmp/npm-cache && rm -rf /tmp/npm-cache /root/.npm
COPY tsconfig.json eslint.config.mjs cucumber.mjs ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
COPY config ./config
COPY docs/evidence/corpora ./docs/evidence/corpora
RUN composer install --working-dir=packages/analyzer-php --no-dev --no-interaction --no-plugins --no-scripts --prefer-dist && composer clear-cache
RUN npm run db:generate && npm run check && npm run build

# Disposable acceptance-test image; not part of the product runtime.
FROM build AS bdd
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --no-install playwright install --with-deps --only-shell chromium \
    && mkdir -p apps/web/.next/standalone/apps/web/.next/static apps/web/.next/standalone/apps/web/public artifacts/bdd \
    && cp -R apps/web/.next/static/. apps/web/.next/standalone/apps/web/.next/static/ \
    && cp -R apps/web/public/. apps/web/.next/standalone/apps/web/public/
CMD ["npm", "run", "test:bdd"]

FROM node-base AS worker-dependencies
COPY package.json package-lock.json .npmrc ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/analyzer-js/package.json packages/analyzer-js/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/analyzer-php/package.json packages/analyzer-php/package.json
COPY packages/documents/package.json packages/documents/package.json
RUN npm ci --omit=dev --workspace @sage/worker --include-workspace-root=false --cache /tmp/npm-cache && rm -rf /tmp/npm-cache /root/.npm

FROM node-base AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/apps/web/.next/standalone /app
COPY --from=build --chown=node:node /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public /app/apps/web/public
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM worker-base AS worker
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=worker-dependencies /app /app
RUN npx --no-install playwright install --with-deps --only-shell chromium && chmod -R a+rX /ms-playwright && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /app/apps/worker /app/apps/worker
COPY --from=build /app/packages /app/packages
COPY --from=build /app/scripts /app/scripts
COPY --from=build /app/config /app/config
COPY --from=build /app/tests/fixtures /app/tests/fixtures
RUN groupadd --gid 1000 sage && useradd --uid 1000 --gid 1000 --create-home sage && mkdir -p /app/storage && chown sage:sage /app/storage
USER sage
CMD ["node", "--import", "tsx", "apps/worker/src/index.ts"]
