FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN useradd -m patrick && mkdir -p /app/data /app/music && chown -R patrick /app
USER patrick

ENV PORT=10000
EXPOSE 10000
# one worker on purpose (see wsgi.py); threads let uploads/polling overlap with an edit in progress
CMD gunicorn -w 1 --threads 4 -t 300 -b 0.0.0.0:${PORT} wsgi:app
