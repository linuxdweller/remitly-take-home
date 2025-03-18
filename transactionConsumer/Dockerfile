FROM node:23.9-slim as build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src
COPY prisma/ ./prisma
RUN npm run build

FROM node:23.9-slim

WORKDIR /app

COPY package.json package-lock.json prisma ./
RUN npm ci --omit=dev

COPY --from=build /app/src ./src

ENTRYPOINT ["npm", "run", "start"]
