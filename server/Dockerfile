# Code AI 배포 전용 서버 (인터넷 공용 공유 링크용)
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY updates ./updates
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    DEPLOY_ONLY=1
EXPOSE 8080
CMD ["node", "server.js"]
