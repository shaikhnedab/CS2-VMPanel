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
RUN addgroup -S vmp && adduser -S vmp -G vmp
COPY --from=build --chown=vmp:vmp /app/package.json /app/package-lock.json ./
COPY --from=build --chown=vmp:vmp /app/node_modules ./node_modules
COPY --chown=vmp:vmp server.js app views public tests ./
# Config lives OUTSIDE the image: mount .env or set env vars (see .env.example).
USER vmp
EXPOSE 3535
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3535/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node app/db/migrate.js && node server.js"]
