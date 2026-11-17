FROM denoland/deno:bin-2.1.4 AS deno

FROM node:22-bookworm-slim

# ffmpeg (cutter), yt-dlp (grabber), faster-whisper (captions), fonts for burned-in captions
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv fonts-dejavu-core fontconfig ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
# deno: the JavaScript runtime yt-dlp needs for YouTube; yt-dlp[default] adds its YouTube helper scripts
COPY --from=deno /deno /usr/local/bin/deno
RUN python3 -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir -U "yt-dlp[default]" faster-whisper
ENV PATH="/opt/py/bin:$PATH" PYTHON=/opt/py/bin/python NEXT_TELEMETRY_DISABLED=1

WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
