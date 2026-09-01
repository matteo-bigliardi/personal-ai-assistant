# --- build stage ---
FROM node:26-alpine AS build
WORKDIR /app
# `npm ci` (not `npm install`) so builds resolve exactly the committed lockfile.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Migrations are applied at startup by src/db/migrate.ts, so they must ship
# with the runtime image (drizzle-kit itself stays a dev dependency).
COPY drizzle ./drizzle
# Drop root: the app only reads its own files and opens outbound connections.
USER node
EXPOSE 3000
CMD ["node", "dist/app.js"]
