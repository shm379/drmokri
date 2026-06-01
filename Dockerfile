# syntax=docker/dockerfile:1

############################
# Stage 1: Build the app
############################
FROM node:22-bookworm-slim AS build

# Build tools needed to compile the native better-sqlite3 module
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (use the lockfile for reproducible builds)
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source
COPY . .

# GEMINI_API_KEY is injected into the client bundle by Vite at build time.
# In Coolify, set it as a *Build Variable* so it is available here.
ARG GEMINI_API_KEY
ENV GEMINI_API_KEY=$GEMINI_API_KEY

# Produce the production client bundle in /app/dist
RUN npm run build

############################
# Stage 2: Runtime image
############################
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000
# Store the SQLite database on a path that can be mounted as a volume
ENV DATABASE_PATH=/data/mokri_assistant.db

WORKDIR /app

# Copy built artifacts and the runtime files from the build stage.
# node_modules is carried over so the compiled better-sqlite3 binary is reused.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/podcasts_db.json ./podcasts_db.json

# Persistent storage for the SQLite database
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# server.ts serves the prebuilt /app/dist when NODE_ENV=production
CMD ["npx", "tsx", "server.ts"]
