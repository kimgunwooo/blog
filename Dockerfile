FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

USER root
RUN rm -f /etc/nginx/conf.d/default.conf \
	&& printf '%s\n' \
		'server {' \
		'  listen 4321;' \
		'  server_name _;' \
		'  root /usr/share/nginx/html;' \
		'  index index.html;' \
		'' \
		'  location / {' \
		'    try_files $uri $uri/ /index.html;' \
		'  }' \
		'}' \
		> /etc/nginx/conf.d/default.conf

COPY --from=build --chown=101:101 /app/dist/ /usr/share/nginx/html/

USER 101
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD wget -qO- http://127.0.0.1:4321/healthz >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
