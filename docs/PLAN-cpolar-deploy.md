# 部署计划：国内不挂梯子访问 wangdachui.pi（角色扮演 Agent）

> 目标：让国内用户（不挂梯子）通过浏览器访问两个战役——诡秘之主（lotm）与裂界（liejie）。
> 方案：**本地运行 + cpolar 国内免费内网穿透**（零成本，体验完整，含 WebSocket）。
> 备选：腾讯云 EdgeOne Pages（零成本长期方案，体验有降级）。

---

## 0. 前置条件检查（先做）

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | ≥ 22 | `node --version`（当前 v22.20.0 ✓） |
| 项目 | 完整可用 | `cd D:/trae/rp-harness && ls src/server.ts` |
| .env | 已配置 API key | `cat .env`（含 `WANGDACHUI_API_KEY`，勿外传） |
| 本地端口 | 7620 空闲 | `netstat -ano \| grep 7620`（无 LISTENING） |
| 模型可达 | tokenrhythm 国内通 | 浏览器开 `https://tokenrhythm.studio`（已确认国内通） |

**验收**：以上全 ✓ 才继续。

---

## 1. 本地启动验证（必须通过再穿透）

```bash
cd D:/trae/rp-harness

# 裂界（潮声旁白）
WANGDACHUI_CAMPAIGN=liejie npm run web

# 诡秘（王大锤旁白）——先 Ctrl+C 停掉裂界，再跑：
# npm run web   （默认就是 lotm）
```

**验证**：
1. 终端出现 `✦ wangdachui.pi 已启动：http://127.0.0.1:7620`，且角色卡名正确（潮声/王大锤）
2. 浏览器开 `http://127.0.0.1:7620`，看到开场白
3. 发一条消息（如选身份"3"），能看到打字指示器 + 完整回复

**验收**：本地对话正常 = 引擎 OK，问题只剩"暴露公网"。

---

## 2. 安装 cpolar 并穿透（核心步骤）

### 2.1 注册 + 安装
1. 浏览器打开 `https://www.cpolar.com` 注册账号（免费，需邮箱）
2. 下载 Windows 版安装包，安装到默认路径
3. 安装完成后命令行可用 `cpolar` 命令（或重开终端）

### 2.2 绑定 token（一次性）
```bash
cpolar authtoken <你的authtoken>   # token 在 cpolar 官网「验证」页获取
```

### 2.3 穿透 7620 端口（每次开机跑一次）
```bash
cpolar http 7620
```

**输出会给出公网地址**，形如：
```
https://xxxxxxxx.cpolar.cn  ->  http://localhost:7620
```
**注意**：免费版地址是随机子域名，重启穿透会变，每次记一下新地址。

### 2.4（可选）开机自启
cpolar 官方有"后台运行/开机自启"设置（Windows 服务方式），见官网文档「cpolar 后台运行」。
若不想自启，每次玩前手动跑 2.3 即可。

**验收**：`https://xxxxxxxx.cpolar.cn` 在浏览器（**不挂梯子**）能打开页面。

---

## 3. 公网完整验证（关键）

用 cpolar 给的那个 `https://xxxxxxxx.cpolar.cn` 地址：

### 3.1 页面加载
- 浏览器（国内网络）打开 → 200，看到角色卡（潮声/王大锤）

### 3.2 WebSocket 连接（决定体验完整度）
用 Node 客户端测（在项目目录）：
```bash
node --input-type=module -e "
import WebSocket from 'ws';
const ws = new WebSocket('wss://xxxxxxxx.cpolar.cn/ws?sid=pubtest1');
const t = setTimeout(() => { console.log('超时'); process.exit(1); }, 15000);
ws.on('open', () => console.log('✅ WS open'));
ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'init') { console.log('✅ init:', m.state.cardName); clearTimeout(t); process.exit(0); } });
ws.on('error', e => { console.log('❌', e.message); process.exit(1); });
"
```
- ✅ open + init 收到 → WS 完整，打字机/决策卡/掷骰全可用
- ❌ 超时/错误 → cpolar 免费版可能不支持 WS，走 3.3 的 HTTP 降级（仍可玩）

### 3.3 HTTP 对话（WS 不通时的兜底，引擎已内置）
```bash
curl -s -X POST "https://xxxxxxxx.cpolar.cn/api/chat?sid=pubtest2" \
  -H "Content-Type: application/json" -d '{"text":"3"}' | head -c 300
```
- 返回 `{"ok":true,"content":"...","state":{...}}` → HTTP 模式可用，能对话（决策卡/掷骰自动默认选）

### 3.4 真机测试
用**手机（关掉 WiFi 的代理/梯子，走移动数据）**打开公网地址，发消息确认能玩。

**验收**：3.1 必须过；3.2 或 3.3 至少一个过 = 可玩。

---

## 4. 切换战役

| 战役 | 启动方式 |
|---|---|
| 裂界（潮声） | `WANGDACHUI_CAMPAIGN=liejie npm run web` |
| 诡秘（王大锤） | `npm run web`（默认 lotm） |

想同时提供两个战役？**穿透只能映射一个端口**，二选一：
- 简单做法：玩哪个开哪个
- 进阶：开第二个端口（如 7621）再穿透一条隧道（cpolar 免费版限 2 条隧道，够用）

---

## 5. 安全注意事项（务必读）

1. **7620 服务本身无鉴权**——任何拿到地址的人都能玩且消耗你的 API 额度
2. 免费 cpolar 地址是随机的（不易被扫到），但别发到公开论坛
3. 仅小圈子分享：cpolar 免费版已有流量限制，公开传播会很快耗尽额度
4. 电脑即服务器：关机即下线；建议长时间分享时保持电脑通电/不休眠

---

## 6. 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| 本地 127.0.0.1:7620 打不开 | 服务器没起/端口占用 | 看终端日志；`netstat -ano \| grep 7620` 杀占用 |
| 公网打不开页面 | 穿透没跑/地址记错 | 重跑 `cporal http 7620`；确认用 https |
| 页面开了但发消息无反应 | WS 不通 + 前端未切 HTTP | 等 90s 自动切 HTTP；或刷新重试；确认走 3.3 验证 |
| 回复特别慢/空 | API 慢 或 免费穿透限速 | 重发；检查 tokenrhythm 可达性 |
| 手机打不开 | 运营商封锁 或 免费隧道被限 | 换网络（移动/联通/电信）试 |
| cpolar 显示 "tunnel limit" | 免费版隧道数超限 | 关掉旧隧道 `cpolar` 面板里删，或停旧进程 |

---

## 7. 备选方案（cpolar 不理想时）

### 7.1 腾讯云 EdgeOne Pages（零成本，长期稳定）
- 注册腾讯云 → 开通 EdgeOne Pages（有免费额度）
- 项目已支持 HTTP 兜底，即使 WS 不支持也能玩（体验降级：无打字机/决策卡交互）
- 需要折腾构建配置（Node 22 + 入口 src/server.ts），适合有精力时再试

### 7.2 国内云服务器 + Docker（体验最完整，约 ￥50/月起）
```bash
git clone <仓库> && cd wangdachui-pi
cp .env.example .env && vi .env   # 填 key
docker compose up -d --build
# 访问 http://服务器IP:7620（不备案用 IP+端口；绑域名才需备案）
```
- 24 小时在线、WS 完整、数据持久
- 是"以后想长期稳定对外"的最优解（需花钱，当前不做）

---

## 8. 交付清单（做完勾选）

- [x] 本地裂界/诡秘都能跑通对话（2026-08-08 验证：7620 lotm·王大锤 / 7621 liejie·潮声，页面+WS+HTTP 均通）
- [x] cpolar 穿透成功，拿到公网地址（cpolar v3.3.12 便携版 @ `C:\Users\wangchi2068\cpolar-portable\cpolar\cpolar.exe`）
- [x] 国内浏览器（不挂梯子）能打开页面（curl 公网 200；真机 3.4 待测）
- [x] WS 或 HTTP 至少一种对话模式可用（两者都过：WS 流式打字机 + turn_done；HTTP 完整回复）
- [ ] 手机移动网络实测能玩（留给用户）
- [x] 已知晓安全注意事项（地址不公开、电脑需开机）

### 8.1 当前公网地址（2026-08-08 记录）

| 战役 | 公网地址 | 本地映射 | 验证结果 |
|---|---|---|---|
| 诡秘之主·王大锤 | `https://29bb6e5a.r18.cpolar.top`（http 同域） | 127.0.0.1:7620 | 页面 200 ✓ WS init ✓ HTTP 对话 ✓ WS 全回合（delta+turn_done）✓ |
| 裂界·潮声 | `https://6b9c6b1.r18.cpolar.top`（http 同域） | 127.0.0.1:7621 | 页面 200 ✓ WS init ✓ |

> 注意：免费版子域名为随机，重启穿透后地址会变，需重新记录。重启命令：`cpolar http 7620` / `cpolar http 7621`（二进制在 `C:\Users\wangchi2068\cpolar-portable\cpolar\`）。
