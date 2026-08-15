FROM node:24-bookworm-slim

WORKDIR /app

RUN npm config set registry https://registry.npmmirror.com/ && \
    yarn config set registry https://registry.npmmirror.com/

# Copy the repository contents into the image and install dependencies
COPY . .

RUN yarn install --frozen-lockfile && \
    yarn cache clean

ENV NODE_ENV=dev
ENV PORT=10588

EXPOSE 10588

CMD ["yarn", "dev"]
