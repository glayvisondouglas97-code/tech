FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN prisma generate

EXPOSE 3000
# Aplica as migrações do banco e inicia o servidor (o Node 24 roda TypeScript direto).
CMD ["sh", "-c", "prisma migrate deploy && exec node src/main.ts"]
