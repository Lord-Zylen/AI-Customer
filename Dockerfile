FROM node:22-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY --from=client-build /app/client/dist /app/client/dist
RUN mkdir -p /app/data/whatsapp-auth && chown -R node:node /app
USER node
EXPOSE 5000
CMD ["node", "src/server.js"]
