# Build stage
FROM node:20-alpine AS builder

# Use Chinese npm mirror
RUN npm config set registry https://registry.npmmirror.com

WORKDIR /app

# Copy package files first for better caching
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

# Copy source code
COPY frontend/ .

# Build
RUN npm run build

# Production stage
FROM nginx:alpine

# Use Chinese nginx mirror
RUN apk add --no-cache nginx

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx configuration
RUN echo 'server { \
    listen 80; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
    location /api/ { \
        proxy_pass http://backend:3000; \
        proxy_set_header Host $host; \
        proxy_set_header X-Real-IP $remote_addr; \
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; \
    } \
    location /ws { \
        proxy_pass http://backend:3000; \
        proxy_http_version 1.1; \
        proxy_set_header Upgrade $http_upgrade; \
        proxy_set_header Connection "upgrade"; \
        proxy_set_header Host $host; \
        proxy_read_timeout 86400; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
