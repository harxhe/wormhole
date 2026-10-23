# syntax=docker/dockerfile:1

FROM node:22-alpine

WORKDIR /app

# Workspace manifests first so dependency installation is cached separately
# from source changes.
COPY package.json package-lock.json ./
COPY protocol/package.json protocol/
COPY transport/package.json transport/
COPY server/package.json server/
COPY inspector/package.json inspector/
COPY client/package.json client/
COPY bench/package.json bench/
RUN npm ci

COPY . .

ENV NODE_ENV=production
ENV WORMHOLE_LOG_LEVEL=info

# Control listener, public HTTP listener and the default raw TCP range.
EXPOSE 4443 8080
EXPOSE 15000-15099

CMD ["npm", "run", "server"]
