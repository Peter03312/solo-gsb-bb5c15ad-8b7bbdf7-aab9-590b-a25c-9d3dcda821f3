#!/bin/sh
set -e

echo "[entrypoint] 检查并初始化数据库（建表、默认账号、示例草稿）..."
node src/initdb.js

echo "[entrypoint] 启动联排提示板服务，端口 ${PORT:-3000} ..."
exec node src/server.js
