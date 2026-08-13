FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY deploy ./deploy

ENV NODE_ENV=production

EXPOSE 3088
CMD ["npm", "start"]
