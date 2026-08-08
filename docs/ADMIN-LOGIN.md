# 管理台账号密码登录

## 使用

打开 <https://license.145156.xyz>，输入管理员账号与密码。会话只保存在浏览器的 `sessionStorage`，关闭该浏览器会话后需要重新登录。

## API

```http
POST /api/admin/login
Content-Type: application/json

{"username":"ADMIN_USERNAME","password":"ADMIN_PASSWORD"}
```

响应中的 `token` 是 8 小时有效的签名会话。管理 API 请求统一携带：

```http
Authorization: Bearer <token>
```

`ADMIN_API_TOKEN` 仍可作为自动化 service token 使用，不在浏览器页面中展示或输入。

## 存储与校验

- 密码使用 `PBKDF2-HMAC-SHA-256`、100,000 次迭代和 24 字节随机盐派生。
- Worker Secret 保存账号、盐、派生值和 32 字节会话签名密钥。
- 登录成功签发包含账号、签发时间、到期时间和随机 nonce 的 HMAC 会话。
- 会话签名、账号与到期时间均在每次管理请求时验证。
- 登录每个来源 IP 每分钟最多 10 次；错误凭据统一返回 401。

## 修改密码

生成新的随机盐、PBKDF2 派生值和会话签名密钥，然后覆盖以下 Secrets：

```text
ADMIN_PASSWORD_HASH
ADMIN_PASSWORD_SALT
ADMIN_SESSION_SECRET
```

同时轮换 `ADMIN_SESSION_SECRET` 会立即使所有旧浏览器会话失效。修改账号时再覆盖 `ADMIN_USERNAME`。

## 验证

```powershell
$env:BASE_URL='https://license.145156.xyz'
$env:ADMIN_USERNAME='<admin username>'
$env:ADMIN_PASSWORD='<admin password>'
npm.cmd run smoke
```

smoke 会验证错误密码、正确登录、项目/套餐/卡密生成、一卡并发抢占、设备签名续验和停用阻断。生产执行后应删除 `signed-smoke-*` 测试项目。
