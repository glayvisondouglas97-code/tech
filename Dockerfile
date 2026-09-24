# Etapa 1: compila a interface (Vite) e o servidor (tsup).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Etapa 2: só o necessário para rodar.
FROM node:22-bookworm-slim
ENV NODE_ENV=production TZ=America/Sao_Paulo PORT=3000 MEDIA_DIR=/app/media
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Pasta das mídias do WhatsApp (volume próprio no docker-compose). O sistema roda sem ser root.
RUN mkdir -p /app/media && chown node:node /app/media
USER node
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
