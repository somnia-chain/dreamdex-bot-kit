# DreamDEX contest agent
# Built for Python 3.11 on linux/amd64. Keeps backend/ as the workdir;
# bind .env from the host at runtime so secrets never bake into the image.
FROM python:3.11-slim

# OS deps: build-essential for any wheels that need to compile (eth_account etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Then app code
COPY . /app

# Unbuffered Python output → real-time docker logs
ENV PYTHONUNBUFFERED=1

EXPOSE 5001

# Run as non-root just for hygiene (private key still in /app/.env which we bind-mount RO)
RUN useradd -m -u 1000 agent && chown -R agent:agent /app
USER agent

CMD ["python3", "main.py"]
