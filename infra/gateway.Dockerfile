FROM node:22-slim
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/console/package.json apps/console/package.json
RUN npm ci --no-audit --no-fund
COPY apps/gateway apps/gateway
RUN npm run build -w apps/gateway
WORKDIR /repo/apps/gateway
EXPOSE 3000
CMD ["node", "dist/index.js"]
