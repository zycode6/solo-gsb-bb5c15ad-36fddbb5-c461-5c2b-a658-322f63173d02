import express from 'express';
import path from 'path';
import { CookieJar } from './cookieJar';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// 进程级内存 Cookie 罐（单实例演算工具，重启即清空）
const jar = new CookieJar();

app.post('/api/store', (req, res) => {
  const { responseUrl, setCookie } = req.body ?? {};
  if (typeof responseUrl !== 'string' || typeof setCookie !== 'string') {
    res.status(400).json({
      ok: false,
      reason: '请求体必须是 JSON：{ "responseUrl": string, "setCookie": string }',
    });
    return;
  }
  res.json(jar.store(responseUrl, setCookie, Date.now()));
});

app.post('/api/request', (req, res) => {
  const { requestUrl } = req.body ?? {};
  if (typeof requestUrl !== 'string') {
    res.status(400).json({
      ok: false,
      reason: '请求体必须是 JSON：{ "requestUrl": string }',
    });
    return;
  }
  res.json(jar.evaluate(requestUrl, Date.now()));
});

app.post('/api/reset', (_req, res) => {
  jar.reset();
  res.json({ ok: true, reason: 'Cookie 罐已清空', jar: [] });
});

app.get('/api/jar', (_req, res) => {
  res.json({ ok: true, jar: jar.list(Date.now()) });
});

app.listen(PORT, () => {
  console.log(`Cookie 罐演算工具已启动: http://localhost:${PORT}`);
});
