# Build context: repo root (.)
# Railway: set Root Directory to "/" and Dockerfile path to "autobot-inbox/Dockerfile"

FROM node:20-alpine AS deps

# Install product dependencies
WORKDIR /app/autobot-inbox
COPY autobot-inbox/package*.json ./
RUN npm ci --omit=optional

# Install lib dependencies
WORKDIR /app/lib
COPY lib/package*.json ./
RUN npm ci --omit=optional

# Install agents dependencies
WORKDIR /app/agents
COPY agents/package*.json ./
RUN npm ci --omit=optional

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV SQL_DIR=/app/autobot-inbox/sql
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 autobot

# Copy dependencies
COPY --from=deps --chown=autobot:nodejs /app/autobot-inbox/node_modules ./autobot-inbox/node_modules
COPY --from=deps --chown=autobot:nodejs /app/lib/node_modules ./lib/node_modules
COPY --from=deps --chown=autobot:nodejs /app/agents/node_modules ./agents/node_modules

# Copy source
COPY --chown=autobot:nodejs lib/ ./lib/
COPY --chown=autobot:nodejs agents/ ./agents/
COPY --chown=autobot:nodejs autobot-inbox/src/ ./autobot-inbox/src/
COPY --chown=autobot:nodejs autobot-inbox/config/ ./autobot-inbox/config/
COPY --chown=autobot:nodejs autobot-inbox/sql/ ./autobot-inbox/sql/
COPY --chown=autobot:nodejs autobot-inbox/tools/ ./autobot-inbox/tools/
COPY --chown=autobot:nodejs autobot-inbox/package.json ./autobot-inbox/

USER autobot
WORKDIR /app/autobot-inbox
EXPOSE 3001
CMD ["node", "src/index.js"]
