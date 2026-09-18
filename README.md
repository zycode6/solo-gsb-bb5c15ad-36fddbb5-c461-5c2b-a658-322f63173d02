# 🍪 Cookie 罐演算 Web 工具

一个用来直观演算 HTTP Cookie 入罐与发送规则的 Web 工具（RFC 6265 子集）。
后端使用 **TypeScript + Express**，前端为**原生 HTML/CSS/JavaScript**，无任何前端框架。

逐条提交「响应 URL + 单条 `Set-Cookie`」，服务端更新**进程内存中的 Cookie 罐**；
再输入「请求 URL」，即可看到每一项 Cookie 被发送或被排除的原因，以及最终生成的
`Cookie` 请求头。

---

## 🚀 单条命令启动（Docker Compose）

```bash
docker compose up --build -d
```

启动后访问：

> **http://localhost:3000**

容器对外暴露端口 **3000**（`compose.yaml` 中映射，可按需修改宿主机端口）。
停止与清理：

```bash
docker compose down          # 停止并删除容器
```

也可以直接用 Docker：

```bash
docker build -t cookie-jar-lab .
docker run --rm -p 3000:3000 --name cookie-jar-lab cookie-jar-lab
# 访问 http://localhost:3000
```

## 本地运行（不使用 Docker）

要求 Node.js ≥ 18。

```bash
npm install
npm run build
npm start            # 默认 http://localhost:3000
# 或开发模式（自动重启）：npm run dev
```

可通过环境变量更换端口：`PORT=8080 npm start`。

---

## 使用流程

1. **① 响应阶段**：填写响应 URL 与一条 `Set-Cookie`，点击「送入 Cookie 罐」。
   结果区显示入罐 / 覆盖 / 删除 / 被拒绝及其原因。
2. **② 请求阶段**：填写请求 URL，点击「演算请求」。
   - 展示最终的 `Cookie` 请求头（可一键复制）；
   - 逐项列出 **发送** 与 **排除**（含排除原因：过期 / 域不匹配 / 路径不匹配 / Secure 限制）；
   - 发送项标注了在 Cookie 头中的顺序。
3. **③ 当前 Cookie 罐**：表格展示所有条目（含已过期项，便于演算对照）。
4. 右上角「**重置 Cookie 罐**」一键清空（服务重启也会清空，数据仅存于内存）。

页面内置快速示例按钮：Domain 子域、host-only、缺省 Path、不匹配 Domain、
`Max-Age≤0` 删除，以及 HTTPS / HTTP / 根路径请求演算。

---

## 演算规则

| 环节 | 规则 |
| --- | --- |
| **Domain 校验** | 带 `Domain` 属性时，必须与响应主机相等或是其上级域（如响应主机 `a.b.example.com` 允许 `Domain=example.com`），否则**拒绝入罐**。不带 `Domain` 则成为 **host-only** Cookie，作用域为响应主机本身。 |
| **缺省 Path** | 不带 `Path` 属性时，取响应 URL 路径中**最后一个斜杠之前的目录**（RFC 6265 5.1.4）：`/admin/orders/list → /admin/orders`；根级路径 `/x → /`；根路径 `→ /`。 |
| **Max-Age** | `Max-Age>0` 按秒计算绝对过期时间；缺省为**会话期 Cookie**；`Max-Age≤0` **删除同名、同域、同路径**的条目（不存在则空操作）。`Max-Age` 非整数则拒绝该条 Set-Cookie。 |
| **覆盖语义** | 存储键为 `name + domain + path`；重复入罐覆盖 value / 过期时间 / Secure，但**保留首次创建序号**（创建顺序永不改变）。 |
| **域匹配** | host-only 仅匹配**原主机**；Domain cookie 匹配该域本身及其**子域**（点边界，`myexample.com` 不会匹配 `example.com`）。 |
| **路径匹配** | 请求路径与 cookie Path **相等**；或以其开头，并且 Path 以 `/` 结尾，或紧接着的边界字符是 `/`（`Path=/admin` 匹配 `/admin`、`/admin/x`，但不匹配 `/administrator`）。 |
| **Secure** | 标记 Secure 的 Cookie 仅在请求为 **HTTPS** 时发送；HTTP 下作为排除项并给出原因。 |
| **过期** | 已过期项不发送（原因标注过期时间）；罐中保留展示，重置时清除。 |
| **排序** | 发送前按 **Path 长度降序**排序，长度相同按 **首次创建顺序升序**（`#1 → #2 …`），随后以 `name=value; name=value` 拼接为 `Cookie` 头。 |

仅演算 `Domain` / `Path` / `Max-Age` / `Secure` 四个属性；`Expires`、
`HttpOnly`、`SameSite` 等属性会被解析但忽略。URL 仅支持 `http` / `https`。

---

## HTTP API

| 方法 | 路径 | 请求体 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/store` | `{ "responseUrl": string, "setCookie": string }` | 处理一条响应，返回入罐结果与完整罐快照 |
| POST | `/api/request` | `{ "requestUrl": string }` | 演算请求，返回 `cookieHeader`、`sent[]`、`excluded[]`（逐项含 reason） |
| POST | `/api/reset` | `{}` | 清空 Cookie 罐 |
| GET | `/api/jar` | — | 查看当前罐快照 |

curl 示例：

```bash
# 入罐
curl -s -X POST http://localhost:3000/api/store \
  -H 'Content-Type: application/json' \
  -d '{"responseUrl":"https://shop.example.com/admin/orders/list","setCookie":"sid=abc; Domain=example.com; Path=/admin; Max-Age=3600; Secure"}'

# 请求演算
curl -s -X POST http://localhost:3000/api/request \
  -H 'Content-Type: application/json' \
  -d '{"requestUrl":"https://shop.example.com/admin/orders/123"}'

# 重置
curl -s -X POST http://localhost:3000/api/reset -H 'Content-Type: application/json' -d '{}'
```

---

## 项目结构

```
.
├── Dockerfile            # 多阶段构建（TS 编译 + 精简运行镜像，非 root 运行）
├── compose.yaml          # 一条命令启动，映射 3000 端口
├── package.json
├── tsconfig.json
├── src/
│   ├── server.ts         # Express 入口与 REST API
│   └── cookieJar.ts      # Cookie 罐核心：解析 / 入罐 / 匹配 / 排序
└── public/               # 原生前端
    ├── index.html
    ├── styles.css
    └── app.js
```
