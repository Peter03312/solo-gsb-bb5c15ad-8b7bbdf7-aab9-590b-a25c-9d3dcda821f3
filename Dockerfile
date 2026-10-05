FROM node:20-bookworm-slim

# better-sqlite3 优先使用预编译二进制；保留构建工具以便无预编译包时回退源码编译
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ tzdata ca-certificates \
  && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存安装依赖
COPY package.json ./
RUN npm install --omit=dev

# 拷贝应用代码
COPY src ./src
COPY public ./public
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    DATA_DIR=/app/data \
    PORT=3000

EXPOSE 3000

# 启动过程：数据初始化（建表 + 播种）后启动服务
CMD ["./entrypoint.sh"]
