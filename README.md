# 🍪 Cookie 罐演算 Web 工具 · Cookie Jar Lab

一个用于**演算 HTTP Cookie 写入与发送规则**的教学/调试 Web 工具：你按顺序提交
「响应 URL + 单条 Set-Cookie」，服务端按 [RFC 6265](https://www.rfc-editor.org/rfc/rfc6265)
更新内存 Cookie 罐；再输入请求 URL，即可看到生成的 `Cookie` 请求头，以及每一项
**被发送或被排除的具体原因**。

技术栈：**TypeScript + Express + 原生 HTML/CSS/JS**（前端无框架、无构建），数据仅存内存。

---

## 🚀 单条启动命令

需要安装 Docker（含 Compose 插件）。在项目根目录执行：

```bash
docker compose up --build -d
```

启动后浏览器访问：

> **http://localhost:3000**

- 容器内服务端口：**3000**
- 宿主机默认映射端口：**3000**（想换端口改 `docker-compose.yml` 左侧，如 `"3001:3000"`）

停止与清理：

```bash
docker compose down          # 停止并删除容器（镜像保留）
docker compose down --rmi local   # 同时删除本工具镜像
```

> 不想用 Docker？见文末[不用 Docker 的本地运行](#不用-docker-的本地运行)。

---

## 🧭 使用流程

界面分为三步：

1. **写入 Set-Cookie**（可重复执行，模拟多个响应、按顺序入罐）
   - 填「响应 URL」（cookie 来源页面），如 `https://shop.example.com/admin/dashboard?tab=1`
   - 填「单条 Set-Cookie」（**不要**带 `Set-Cookie:` 前缀），如：
     `session=abc123; Domain=example.com; Path=/; Max-Age=3600; Secure`
   - 点击 **入罐**，查看入罐 / 更新 / 删除 / 拒绝结果与原因
2. **发起请求**：填请求 URL（如 `https://api.shop.example.com/orders/123/detail`），
   点击 **生成 Cookie 头**，查看：
   - 最终 `Cookie:` 请求头（可一键复制）
   - 📤 **发送项**：命中的主机 / Path / Secure 匹配点
   - 🚫 **排除项**：过期、Domain 不匹配、Path 不匹配、Secure 受限等逐项原因
3. **🫙 当前 Cookie 罐**：右侧表格实时展示全部条目（域、作用域、Path、Secure、
   有效期剩余、创建序号）；点击 **重置** 清空内存罐。

### 推荐演算示例（按顺序）

| # | 响应 URL | Set-Cookie | 预期 |
|---|----------|-----------|------|
| 1 | `https://shop.example.com/admin/dashboard` | `sid=host123; Path=/admin; Max-Age=600` | 入罐（host-only，默认 Path 这里被属性指定为 `/admin`） |
| 2 | `https://shop.example.com/admin/dashboard` | `tracker=xyz; Max-Age=3600` | 入罐（host-only，**默认 Path=/admin**） |
| 3 | `https://example.com/` | `prefs=a=1; Domain=example.com; Path=/` | 入罐（Domain cookie，覆盖 `example.com` 及所有子域） |
| 4 | `http://evil.example.org/` | `bad=nope; Domain=example.com` | **拒绝**：Domain 不匹配响应主机 |
| 5 | `https://shop.example.com/admin/dashboard` | `tracker=; Max-Age=0` | **删除**同名同域同路径的 tracker |
| 6 | `https://example.com/` | `secure=1; Path=/; Secure` | 入罐（仅 https 发送） |

然后分别用以下请求 URL 观察差异：

- `https://api.shop.example.com/admin/orders/9` —— 域 + Path 匹配
- `http://shop.example.com/admin/dashboard` —— 明文 http，Secure 项被排除
- `https://shop.example.com/home` —— Path 不匹配的项被排除并给出原因

---

## 📐 实现的演算规则

### 写入（处理 Set-Cookie）

- **Domain**
  - 不带 `Domain` 属性 → **host-only cookie**，只匹配原主机；
  - 带 `Domain` → 规范化（小写、去前导点），且必须是响应主机本身或其上级域，
    否则**拒绝入罐**；
  - 主机是 IP 地址时不做域/子域匹配（Domain 不一致即拒绝）。
- **Path**
  - 合法属性值必须以 `/` 开头，否则忽略属性；
  - **缺省（或非法）时取响应 URL 路径最后一个斜杠之前的目录**
   （`/admin/dashboard` → `/admin`；根路径 → `/`）。
- **Max-Age**
  - 正整数：相对有效期（秒），换算成绝对过期时间；
  - **`<= 0`（含 `0` 与负数）：删除同名 `(name, domain, path)` 项**，不存在则说明无可删除；
  - 非法值（非整数）：忽略并提示，按会话 cookie 处理。`Expires` 属性不参与本演算。
- **Secure**：记录该属性；在明文 `http` 响应中设置会给出提示，且之后绝不会经 http 发送。
- **同名同域同路径**再次写入 → 覆盖更新，**沿用首次创建序号**（保证排序稳定）。

### 发送（处理请求 URL）

逐条检查（顺序与 RFC 6265 一致）：

1. **过期检查**：已过期不发送（罐中保留并标灰显示）；
2. **Domain 匹配**：host-only 仅精确匹配原主机；Domain cookie 匹配该域及其子域；
3. **Path 匹配**：请求路径与 cookie-path 相等，或以其开头且边界字符是 `/`；
4. **Secure 检查**：Secure cookie 只在 `https:` 请求中发送。

通过检查的条目按：

> **Path 长度降序 → 首次创建顺序（#序号）升序**

排序后以 `; ` 拼接成 `Cookie` 请求头（RFC 6265 的 cookie 排序要求）。

---

## 🔌 HTTP API

| 方法 | 路径 | Body（JSON） | 说明 |
|------|------|--------------|------|
| GET | `/api/jar` | — | 当前罐快照 |
| POST | `/api/store` | `{ "url": "...", "setCookie": "..." }` | 顺序写入一条 Set-Cookie |
| POST | `/api/send` | `{ "url": "..." }` | 演算 Cookie 头与逐项原因 |
| POST | `/api/reset` | — | 清空内存罐 |

curl 示例：

```bash
# 写入
curl -s -X POST http://localhost:3000/api/store \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://shop.example.com/admin/dashboard",
       "setCookie":"sid=abc; Domain=example.com; Path=/; Max-Age=3600; Secure"}'

# 演算请求
curl -s -X POST http://localhost:3000/api/send \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://api.shop.example.com/orders/123"}'

# 重置
curl -s -X POST http://localhost:3000/api/reset
```

---

## 📁 项目结构

```
.
├── Dockerfile              # 多阶段构建：tsc 编译 → 精简运行镜像
├── docker-compose.yml      # 单条命令启动（3000:3000）
├── package.json
├── tsconfig.json
├── src
│   ├── server.ts           # Express 入口与 API
│   └── cookieJar.ts        # 全部 Cookie 演算规则（解析/入罐/匹配/排序）
└── public
    ├── index.html          # 原生前端页面
    ├── styles.css
    └── app.js
```

## 不用 Docker 的本地运行

需要 Node.js 18+（推荐 20）：

```bash
npm install
npm run build      # tsc 编译到 dist/
npm start          # 打开 http://localhost:3000
```

开发模式（免编译，自动 ts-node 直跑）：

```bash
npm run dev
```

> 说明：本工具是**演算/教学工具**，Cookie 仅存于服务端进程内存，刻意只实现
> Domain / Path / Max-Age / Secure 等题目要求的规则；不处理 SameSite、HttpOnly
> 发送限制（仅展示标签）、Expires、public suffix list、cookie 大小/数量上限等。
