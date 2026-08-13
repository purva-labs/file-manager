FROM ghcr.io/home-assistant/amd64-base:3.22

RUN apk add --no-cache nodejs npm openssl tar

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY run.sh /run.sh
RUN chmod 0755 /run.sh

CMD ["/run.sh"]
