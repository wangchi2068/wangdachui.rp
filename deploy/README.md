# Docker 部署

前置：安装 Docker（含 compose 插件）。需要 `git` 与 `.env`（密钥）。

```bash
# 1. 拉取代码
git clone <你的仓库地址> rp-harness && cd rp-harness

# 2. 准备配置（密钥不进镜像，只进容器环境）
cp .env.example .env
# 编辑 .env，填入 LIYUAN_API_KEY

# 3. 构建并启动
docker compose up -d --build

# 4. 打开 http://服务器IP:7620
# 日志：docker compose logs -f rp-harness
# 停止：docker compose down        （state 卷保留）
# 彻底清理：docker compose down -v （删除全部数据，慎用）
```

## 说明

- **镜像不含密钥**：`.env` 通过 `env_file` 注入容器环境，`.dockerignore` 排除。
- **数据持久化**：`./state` 挂载为 `/app/state`，账本/存档/会话历史都在里面；升级重建容器不丢档。
- **运行时零依赖**：Node 22 原生运行 TypeScript（内置类型剥离），生产镜像不需要 `npm install`。
- 端口通过 `.env` 的 `LIYUAN_PORT` 或 compose 的 ports 映射调整。
- 请勿把 7620 端口裸暴露公网（服务本身无鉴权）；对外请套反向代理 + 鉴权。
