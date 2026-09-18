'use strict';

const $ = (sel) => document.querySelector(sel);

const storeForm = $('#storeForm');
const requestForm = $('#requestForm');
const resetBtn = $('#resetBtn');
const storeResult = $('#storeResult');
const requestResult = $('#requestResult');
const jarBody = $('#jarBody');
const jarCount = $('#jarCount');
const jarEmpty = $('#jarEmpty');

const responseUrlInput = $('#responseUrl');
const setCookieInput = $('#setCookie');
const requestUrlInput = $('#requestUrl');

const DEMOS = {
  domain: {
    responseUrl: 'https://shop.example.com/admin/orders/list',
    setCookie: 'sid=abc123; Domain=example.com; Path=/admin; Max-Age=3600; Secure',
  },
  hostonly: {
    responseUrl: 'https://shop.example.com/login',
    setCookie: 'sessionId=host-only-token; Path=/; Max-Age=600',
  },
  defaultpath: {
    responseUrl: 'https://shop.example.com/admin/orders/list',
    setCookie: 'theme=dark; Max-Age=86400',
  },
  reject: {
    responseUrl: 'https://shop.example.com/admin/orders/list',
    setCookie: 'evil=1; Domain=attacker.com; Path=/',
  },
  delete: {
    responseUrl: 'https://shop.example.com/admin/orders/list',
    setCookie: 'sid=; Domain=example.com; Path=/admin; Max-Age=0',
  },
  'req-https': { requestUrl: 'https://shop.example.com/admin/orders/123' },
  'req-http': { requestUrl: 'http://shop.example.com/admin/orders/123' },
  'req-root': { requestUrl: 'https://example.com/' },
};

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

function esc(value) {
  const span = document.createElement('span');
  span.textContent = value == null ? '' : String(value);
  return span.innerHTML;
}

function badge(code, text) {
  const cls = {
    SENT: 'badge-ok',
    EXPIRED: 'badge-err',
    DOMAIN_NO_MATCH: 'badge-warn',
    PATH_NO_MATCH: 'badge-warn',
    SECURE_ONLY: 'badge-warn',
  }[code] || 'badge-neutral';
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function scopeLabel(cookie) {
  if (cookie.hostOnly) {
    return `host-only<div class="detail">原主机 ${esc(cookie.host)}</div>`;
  }
  return `Domain<div class="detail">${esc(cookie.domain)} 及其子域</div>`;
}

function lifeLabel(cookie) {
  if (cookie.session) return '会话期';
  const date = new Date(cookie.expiresAt).toLocaleString();
  return `${date}`;
}

function renderJar(jar) {
  jarCount.textContent = `${jar.length} 项`;
  jarEmpty.style.display = jar.length === 0 ? 'block' : 'none';
  jarBody.innerHTML = jar
    .map((c) => {
      const status = c.expired
        ? '<span class="badge badge-err">已过期</span>'
        : '<span class="badge badge-ok">有效</span>';
      return `
        <tr class="${c.expired ? 'row-expired' : ''}">
          <td>${c.id}</td>
          <td class="mono">${esc(c.name)}</td>
          <td class="mono">${esc(c.value) || '<em>(空值)</em>'}</td>
          <td>${scopeLabel(c)}</td>
          <td class="mono">${esc(c.path)}</td>
          <td>${c.secure ? '<span class="badge badge-info">Secure</span>' : '—'}</td>
          <td>${lifeLabel(c)}</td>
          <td>${status}</td>
        </tr>`;
    })
    .join('');
}

const STATUS_TEXT = {
  STORED: ['ok', '✅ 已入罐'],
  SESSION_STORED: ['ok', '✅ 已入罐（会话期）'],
  REPLACED: ['ok', '♻️ 已覆盖更新'],
  EXPIRED_DELETED: ['info', '🗑️ 按 Max-Age 删除'],
  INVALID_URL: ['err', '❌ URL 无效'],
  EMPTY_SET_COOKIE: ['err', '❌ Set-Cookie 为空'],
  MISSING_NAME_VALUE: ['err', '❌ Set-Cookie 格式错误'],
  INVALID_MAX_AGE: ['err', '❌ Max-Age 非法'],
  DOMAIN_MISMATCH: ['err', '⛔ Domain 与响应主机不匹配，拒绝入罐'],
};

function renderStoreResult(data) {
  const [kind, title] = STATUS_TEXT[data.status] || ['err', '❌ 被拒绝'];
  storeResult.className = `result ${kind}`;
  const parsed = data.parsed
    ? `<p class="detail">解析：name=<code>${esc(data.parsed.name)}</code>
         value=<code>${esc(data.parsed.value)}</code>
         domain=<code>${esc(data.parsed.domain ?? '(无 → host-only)')}</code>
         path=<code>${esc(data.parsed.path ?? '(无 → 取 URL 目录)')}</code>
         max-age=<code>${esc(data.parsed.maxAge ?? '(无)')}</code>
         secure=<code>${data.parsed.secure}</code>
         ${data.responseHost ? `；响应主机 <code>${esc(data.responseHost)}</code>` : ''}
       </p>`
    : (data.responseHost ? `<p class="detail">响应主机：<code>${esc(data.responseHost)}</code></p>` : '');
  storeResult.innerHTML = `
    <div class="result-title">${title} ${badge(data.status, data.status)}</div>
    <div>${esc(data.reason)}</div>
    ${parsed}`;
  renderJar(data.jar);
}

function decisionItem(d, order) {
  const key = `${d.cookie.name}=${d.cookie.value}`;
  const orderText = order !== null ? `发送序 #${order}` : '不发送';
  return `
    <li class="decision-item ${d.sent ? 'sent' : 'excluded'}">
      <div class="decision-head">
        ${badge(d.code, d.code)}
        <span class="cookie-key">${esc(key)}</span>
        <span class="badge badge-neutral">${esc(orderText)}</span>
        <span class="detail">${esc(d.cookie.domain)}${esc(d.cookie.path)}${d.cookie.secure ? ' · Secure' : ''}</span>
      </div>
      <div class="reason">${esc(d.reason)}</div>
    </li>`;
}

function renderRequestResult(data) {
  if (!data.ok) {
    requestResult.className = 'result err';
    requestResult.innerHTML = `
      <div class="result-title">❌ 请求 URL 无效</div>
      <div>${esc(data.reason)}</div>`;
    renderJar(data.jar);
    return;
  }

  requestResult.className = 'result info';
  const sentItems = data.sent
    .map((d, i) => decisionItem(d, i + 1))
    .join('');
  const excludedItems = data.excluded
    .map((d) => decisionItem(d, null))
    .join('');

  const headerEmpty = data.cookieHeader.length === 0;
  requestResult.innerHTML = `
    <div class="result-title">
      📤 演算完成：${data.sent.length} 项发送，${data.excluded.length} 项排除
      <span class="badge badge-neutral">${esc(data.host)}</span>
      <span class="badge badge-neutral">${esc(data.path)}</span>
      <span class="badge ${data.isSecure ? 'badge-ok' : 'badge-warn'}">${data.isSecure ? 'HTTPS' : 'HTTP'}</span>
    </div>
    <div class="cookie-header-box">
      <button type="button" class="copy-btn" id="copyHeader">复制</button>
      <strong>Cookie 请求头：</strong><br />
      ${headerEmpty ? '<em>(空 — 没有任何匹配项)</em>' : esc(data.cookieHeader)}
    </div>
    ${sentItems ? `<ul class="decision-list">${sentItems}</ul>` : ''}
    ${excludedItems ? `<div class="detail" style="margin-top:12px">排除项及原因：</div><ul class="decision-list">${excludedItems}</ul>` : ''}`;

  const copyBtn = $('#copyHeader');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(data.cookieHeader);
      copyBtn.textContent = '已复制';
      setTimeout(() => (copyBtn.textContent = '复制'), 1200);
    } catch {
      copyBtn.textContent = '复制失败';
    }
  });

  renderJar(data.jar);
}

storeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  storeResult.className = 'result info';
  storeResult.textContent = '处理中…';
  storeResult.classList.remove('hidden');
  try {
    const data = await postJson('/api/store', {
      responseUrl: responseUrlInput.value,
      setCookie: setCookieInput.value,
    });
    renderStoreResult(data);
  } catch (err) {
    storeResult.className = 'result err';
    storeResult.textContent = `请求失败：${err.message}`;
  }
});

requestForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  requestResult.className = 'result info';
  requestResult.textContent = '演算中…';
  requestResult.classList.remove('hidden');
  try {
    const data = await postJson('/api/request', {
      requestUrl: requestUrlInput.value,
    });
    renderRequestResult(data);
  } catch (err) {
    requestResult.className = 'result err';
    requestResult.textContent = `请求失败：${err.message}`;
  }
});

resetBtn.addEventListener('click', async () => {
  const data = await postJson('/api/reset', {});
  renderJar(data.jar);
  storeResult.classList.add('hidden');
  requestResult.classList.add('hidden');
});

document.querySelectorAll('.chip[data-demo]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const demo = DEMOS[btn.dataset.demo];
    if (!demo) return;
    if (demo.responseUrl !== undefined) {
      responseUrlInput.value = demo.responseUrl;
      setCookieInput.value = demo.setCookie;
      storeForm.requestSubmit();
    } else if (demo.requestUrl !== undefined) {
      requestUrlInput.value = demo.requestUrl;
      requestForm.requestSubmit();
    }
  });
});

async function refreshJar() {
  const resp = await fetch('/api/jar');
  const data = await resp.json();
  renderJar(data.jar);
}

refreshJar();
