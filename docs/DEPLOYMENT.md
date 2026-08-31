# 部署指南

项目零运行时依赖、Node ≥ 22 原生运行 TypeScript，提供 Docker / Vercel / 内网穿透三条部署路径。**所有部署都必须先准备 `.env`（密钥不进镜像、不进代码库）。**

## 0. 准备 `.env`

```bash
cp .env.example .env
# 填入 WANGDACHUI_API_KEY；可选兜底 key / 模型分级 / 预算
```

`.env` 被 `.gitignore` 排除，Docker 通过 `env_file` 注入容器环境。

## 1. Docker（推荐，含数据持久化）

```bash
git clone <仓库地址> wangdachui-pi && cd wangdachui-pi
cp .env.example .env   # 填 key
docker compose up -d --build
# 打开 http://<服务器IP>:7620
```

- 数据持久化：`./state`（含 `state.db` SQLite）挂载为卷，升级重建不丢档；
- 日志：`docker compose logs -f wangdachui-pi`；
- **请勿把 7620 端口裸暴露公网**（服务无鉴权），对外请套反向代理 + 鉴权。

### 1.1 Prometheus 指标采集（可选）

```bash
docker compose -f docker-compose.yml -f docker-compose.metrics.yml up -d
# Prometheus UI: http://localhost:9090 ，查询 wangdachui_* 指标
```

采集目标为 `host.docker.internal:7620/metrics`（Windows/Mac Docker Desktop 可用）。

## 2. Vercel（Serverless）

仓库已含 `vercel.json`（`@vercel/node` 风格、`/api/chat` 非流式兜底），本地已配置过 `.vercel/project.json`。

```bash
npm i -g vercel          # 需要 Vercel 账号 token
vercel login             # 首次登录
vercel --prod            # 部署生产
```

注意：Vercel 无持久磁盘，`state/` 需走 `WANGDACHUI_STATE_MODE=tmp`（默认自动），实例回收会丢档——适合体验/演示，不适合长期存档。项目配置了 `WANGDACHUI_STATE_MODE` 环境变量开关。

## 3. 内网穿透（cpolar，本地自用远程访问）

见 [`docs/PLAN-cpolar-deploy.md`](PLAN-cpolar-deploy.md)：cpolar 绑定 token 后暴露本地 7620 端口，可远程访问。

## 4. 健康与指标

- `GET /api/healthz`：进程存活 + 磁盘可写；
- `GET /metrics`：Prometheus 文本（token 用量、延迟分位、provider 切换、压缩触发、记账成败、HTTP/WS 计数）。

## 5. 运维注意

- SQLite（`state.db`）为每会话一个文件，回档/迁移以快照（`state/snapshots/*.json`）为准；升级前建议 `docker compose down` 后备份 `./state`；
- 计数器为进程内状态，重启清零；跨实例聚合用 Prometheus 拉取。
