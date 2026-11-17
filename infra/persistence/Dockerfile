FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig*.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
RUN bun run check
USER bun
CMD ["bun", "scripts/run-persistence-integration.ts"]
