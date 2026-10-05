# Timeline Challenge — online server (serves the game and the multiplayer API on one port)
FROM python:3.12-slim

WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY index.html ./
COPY css css
COPY js js
COPY server server

# Most hosts (Render, Railway, Fly.io) inject PORT; HOST must accept outside connections.
ENV HOST=0.0.0.0 \
    PORT=8765 \
    TC_QUIET=1
EXPOSE 8765
CMD ["python", "server/server.py"]
