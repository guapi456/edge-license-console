# Cloudflare 部署记录

更新时间：2026-08-07

## 线上资源

- 管理台/API：<https://license.145156.xyz>
- Worker：`edge-license-console`
- 当前验证版本：`9942c924-63f6-4687-9171-e87ace6cae8c`
- D1：`edge-license-console`
- D1 ID：`6521371d-e22e-4b7c-af12-a189257f15b2`
- Zone：`145156.xyz`
- Custom Domain：`license.145156.xyz`

`edge-license-console.singapore1.workers.dev` 当前不作为访问入口，使用自定义域名。

## 管理员登录

浏览器访问 `https://license.145156.xyz`，使用账号和密码登录。Worker 只保存 PBKDF2-SHA-256 派生值及随机盐，成功登录后返回有效期 8 小时的 HMAC 签名会话。

涉及的 Worker Secrets：

```text
ADMIN_USERNAME
ADMIN_PASSWORD_HASH
ADMIN_PASSWORD_SALT
ADMIN_SESSION_SECRET
ADMIN_API_TOKEN      # 可选，仅供自动化/应急运维
KEY_PEPPER
LICENSE_KEY_ENCRYPTION_SECRET
```

登录接口：

```http
POST /api/admin/login
Content-Type: application/json

{"username":"...","password":"..."}
```

成功返回：

```json
{"token":"<signed-session>","expires_at":1786000000}
```

后续管理请求使用：

```http
Authorization: Bearer <signed-session>
```

登录按来源 IP 使用 Cloudflare Rate Limit binding 限制为每分钟 10 次。错误账号与错误密码均统一返回 `401 invalid_credentials`。

## 生产验证

```powershell
$env:BASE_URL='https://license.145156.xyz'
$env:ADMIN_USERNAME='<admin username>'
$env:ADMIN_PASSWORD='<admin password>'
npm.cmd run smoke
```

2026-08-07 原始结果：

```json
{"bad_login_blocked":401,"project_created":201,"listed_key_recoverable":true,"presets":["annual","daily","monthly","quarterly","weekly"],"activation_a":200,"unsigned_validate_blocked":400,"signed_validate":200,"stale_session_and_signature_blocked":400,"second_device_blocked":400,"concurrent_activation_statuses":[200,400],"disabled_project_blocked":400}
```

退出状态：`0`。浏览器验证同时确认单张复制、复制本页、刷新后恢复完整卡密以及 375px 移动视口。验证后已删除 `signed-smoke-*` 和 `ui-smoke-*` 临时项目；生产库保留原有 `1` 个用户项目。

## 回滚

本次卡密可见性改造前版本：`25e3db51-98f0-40aa-9f75-08d8d8352e62`。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\rollback.ps1 `
  -VersionId '25e3db51-98f0-40aa-9f75-08d8d8352e62' `
  -Message 'Rollback recoverable license keys'
```

Worker 版本回滚不会回退 D1。`0003_recoverable_license_keys.sql` 只新增可空密文字段和带默认值的版本字段，旧 Worker 会忽略这些字段，因此代码可直接回滚；不要为回滚破坏性删除 D1 列。
