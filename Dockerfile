# ---------- build stage ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY server/package.json server/package-lock.json* server/
RUN cd server && (npm ci || npm install)
COPY web/package.json web/package-lock.json* web/
RUN cd web && (npm ci || npm install)

COPY server server
COPY web web
RUN cd web && npm run build
RUN cd server && npm run build && npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# ffmpeg (with libass for burned-in captions), fonts for captions, curl for yt-dlp
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-liberation curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone binary (uses the bundled Node as its JS runtime for YouTube)
ARG YTDLP_VERSION=latest
RUN if [ "$YTDLP_VERSION" = "latest" ]; then \
      curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux; \
    else \
      curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux; \
    fi \
  && chmod +x /usr/local/bin/yt-dlp

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/src/db/migrations server/dist/db/migrations
COPY --from=build /app/web/dist web/dist

ENV DATA_DIR=/data WEB_DIST=/app/web/dist PORT=8080
EXPOSE 8080
CMD ["node", "server/dist/server.js"]
