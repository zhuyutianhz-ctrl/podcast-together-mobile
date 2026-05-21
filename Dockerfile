FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173
CMD ["node", "server.js"]
