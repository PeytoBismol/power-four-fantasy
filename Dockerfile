FROM node:22-slim

# No npm dependencies: the app runs on Node's built-in HTTP server and node:sqlite.
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/app/data/power-four.sqlite

COPY package.json ./
COPY src ./src
COPY ingest ./ingest
COPY web ./web
RUN mkdir -p /app/data

# Keep the database on a volume so it survives redeploys
VOLUME ["/app/data"]
EXPOSE 8080

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
