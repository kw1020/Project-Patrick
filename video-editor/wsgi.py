"""Production entry point: web app + email watcher in one process.

    gunicorn -w 1 --threads 4 -t 300 wsgi:app

Keep it at ONE worker process: the edit queue and the email watcher live in memory.
"""
import logging
import os

import email_worker
from app import create_app

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
app = create_app(os.environ.get("PATRICK_PASSWORD", ""))
email_worker.start_background()
