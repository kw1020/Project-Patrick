FROM denoland/deno:bin-2.1.4 AS deno

FROM node:22-bookworm-slim

# ffmpeg (cutter), yt-dlp (grabber), faster-whisper (captions), fonts for burned-in captions
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv fonts-dejavu-core fontconfig ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
# deno: the JavaScript runtime yt-dlp needs for YouTube; yt-dlp[default] adds its YouTube helper scripts
COPY --from=deno /deno /usr/local/bin/deno
# opencv-python-headless: face/webcam detection for the layouts (scripts/detect_cam.py, bundled Haar cascades, no downloads)
RUN python3 -m venv /opt/py && /opt/py/bin/pip install --no-cache-dir -U "yt-dlp[default]" faster-whisper "opencv-python-headless==4.10.0.84"
# v2.0.9: yt-dlp needs deno >= 2.3 (ours is 2.1.4, so it is ignored) or node >= 22 for YouTube; without one YouTube
# throttles downloads to a crawl (Krew: a video "still going 2hrs to download"). Node 22 is this image's own runtime.
RUN echo '--js-runtimes node' > /etc/yt-dlp.conf
ENV PATH="/opt/py/bin:$PATH" PYTHON=/opt/py/bin/python NEXT_TELEMETRY_DISABLED=1

WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
