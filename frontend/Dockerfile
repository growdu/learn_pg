# Build stage
FROM docker.m.daocloud.io/library/node:20-alpine AS builder

# Use Chinese npm mirror
RUN npm config set registry https://registry.npmmirror.com

WORKDIR /app

# Copy package files first for better caching
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

# Copy source code
COPY . .

# Build
ARG VITE_API_URL=
ARG VITE_WS_URL=ws://localhost/ws/
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
RUN npm run build

# Production stage
FROM docker.m.daocloud.io/library/nginx:alpine

RUN apk add --no-cache nginx

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx configuration
# Health endpoints must precede "location /" to avoid try_files fallback to SPA
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
