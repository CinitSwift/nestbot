#!/bin/bash
# 将欢迎模块补丁部署到 kyouka 容器（幂等；容器重建后可直接重跑）
set -e
cd "$(dirname "$0")"
docker cp deploy/welcome.py kyouka:/Kyouka/app/welcome.py
docker cp deploy/main.py kyouka:/Kyouka/app/main.py
docker cp deploy/interval_tasks.py kyouka:/Kyouka/app/task/interval_tasks.py
docker restart kyouka
echo "deployed & kyouka restarted"
