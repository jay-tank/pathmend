# syntax=docker/dockerfile:1
FROM node:20 AS build
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY scripts/start.sh /usr/local/bin/start.sh
COPY --from=build /app/dist /app/dist
COPY ${APP_DIR}/x /x
ADD https://example.com/file.tgz /tmp/
COPY src/*.js /app/
COPY config/*.yaml /app/
COPY ["src/index.js", "missing.json", "/app/"]
RUN echo hi \
  && echo there
COPY src/utils \
     src/nothere /app/
COPY <<EOT /app/inline.txt
COPY not/a/real/instruction /x
EOT
COPY --chown=1000:1000 lib/tool.js /app/
