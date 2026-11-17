FROM oven/bun:1.4.4

WORKDIR /experiment
COPY package.json bun.lock ./
RUN test "$(bun --version)" = '1.4.4' \
    && bun install --frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN bun run --bun typecheck \
    && bun run --bun build \
    && bun run bootstrap

USER bun
CMD ["bun", "run", "diagnose"]
