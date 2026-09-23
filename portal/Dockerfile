# No npm dependencies and no build step — the whole app is Node stdlib.
#
# ffmpeg is the one thing that comes from outside, and it is a system binary
# rather than a package in a lockfile: the reel renders its own marker clips,
# because Stash's are fixed at 640x360 and nothing in its settings or its API
# reaches that number.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    PORT=6980 \
    HOST=0.0.0.0

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /config && chown -R node:node /app /config
USER node

VOLUME ["/config"]
EXPOSE 6980

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
