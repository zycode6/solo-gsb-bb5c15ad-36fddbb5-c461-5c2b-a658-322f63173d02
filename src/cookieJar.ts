/**
 * cookieJar.ts
 *
 * 内存 Cookie 罐的全部演算逻辑，规则对齐 RFC 6265（HTTP State Management Mechanism）：
 *
 *  写入（Set-Cookie）：
 *   - Domain 不匹配响应主机（不是主机本身、也不是其上级域）时拒绝；
 *   - 省略 Domain 时为 host-only cookie；带 Domain 时去掉前导点且为 Domain cookie；
 *   - Path 缺省取「响应 URL 路径最后一个斜杠之前的目录」（RFC 5.1.4 default-path）；
 *   - Max-Age <= 0（含 0、负数）删除同名 (name, domain, path) 项；
 *   - Max-Age 非法值时忽略（按会话 cookie 处理并给出提示）；
 *   - Secure cookie 在明文 http 响应里写入会给出提示（真实浏览器通常拒绝）。
 *
 *  发送（请求 URL）：
 *   - 已过期的不发送；
 *   - host-only 仅精确匹配原主机；Domain cookie 匹配该域及其子域；IP 主机不做子域匹配；
 *   - Path 须相等，或以 cookie-path 开头且下一个字符是 "/"（path-match）；
 *   - Secure cookie 只通过 https: 请求发送；
 *   - 排序：Path 长度降序；相同长度按首次创建顺序（creation index）升序。
 */

/** 罐中的单条 cookie（存储模型） */
export interface StoredCookie {
  name: string;
  value: string;
  /** 规范化为小写后的域。host-only 时为原主机；Domain cookie 时为属性域（无前导点） */
  domain: string;
  path: string;
  /** true = 仅精确匹配 domain 主机；false = 匹配 domain 及其子域 */
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  /** 过期绝对时间戳（ms）；undefined 表示会话 cookie（本工具中永不过期，重启清空） */
  expiresAt?: number;
  /** 首次创建序号，从 1 开始；更新同名项时沿用，保证排序稳定 */
  creationIndex: number;
  /** 首次创建时间戳；更新同名项时保留 */
  createdAt: number;
  /** 最近一次写入（创建或更新）的时间戳 */
  updatedAt: number;
}

/** 解析后的 Set-Cookie（单条） */
export interface ParsedSetCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  maxAge?: number;
  /** 原始 Max-Age 是否非法（非法时忽略，按会话 cookie 处理） */
  maxAgeInvalid: boolean;
  secure: boolean;
  httpOnly: boolean;
}

/** 前端表格 / API 共用的展示视图 */
export interface CookieView {
  index: number;
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  scope: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  persistent: boolean;
  expiresAt: string | null;
  remaining: string | null;
  expired: boolean;
  createdAt: string;
  updatedAt: string;
}

export type StoreAction = 'stored' | 'updated' | 'deleted' | 'rejected';
export type ItemVerdict = 'send' | 'exclude';

export interface StoreResult {
  ok: boolean;
  action: StoreAction;
  reason: string;
  /** 被更新时沿用的首次创建序号 */
  inheritedIndex?: number;
  /** 非致命的提示信息（例如明文 http 写入 Secure） */
  notices: string[];
  cookie: CookieView | null;
  jar: CookieView[];
}

export interface RequestItem {
  index: number;
  cookie: string;
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  verdict: ItemVerdict;
  /** 发送：命中的匹配点；排除：排除原因 */
  detail: string;
  expired: boolean;
}

export interface SendResult {
  ok: boolean;
  error?: string;
  requestUrl: string;
  host: string;
  path: string;
  secureRequest: boolean;
  cookieHeader: string;
  sent: RequestItem[];
  excluded: RequestItem[];
}

/** 年份过大会让 Date 抛异常，这里钳制到一个安全的绝对上限（约公元 275760 年） */
const MAX_SAFE_EXPIRES = 8_640_000_000_000_000;

/** cookie-name 允许的可见 ASCII（RFC 6265 token，排除分隔符与空白） */
const VALID_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本地时区的可读时间，例如 2026-09-18 14:03:07 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 剩余有效期的人类可读描述 */
export function formatRemaining(expiresAt: number, now: number): string {
  let ms = expiresAt - now;
  if (ms <= 0) return '已过期';
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (mins > 0) parts.push(`${mins} 分`);
  parts.push(`${secs} 秒`);
  return parts.join(' ');
}

/**
 * 解析单条 Set-Cookie 头（不含 "Set-Cookie:" 前缀）。
 * 第一个 "=" 之前为 name、其后到第一个 ";" 之前为 value；其余为属性。
 */
export function parseSetCookie(raw: string): ParsedSetCookie {
  const header = raw.trim();
  if (header.length === 0) {
    throw new Error('Set-Cookie 内容为空');
  }

  const segments = header.split(';').map((s) => s.trim());
  const first = segments[0];
  const eq = first.indexOf('=');
  if (eq <= 0) {
    throw new Error('缺少有效的 cookie-name（需要 "名称=值" 形式）');
  }

  const name = first.slice(0, eq).trim();
  let value = first.slice(eq + 1).trim();
  if (name.length === 0 || !VALID_NAME_RE.test(name)) {
    throw new Error(`cookie-name 非法："${name}"`);
  }
  // 值允许为空字符串；去掉成对的双引号（cookie-value 的 quoted-string 形式）
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }

  const parsed: ParsedSetCookie = {
    name,
    value,
    maxAgeInvalid: false,
    secure: false,
    httpOnly: false,
  };

  for (let i = 1; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.length === 0) continue;
    const semi = seg.indexOf('=');
    const attrName = (semi === -1 ? seg : seg.slice(0, semi)).trim().toLowerCase();
    const attrValue = semi === -1 ? '' : seg.slice(semi + 1).trim();

    switch (attrName) {
      case 'domain':
        if (attrValue.length > 0) parsed.domain = attrValue;
        break;
      case 'path':
        if (attrValue.length > 0) parsed.path = attrValue;
        break;
      case 'max-age': {
        if (!/^-?\d+$/.test(attrValue)) {
          parsed.maxAgeInvalid = true;
        } else {
          const n = Number(attrValue);
          parsed.maxAge = Number.isFinite(n) ? n : undefined;
          if (!Number.isFinite(n)) parsed.maxAgeInvalid = true;
        }
        break;
      }
      case 'secure':
        parsed.secure = true;
        break;
      case 'httponly':
        parsed.httpOnly = true;
        break;
      // Expires / SameSite / 未知属性：本演算不参与，直接忽略
      default:
        break;
    }
  }

  return parsed;
}

/** 域规范化：小写并去掉最多一个前导点（RFC 5.3.6） */
export function canonicalizeDomain(domain: string): string {
  let d = domain.trim().toLowerCase();
  if (d.startsWith('.')) d = d.slice(1);
  // IPv6/IPvFuture 可能被方括号包裹，去掉外壳
  if (d.startsWith('[') && d.endsWith(']')) d = d.slice(1, -1);
  return d;
}

/** 从绝对 URL 中取出主机（小写、无方括号、无端口）；非法 http(s) URL 返回 null */
export function hostFromUrl(rawUrl: string): { host: string; protocol: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return null;
  }
  if (!u.hostname) return null;
  let host = u.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, protocol: u.protocol, path: u.pathname || '/' };
}

/** 粗略识别 IPv4 / IPv6（含 zone id）主机；IP 主机不参与域/子域匹配 */
export function isIpAddress(host: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((p) => Number(p) <= 255);
  }
  // 至少包含一个冒号即按 IPv6 处理（URL 解析后不含方括号；zone id 的 % 也允许）
  return host.includes(':') && /^[0-9a-f:%]+$/i.test(host);
}

/**
 * domain-match（RFC 5.1.3）：
 *  host-only cookie 要求 host 与 domain 完全相等；
 *  Domain cookie 要求 host == domain，或 host 以 "." + domain 结尾。
 */
export function domainMatch(host: string, cookie: StoredCookie): boolean {
  if (cookie.hostOnly) return host === cookie.domain;
  if (host === cookie.domain) return true;
  return host.endsWith(`.${cookie.domain}`);
}

/**
 * default-path（RFC 5.1.4）：
 *  - 路径为空或不以 "/" 开头：默认 "/"
 *  - 只有一个斜杠：默认 "/"
 *  - 否则取最后一个斜杠之前的部分（不含最后斜杠后的任何字符）
 */
export function defaultPath(requestPath: string): string {
  const p = requestPath || '/';
  if (!p.startsWith('/')) return '/';
  const lastSlash = p.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return p.slice(0, lastSlash);
}

/**
 * path-match（RFC 5.1.4）：
 *  - request-path 与 cookie-path 相等；或
 *  - request-path 以 cookie-path 开头，且 cookie-path 以 "/" 结尾；或
 *  - request-path 以 cookie-path 开头，且紧随其后的字符是 "/"
 */
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return requestPath.charAt(cookiePath.length) === '/';
}

/** 内存 Cookie 罐 */
export class CookieJar {
  private cookies: StoredCookie[] = [];
  private nextIndex = 1;

  /**
   * 按顺序处理一次「响应 URL + 单条 Set-Cookie」写入。
   * 返回动作（入罐 / 更新 / 删除 / 拒绝）及原因。
   */
  store(responseUrl: string, setCookieHeader: string, now: number = Date.now()): StoreResult {
    const urlInfo = hostFromUrl(responseUrl);
    if (!urlInfo) {
      return this.result(false, 'rejected', `响应 URL 非法或非 http(s)：${responseUrl}`, []);
    }

    let parsed: ParsedSetCookie;
    try {
      parsed = parseSetCookie(setCookieHeader);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.result(false, 'rejected', `Set-Cookie 解析失败：${message}`, []);
    }

    const { host } = urlInfo;
    const notices: string[] = [];

    // ---- 1. Domain 处理：规范化 + 与响应主机校验 ----
    let domain: string;
    let hostOnly: boolean;
    if (parsed.domain === undefined) {
      // 省略 Domain：host-only，域就是原主机
      domain = host;
      hostOnly = true;
    } else {
      domain = canonicalizeDomain(parsed.domain);
      if (domain.length === 0) {
        return this.result(false, 'rejected', 'Domain 属性为空，无法入罐', notices, parsed);
      }
      if (isIpAddress(host) || isIpAddress(domain)) {
        // RFC 6265：IP 主机忽略 Domain 属性，按 host-only 处理
        if (host !== domain) {
          return this.result(
            false,
            'rejected',
            `响应主机 ${host} 是 IP 地址，Domain=${domain} 与其不一致；IP 不允许域/子域匹配，拒绝入罐`,
            notices,
            parsed,
          );
        }
        domain = host;
        hostOnly = true;
        notices.push(`主机为 IP 地址，忽略 Domain 属性，按 host-only 记录`);
      } else if (host === domain) {
        hostOnly = false;
      } else if (host.endsWith(`.${domain}`)) {
        hostOnly = false;
      } else {
        return this.result(
          false,
          'rejected',
          `Domain=${domain} 不匹配响应主机 ${host}（既不是主机本身，也不是其上级域），拒绝入罐`,
          notices,
          parsed,
        );
      }
    }

    // ---- 2. Path 处理：缺省取 default-path ----
    let cookiePath: string;
    if (parsed.path === undefined || !parsed.path.startsWith('/')) {
      cookiePath = defaultPath(urlInfo.path);
      if (parsed.path !== undefined) {
        notices.push(`Path="${parsed.path}" 不是绝对路径，忽略并使用默认 Path=${cookiePath}`);
      } else {
        notices.push(`Path 属性缺省，取默认路径（响应 URL 最后一个斜杠前的目录）：${cookiePath}`);
      }
    } else {
      cookiePath = parsed.path;
    }

    // ---- 3. Secure 提示：明文 http 响应写入 Secure ----
    if (parsed.secure && urlInfo.protocol === 'http:') {
      notices.push('响应来自明文 http:// 却带 Secure 属性：真实浏览器通常会拒绝该 cookie；本罐仍记录，但它永远不会经 http 请求发送');
    }
    if (parsed.maxAgeInvalid) {
      notices.push('Max-Age 值非法（非整数），已忽略该属性，按会话 cookie 处理（Expires 同样不参与本演算）');
    }

    const existing = this.findCookie(parsed.name, domain, cookiePath);

    // ---- 4. Max-Age <= 0：删除同名 (name, domain, path) 项 ----
    if (parsed.maxAge !== undefined && parsed.maxAge <= 0) {
      if (existing) {
        this.cookies = this.cookies.filter((c) => c !== existing);
        return this.result(
          true,
          'deleted',
          `Max-Age=${parsed.maxAge}（≤0），已删除同名同域同路径项 ${parsed.name}=…（#${existing.creationIndex}，domain=${domain}，path=${cookiePath}）`,
          notices,
        );
      }
      return this.result(
        true,
        'deleted',
        `Max-Age=${parsed.maxAge}（≤0）要求删除 ${parsed.name}，但罐中不存在 domain=${domain}、path=${cookiePath} 的同名项，无可删除`,
        notices,
      );
    }

    // ---- 5. 计算过期时间（合法的正 Max-Age）----
    let expiresAt: number | undefined;
    if (parsed.maxAge !== undefined && parsed.maxAge > 0) {
      expiresAt = Math.min(now + parsed.maxAge * 1000, MAX_SAFE_EXPIRES);
    }

    // ---- 6. 入罐或更新（同名同域同路径覆盖，沿用首次创建序号）----
    if (existing) {
      existing.value = parsed.value;
      existing.hostOnly = hostOnly;
      existing.secure = parsed.secure;
      existing.httpOnly = parsed.httpOnly;
      existing.expiresAt = expiresAt;
      existing.updatedAt = now;
      const view = this.toView(existing, now);
      return {
        ok: true,
        action: 'updated',
        reason: `同名同域同路径的 ${parsed.name} 已存在（#${existing.creationIndex}），覆盖更新（value/属性以新 Set-Cookie 为准，创建顺序沿用）`,
        inheritedIndex: existing.creationIndex,
        notices,
        cookie: view,
        jar: this.views(now),
      };
    }

    const stored: StoredCookie = {
      name: parsed.name,
      value: parsed.value,
      domain,
      path: cookiePath,
      hostOnly,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      expiresAt,
      creationIndex: this.nextIndex,
      createdAt: now,
      updatedAt: now,
    };
    this.nextIndex += 1;
    this.cookies.push(stored);

    const scopeText = hostOnly
      ? `host-only：仅向主机 ${domain} 发送`
      : `domain：向 ${domain} 及其所有子域（例如 a.${domain}）发送`;
    const lifeText =
      expiresAt === undefined
        ? '会话 cookie（本工具中不过期，重置即清空）'
        : `Max-Age=${parsed.maxAge}s，将于 ${formatTime(expiresAt)} 过期`;
    return this.result(
      true,
      'stored',
      `已入罐：${parsed.name}=${parsed.value}；${scopeText}；Path=${cookiePath}；${lifeText}`,
      notices,
      parsed,
      stored,
    );
  }

  /**
   * 对请求 URL 演算 Cookie 头。
   * 逐项给出 send / exclude 及原因；发送项按 Path 长度降序、首次创建顺序升序排列。
   */
  send(requestUrl: string, now: number = Date.now()): SendResult {
    const urlInfo = hostFromUrl(requestUrl);
    if (!urlInfo) {
      return {
        ok: false,
        error: `请求 URL 非法或非 http(s)：${requestUrl}`,
        requestUrl,
        host: '',
        path: '',
        secureRequest: false,
        cookieHeader: '',
        sent: [],
        excluded: [],
      };
    }

    const { host, protocol, path } = urlInfo;
    const secureRequest = protocol === 'https:';

    const sent: RequestItem[] = [];
    const excluded: RequestItem[] = [];

    for (const c of this.cookies) {
      const expired = c.expiresAt !== undefined && c.expiresAt <= now;
      const base: RequestItem = {
        index: c.creationIndex,
        cookie: `${c.name}=${c.value}`,
        name: c.name,
        value: c.value,
        domain: c.domain,
        hostOnly: c.hostOnly,
        path: c.path,
        secure: c.secure,
        verdict: 'exclude',
        detail: '',
        expired,
      };

      // 按 RFC 6265 的顺序逐项检查
      if (expired) {
        base.detail = `已过期（${formatTime(c.expiresAt as number)}），不发送`;
        excluded.push(base);
        continue;
      }
      if (!domainMatch(host, c)) {
        base.detail = c.hostOnly
          ? `host-only cookie 仅匹配原主机 ${c.domain}，请求主机 ${host} 不相等`
          : `Domain cookie 匹配域 ${c.domain} 及其子域，请求主机 ${host} 不属于该范围`;
        excluded.push(base);
        continue;
      }
      if (!pathMatch(path, c.path)) {
        base.detail = `Path 不匹配：cookie-path="${c.path}"，request-path="${path}"（需相等，或以其开头且边界为 "/"）`;
        excluded.push(base);
        continue;
      }
      if (c.secure && !secureRequest) {
        base.detail = `Secure cookie 仅经 https 发送，请求为明文 ${protocol}//`;
        excluded.push(base);
        continue;
      }

      base.verdict = 'send';
      const hostWay = c.hostOnly ? '主机精确相等' : `主机 ${host} 命中域 ${c.domain}`;
      base.detail = `匹配通过：${hostWay}；request-path "${path}" 命中 cookie-path "${c.path}"` +
        (c.secure ? '；https 满足 Secure' : '');
      sent.push(base);
    }

    // 排序：Path 长度降序；相等时首次创建顺序升序
    sent.sort((a, b) => {
      if (b.path.length !== a.path.length) return b.path.length - a.path.length;
      return a.index - b.index;
    });

    const cookieHeader = sent.map((i) => i.cookie).join('; ');

    // 排除列表保持创建顺序，便于对照
    excluded.sort((a, b) => a.index - b.index);

    return {
      ok: true,
      requestUrl,
      host,
      path,
      secureRequest,
      cookieHeader,
      sent,
      excluded,
    };
  }

  /** 当前罐内容（会话/未过期状态如实展示，不过滤过期项） */
  list(now: number = Date.now()): CookieView[] {
    return this.views(now);
  }

  reset(): void {
    this.cookies = [];
    this.nextIndex = 1;
  }

  // ---------------- 内部辅助 ----------------

  private findCookie(name: string, domain: string, path: string): StoredCookie | undefined {
    return this.cookies.find((c) => c.name === name && c.domain === domain && c.path === path);
  }

  private toView(c: StoredCookie, now: number): CookieView {
    const expired = c.expiresAt !== undefined && c.expiresAt <= now;
    return {
      index: c.creationIndex,
      name: c.name,
      value: c.value,
      domain: c.domain,
      hostOnly: c.hostOnly,
      scope: c.hostOnly ? 'host-only' : `domain（含 *.${c.domain}）`,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      persistent: c.expiresAt !== undefined,
      expiresAt: c.expiresAt === undefined ? null : formatTime(c.expiresAt),
      remaining: c.expiresAt === undefined ? null : expired ? '已过期' : formatRemaining(c.expiresAt, now),
      expired,
      createdAt: formatTime(c.createdAt),
      updatedAt: formatTime(c.updatedAt),
    };
  }

  private views(now: number): CookieView[] {
    return [...this.cookies]
      .sort((a, b) => a.creationIndex - b.creationIndex)
      .map((c) => this.toView(c, now));
  }

  private result(
    ok: boolean,
    action: StoreAction,
    reason: string,
    notices: string[],
    _parsed?: ParsedSetCookie,
    stored?: StoredCookie,
  ): StoreResult {
    return {
      ok,
      action,
      reason,
      notices,
      cookie: stored ? this.toView(stored, Date.now()) : null,
      jar: this.views(Date.now()),
    };
  }
}
