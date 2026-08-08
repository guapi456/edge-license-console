# Edge License Console

当前生产地址：<https://license.145156.xyz>。管理台已改为账号密码登录，部署状态与登录协议见 [docs/CLOUDFLARE-DEPLOYMENT.md](docs/CLOUDFLARE-DEPLOYMENT.md) 和 [docs/ADMIN-LOGIN.md](docs/ADMIN-LOGIN.md)；客户端卡密接入见 [docs/INTEGRATION.md](docs/INTEGRATION.md)。

新生成卡密使用 AES-256-GCM 加密保存，管理员可在授权码列表随时查看完整值、复制单张或复制当前页；D1 不保存卡密明文。

可部署到 Cloudflare Workers 的多项目卡密系统，包含管理控制台、D1 数据库、按卡密串行化的 Durable Object、短会话轮换与可选 Ed25519 设备证明。

## 已实现

- 多应用项目隔离，每个项目自动创建日卡、周卡、月卡（30 天）、季卡（90 天）和年卡（365 天）套餐。
- 单次最多批量生成 100 张卡；管理员可在生成结果或授权码列表中查看完整卡密、复制单张或复制当前页。
- 按项目、生命周期状态、卡密尾号或 metadata 筛选；支持启用、停用、单设备撤销和全部设备解绑。
- 默认可设置 `max_devices=1`；同一张卡的并发激活由 Durable Object 串行化，不会被两个新设备同时抢占。
- 首次成功激活开始计时；所有时间以服务端 UTC Unix 秒为准。
- 卡密不以明文落库：验证使用 `HMAC-SHA-256` 摘要，后台恢复显示使用独立密钥加密的 AES-256-GCM 密文；session 和 device token 只保存摘要。
- challenge 防重放、15 分钟 session、每次验证轮换 session。
- 强设备模式在首次激活及每次在线验证时都要求 Ed25519 私钥签名。
- 管理 Bearer token、审计日志、CORS allowlist、内置限流绑定和定时清理。

## 本地运行

要求 Node.js 20+。

```powershell
npm.cmd install
Copy-Item .dev.vars.example .dev.vars
npm.cmd exec wrangler d1 migrations apply edge-license-console -- --local
npm.cmd run dev
```

按照 [管理台账号密码登录](docs/ADMIN-LOGIN.md) 生成管理员密码盐和派生值，并把 `.dev.vars` 中的会话、摘要、卡密加密密钥换成彼此独立的随机值：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

默认地址通常是 `http://127.0.0.1:8787`。输入 `.dev.vars` 中的 `ADMIN_API_TOKEN` 后即可创建项目和批量发卡。

## Cloudflare 部署

1. 登录并创建 D1：

```powershell
npm.cmd exec wrangler login
npm.cmd exec wrangler d1 create edge-license-console
```

2. 把命令返回的 `database_id` 写入 `wrangler.jsonc`，替换 `REPLACE_WITH_D1_DATABASE_ID`。

3. 按 [管理台账号密码登录](docs/ADMIN-LOGIN.md) 生成密码派生值，然后注入互不复用的 Worker Secrets：

```powershell
npm.cmd exec wrangler secret put ADMIN_USERNAME
npm.cmd exec wrangler secret put ADMIN_PASSWORD_HASH
npm.cmd exec wrangler secret put ADMIN_PASSWORD_SALT
npm.cmd exec wrangler secret put ADMIN_SESSION_SECRET
npm.cmd exec wrangler secret put ADMIN_API_TOKEN
npm.cmd exec wrangler secret put KEY_PEPPER
npm.cmd exec wrangler secret put LICENSE_KEY_ENCRYPTION_SECRET
```

如需浏览器跨域调用，再设置精确 origin 列表，逗号分隔且不要使用 `*`：

```powershell
npm.cmd exec wrangler secret put TRUSTED_ORIGINS
```

4. 执行远端迁移并部署：

```powershell
npm.cmd exec wrangler d1 migrations apply edge-license-console -- --remote
npm.cmd run deploy
```

5. 在 Cloudflare Dashboard 为 Worker 绑定自定义域名。建议区分 `license.example.com`（公开验证 API）与 `admin-license.example.com`（控制台），用 Access + MFA 保护管理域，并用 WAF 阻止公开域访问 `/api/admin/*`。

6. 在 Rate Limiting Rules 中按业务量收紧 `/api/public/challenge` 和 `/api/public/activate`。代码内置绑定是每个 IP、每条公开路径每分钟 60 次，只是兜底值。

## 客户端接入

完整协议、curl、Ed25519 签名格式和可运行 Node.js 客户端见 [docs/INTEGRATION.md](docs/INTEGRATION.md)。

最短流程：

```text
challenge -> activate -> 保存 session/device token
          -> 每 5-10 分钟 validate
          -> 原子替换新 session 与签名 challenge
```

强设备项目应让客户端在系统密钥库中生成不可导出的 Ed25519 私钥。普通 `device_id` 可以被复制，单靠硬件信息拼接不能形成可靠设备身份。

## 管理 API

浏览器先通过 `/api/admin/login` 获取签名会话；自动化也可使用独立的 `ADMIN_API_TOKEN`。管理请求统一带：

```http
Authorization: Bearer <ADMIN_API_TOKEN>
```

主要端点：

| 端点 | 用途 |
|---|---|
| `GET /api/admin/stats` | 项目、卡密和设备统计 |
| `GET/POST /api/admin/projects` | 项目列表与创建 |
| `GET/POST /api/admin/plans` | 套餐列表与创建 |
| `POST /api/admin/licenses/batch` | 批量生成卡密 |
| `GET /api/admin/licenses` | 筛选与游标分页 |
| `PATCH /api/admin/licenses/:id` | 启用或停用 |
| `POST /api/admin/licenses/:id/reset-devices` | 解绑全部设备 |
| `GET /api/admin/audit` | 审计事件 |

## 上线前必做

- `max_devices=1` 只是设备槽控制；高价值功能必须启用设备签名，并把关键权益放在服务端判定。
- 明确月卡是固定 30 天还是自然月。本项目按固定 30 天计算。
- 管理域启用 Access/OIDC、MFA 和来源限制；共享 Bearer token 适合单管理员最小部署，多管理员需增加 RBAC。
- 禁止把 raw key、请求 body、Authorization、session/device token 写入日志或工单。
- 配置预算告警、WAF、备份、恢复演练和 `KEY_PEPPER` 泄漏处置。
- 停用会立即删除现有 session；离线授权则天然存在撤销延迟，本项目按在线优先设计。

详细威胁模型、轮换、备份和测试矩阵见 [docs/SECURITY.md](docs/SECURITY.md)。

## 校验

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd exec wrangler deploy -- --dry-run --outdir workerd-build
```

部署后可运行完整签名链 smoke。它会创建一个最终处于停用状态的测试项目：

```powershell
$env:BASE_URL='https://license.example.com'
$env:ADMIN_USERNAME='<admin username>'
$env:ADMIN_PASSWORD='<admin password>'
npm.cmd run smoke
```

回滚 Worker 代码前先从 `wrangler deployments list` 取得目标版本 ID：

```powershell
npm.cmd exec wrangler deployments list
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\rollback.ps1 -VersionId '<previous-version-id>' -DryRun
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\rollback.ps1 -VersionId '<previous-version-id>'
```

回滚脚本只切换 Worker 版本，不回退 D1 数据。当前迁移均为向后兼容新增字段；生产环境仍应先保留 D1 Time Travel 恢复点。
