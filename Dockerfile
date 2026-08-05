FROM node:22-slim

ENV NODE_ENV=production \
    CLAUDE_WORKDIR=/home/node/workspace

WORKDIR /app

COPY package.json package-lock.json ./

# The Agent SDK ships its CLI as a per-platform binary. npm installs the musl
# build alongside the glibc one despite its `libc` field; this image is Debian,
# so the musl copy is ~270 MB of dead weight. The npm cache has to go in the
# same layer, or deleting it later only masks it.
#
# HOME is deliberately still /root here: set it to /home/node before this and
# npm caches into a directory the chown below then duplicates into a new layer.
RUN npm ci --omit=dev \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-*-musl \
 && npm cache clean --force \
 && rm -rf /root/.npm

COPY src ./src

# The bundled CLI needs a writable HOME at runtime.
RUN mkdir -p /home/node/workspace && chown -R node:node /home/node

ENV HOME=/home/node
USER node

CMD ["node", "src/index.js"]
