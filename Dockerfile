# Etapa 1: compila o frontend (React) em arquivos estáticos.
FROM node:24-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Etapa 2: backend, que também serve o frontend compilado.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./
RUN prisma generate
COPY --from=frontend /frontend/dist ./public

EXPOSE 3000
# Aplica as migrações do banco e inicia o servidor (o Node 24 roda TypeScript direto).
CMD ["sh", "-c", "prisma migrate deploy && exec node src/main.ts"]
