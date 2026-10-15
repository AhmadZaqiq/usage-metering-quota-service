FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache postgresql-client

COPY package*.json ./

RUN npm ci --include=dev

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["node", "dist/main.js"]