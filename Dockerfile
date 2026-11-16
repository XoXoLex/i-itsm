# I-ITSM: one container serves the API and the built React frontend.
FROM node:22-bookworm-slim

WORKDIR /app

# Backend dependencies (pure JavaScript; SQLite is built into Node 22+)
COPY package.json package-lock.json ./
RUN npm ci

# Frontend build
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY . .
RUN cd web && npm run build

ENV PORT=3000 \
    DB_PATH=/data/itsm.db
VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]
