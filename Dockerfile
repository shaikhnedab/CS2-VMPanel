# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S vmp && adduser -S vmp -G vmp && chown vmp:vmp /app
COPY --from=build --chown=vmp:vmp /app/package.json /app/package-lock.json /app/
COPY --from=build --chown=vmp:vmp /app/node_modules /app/node_modules
COPY --chown=vmp:vmp ./server.js /app/server.js
COPY --chown=vmp:vmp ./app /app/app
COPY --chown=vmp:vmp ./views /app/views
COPY --chown=vmp:vmp ./public /app/public
COPY --chown=vmp:vmp ./tests /app/tests
# Fail the build loudly if the runtime layout is wrong (CMD/HEALTHCHECK
# depend on these exact paths; a silent flatten breaks the container).
RUN test -f /app/server.js \
 && test -f /app/app/db/migrate.js \
 && test -f /app/app/routes/install.js \
 && test -f /app/views/Login.ejs \
 && test -f /app/views/Install.ejs \
 && test -d /app/public \
 && echo "runtime layout ok" \
 && su vmp -c 'touch /app/.writetest && rm /app/.writetest' \
 && echo "non-root writable ok"
# Config lives OUTSIDE the image: mount .env or set env vars (see .env.example).
USER vmp
EXPOSE 3535
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3535/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node app/db/migrate.js && node server.js"]
