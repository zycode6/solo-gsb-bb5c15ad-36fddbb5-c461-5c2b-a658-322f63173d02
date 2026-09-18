/**
 * Cookie 罐核心演算（RFC 6265 语义）
 *
 * 支持的 Set-Cookie 属性：Domain、Path、Max-Age、Secure。
 * 存储键：name + domain + path；同名同域同路径的新条目覆盖旧条目，
 * 但保留首次进入罐中的创建序号（creation order 永远不变）。
 */

export interface ParsedSetCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  maxAge?: number;
  secure: boolean;
}

export type ParseErrorCode =
  | 'EMPTY_SET_COOKIE'
  | 'MISSING_NAME_VALUE'
  | 'INVALID_MAX_AGE';

export type StoreCode =
  | 'INVALID_URL'
  | 'PARSE_ERROR'
  | 'DOMAIN_MISMATCH'
  | 'STORED'
  | 'REPLACED'
  | 'EXPIRED_DELETED'
  | 'SESSION_STORED';

export type DecisionCode =
  | 'SENT'
  | 'EXPIRED'
  | 'DOMAIN_NO_MATCH'
  | 'PATH_NO_MATCH'
  | 'SECURE_ONLY';

export interface StoredCookie {
  name: string;
  value: string;
  /** 规范后的小写域，不带前导点 */
  domain: string;
  /** 标识该条目是否仅匹配原主机（无 Domain 属性） */
  hostOnly: boolean;
  /** 原始响应主机 */
  host: string;
  path: string;
  /** 绝对过期时间（ms epoch）；session cookie 为 undefined */
  expiresAt?: number;
  secure: boolean;
  /** 首次创建序号（从 1 开始，替换不改变） */
  seq: number;
  /** 首次进入罐中的时间 */
  createdAt: number;
  /** 最近一次 Set-Cookie 更新时间 */
  updatedAt: number;
}

export interface CookieView {
  id: number;
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  host: string;
  path: string;
  secure: boolean;
  session: boolean;
  expiresAt: number | null;
  expired: boolean;
  createdAt: number;
}

export interface StoreResponse {
  ok: boolean;
  status: StoreCode | ParseErrorCode;
  reason: string;
  responseHost?: string;
  parsed?: {
    name: string;
    value: string;
    domain: string | null;
    path: string | null;
    maxAge: number | null;
    secure: boolean;
  };
  cookie: CookieView | null;
  jar: CookieView[];
}

export interface CookieDecision {
  code: DecisionCode;
  sent: boolean;
  reason: string;
  cookie: CookieView;
}

export interface RequestResponse {
  ok: boolean;
  reason?: string;
  requestUrl?: string;
  host?: string;
  path?: string;
  isSecure?: boolean;
  cookieHeader: string;
  sent: CookieDecision[];
  excluded: CookieDecision[];
  jar: CookieView[];
}

const MAX_AGE_RE = /^-?\d+$/;

/**
 * 解析单条 Set-Cookie 头部：name=value; Attr; ...
 * 属性名大小写不敏感；只处理 Domain/Path/Max-Age/Secure，其余忽略。
 */
export function parseSetCookie(raw: string):
  | { ok: true; cookie: ParsedSetCookie }
  | { ok: false; code: ParseErrorCode; reason: string } {
  const text = (raw ?? '').trim();
  if (!text) {
    return { ok: false, code: 'EMPTY_SET_COOKIE', reason: 'Set-Cookie 不能为空' };
  }

  const segments = text.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  const first = segments.shift() as string;
  const eq = first.indexOf('=');
  if (eq <= 0) {
    return {
      ok: false,
      code: 'MISSING_NAME_VALUE',
      reason: 'Set-Cookie 必须以 name=value 开头，且名称不能为空',
    };
  }

  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();

  const parsed: ParsedSetCookie = { name, value, secure: false };

  for (const segment of segments) {
    const idx = segment.indexOf('=');
    const attrName = (idx === -1 ? segment : segment.slice(0, idx)).trim().toLowerCase();
    const attrValue = idx === -1 ? '' : segment.slice(idx + 1).trim();

    switch (attrName) {
      case 'domain': {
        // RFC 6265 5.3.6：去除前导点
        if (attrValue) parsed.domain = attrValue.replace(/^\.+/, '').toLowerCase();
        break;
      }
      case 'path': {
        // RFC 6265 5.3.6：非空且以 "/" 开头即采用（含 Path=/），否则忽略该属性
        if (attrValue.startsWith('/')) {
          parsed.path = attrValue;
        }
        break;
      }
      case 'max-age': {
        if (!MAX_AGE_RE.test(attrValue)) {
          return {
            ok: false,
            code: 'INVALID_MAX_AGE',
            reason: `Max-Age 必须是非空整数，收到 "${attrValue}"`,
          };
        }
        parsed.maxAge = Number(attrValue);
        break;
      }
      case 'secure':
        parsed.secure = true;
        break;
      // Expires / HttpOnly / SameSite 等不在本工具演算范围内，忽略
      default:
        break;
    }
  }

  return { ok: true, cookie: parsed };
}

/**
 * RFC 6265 5.1.4 默认 Path 算法：
 * 1. URI path 为空或以非 "/" 开头 -> "/"
 * 2. 以 "/" 开头但只有一个 "/" -> "/"
 * 3. 取最后一个 "/" 之前（不含）的部分
 */
export function defaultPath(urlPath: string): string {
  if (!urlPath || urlPath[0] !== '/') return '/';
  const lastSlash = urlPath.lastIndexOf('/');
  if (lastSlash === 0) return '/';
  return urlPath.slice(0, lastSlash);
}

/** 仅接受 http/https 且存在主机名的 URL */
export function parseHttpUrl(raw: string): { url: URL } | { reason: string } {
  if (!raw || !raw.trim()) return { reason: 'URL 不能为空' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { reason: `URL 无法解析：${raw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { reason: `仅支持 http/https 协议，收到 ${url.protocol}` };
  }
  if (!url.hostname) {
    return { reason: 'URL 缺少主机名' };
  }
  return { url };
}

/** 去掉 IPv6 字面量的方括号；主机名统一小写 */
function canonicalHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * RFC 6265 5.1.3 域匹配：
 * - cookie 域与请求主机完全相同；或
 * - 请求主机以 cookie 域结尾，且前一字符为 "."
 */
export function domainMatches(cookieDomain: string, requestHost: string): boolean {
  if (requestHost === cookieDomain) return true;
  return (
    requestHost.endsWith(cookieDomain) &&
    requestHost.length > cookieDomain.length &&
    requestHost[requestHost.length - cookieDomain.length - 1] === '.'
  );
}

/**
 * RFC 6265 5.1.4 路径匹配：
 * path 相等；或 requestPath 以 path 开头，并且
 * path 以 "/" 结尾，或下一个边界字符为 "/"。
 */
export function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith('/')) return true;
  return requestPath[cookiePath.length] === '/';
}

export class CookieJar {
  private cookies: StoredCookie[] = [];
  private seqCounter = 0;

  reset(): void {
    this.cookies = [];
    this.seqCounter = 0;
  }

  list(now: number): CookieView[] {
    return this.cookies.map((c) => this.view(c, now));
  }

  /**
   * 处理一条 Set-Cookie（响应阶段）。
   */
  store(responseUrl: string, setCookie: string, now: number): StoreResponse {
    const parsedUrl = parseHttpUrl(responseUrl);
    if ('reason' in parsedUrl) {
      return this.storeRejected('INVALID_URL', parsedUrl.reason);
    }
    const host = canonicalHost(parsedUrl.url.hostname);

    const parseResult = parseSetCookie(setCookie);
    if (!parseResult.ok) {
      return this.storeRejected(parseResult.code, parseResult.reason, host);
    }
    const p = parseResult.cookie;

    // 域校验：Domain 必须等于响应主机或是其上级域
    let domain: string;
    let hostOnly: boolean;
    if (p.domain !== undefined) {
      if (!domainMatches(p.domain, host)) {
        return this.storeRejected(
          'DOMAIN_MISMATCH',
          `拒绝入罐：Domain="${p.domain}" 与响应主机 "${host}" 不匹配（既不相等，也不是其上级域）`,
          host,
          p,
        );
      }
      domain = p.domain;
      hostOnly = false;
    } else {
      domain = host;
      hostOnly = true;
    }

    // Path 缺省：响应 URL 最后一个斜杠之前的目录
    const path = p.path ?? defaultPath(parsedUrl.url.pathname);
    const existing = this.findCookie(p.name, domain, path);

    // Max-Age <= 0：删除同名、同域、同路径项
    if (p.maxAge !== undefined && p.maxAge <= 0) {
      if (existing) {
        this.cookies = this.cookies.filter((c) => c !== existing);
      }
      return {
        ok: true,
        status: 'EXPIRED_DELETED',
        reason: existing
          ? `Max-Age=${p.maxAge} ≤ 0：已删除同名同域同路径的 "${p.name}"`
          : `Max-Age=${p.maxAge} ≤ 0：罐中本就没有同名同域同路径的 "${p.name}"，无需删除`,
        responseHost: host,
        parsed: this.parsedView(p),
        cookie: null,
        jar: this.list(now),
      };
    }

    const expiresAt = p.maxAge !== undefined ? now + p.maxAge * 1000 : undefined;

    if (existing) {
      existing.value = p.value;
      existing.expiresAt = expiresAt;
      existing.secure = p.secure;
      existing.updatedAt = now;
      return {
        ok: true,
        status: 'REPLACED',
        reason: `已更新 "${p.name}"：同名同域同路径项被覆盖，保留首次创建顺序 #${existing.seq}`,
        responseHost: host,
        parsed: this.parsedView(p),
        cookie: this.view(existing, now),
        jar: this.list(now),
      };
    }

    const stored: StoredCookie = {
      name: p.name,
      value: p.value,
      domain,
      hostOnly,
      host,
      path,
      expiresAt,
      secure: p.secure,
      seq: ++this.seqCounter,
      createdAt: now,
      updatedAt: now,
    };
    this.cookies.push(stored);

    return {
      ok: true,
      status: expiresAt ? 'STORED' : 'SESSION_STORED',
      reason: expiresAt
        ? `已入罐："${p.name}" 写入 ${domain}${path}，${p.maxAge} 秒后过期（${new Date(expiresAt).toLocaleString()}）`
        : `已入罐："${p.name}" 写入 ${domain}${path}，为会话期 Cookie（浏览器关闭即失效）`,
      responseHost: host,
      parsed: this.parsedView(p),
      cookie: this.view(stored, now),
      jar: this.list(now),
    };
  }

  /**
   * 请求阶段：逐项判定，给出发送/排除原因，并生成 Cookie 头。
   * 排序：Path 长度降序，Path 长度相同按首次创建顺序升序。
   */
  evaluate(requestUrl: string, now: number): RequestResponse {
    const parsedUrl = parseHttpUrl(requestUrl);
    if ('reason' in parsedUrl) {
      return {
        ok: false,
        reason: parsedUrl.reason,
        cookieHeader: '',
        sent: [],
        excluded: [],
        jar: this.list(now),
      };
    }
    const host = canonicalHost(parsedUrl.url.hostname);
    const reqPath = parsedUrl.url.pathname || '/';
    const isSecure = parsedUrl.url.protocol === 'https:';

    const decisions: CookieDecision[] = [];
    const sent: StoredCookie[] = [];

    for (const c of this.cookies) {
      let code: DecisionCode = 'DOMAIN_NO_MATCH';
      let sentFlag = false;
      let reason = '';

      if (c.expiresAt !== undefined && c.expiresAt <= now) {
        code = 'EXPIRED';
        sentFlag = false;
        reason = `已过期（${new Date(c.expiresAt).toLocaleString()}），不发送`;
      } else if (c.hostOnly) {
        if (c.domain !== host) {
          code = 'DOMAIN_NO_MATCH';
          sentFlag = false;
          reason = `host-only：仅匹配原主机 "${c.domain}"，请求主机为 "${host}"`;
        } else if (!pathMatches(c.path, reqPath)) {
          code = 'PATH_NO_MATCH';
          sentFlag = false;
          reason = `主机匹配但路径不匹配：cookie-path="${c.path}"，request-path="${reqPath}"（须相等，或以其开头且下一边界为 /）`;
        } else if (c.secure && !isSecure) {
          code = 'SECURE_ONLY';
          sentFlag = false;
          reason = 'Secure Cookie 只能通过 HTTPS 发送，当前请求为 http';
        } else {
          code = 'SENT';
          sentFlag = true;
          reason = `未过期；host-only 主机 "${host}" 精确匹配；路径 "${c.path}" 匹配；${
            c.secure ? 'HTTPS 满足 Secure' : '非 Secure'
          }`;
        }
      } else {
        if (!domainMatches(c.domain, host)) {
          code = 'DOMAIN_NO_MATCH';
          sentFlag = false;
          reason = `Domain="${c.domain}" 不覆盖请求主机 "${host}"（须相等或为其子域）`;
        } else if (!pathMatches(c.path, reqPath)) {
          code = 'PATH_NO_MATCH';
          sentFlag = false;
          reason = `域匹配但路径不匹配：cookie-path="${c.path}"，request-path="${reqPath}"（须相等，或以其开头且下一边界为 /）`;
        } else if (c.secure && !isSecure) {
          code = 'SECURE_ONLY';
          sentFlag = false;
          reason = 'Secure Cookie 只能通过 HTTPS 发送，当前请求为 http';
        } else {
          code = 'SENT';
          sentFlag = true;
          const hostDesc = host === c.domain ? '域精确匹配' : `子域 "${host}" 匹配 Domain="${c.domain}"`;
          reason = `未过期；${hostDesc}；路径 "${c.path}" 匹配；${
            c.secure ? 'HTTPS 满足 Secure' : '非 Secure'
          }`;
        }
      }

      const view = this.view(c, now);
      decisions.push({ code, sent: sentFlag, reason, cookie: view });
      if (sentFlag) sent.push(c);
    }

    sent.sort((a, b) => {
      const lenDiff = b.path.length - a.path.length;
      if (lenDiff !== 0) return lenDiff;
      return a.seq - b.seq;
    });

    const cookieHeader = sent.map((c) => `${c.name}=${c.value}`).join('; ');
    const decisionsBySeq = new Map(decisions.map((d) => [d.cookie.id, d]));
    const sentDecisions = sent.map((c) => decisionsBySeq.get(c.seq) as CookieDecision);

    return {
      ok: true,
      requestUrl,
      host,
      path: reqPath,
      isSecure,
      cookieHeader,
      sent: sentDecisions,
      excluded: decisions.filter((d) => !d.sent),
      jar: this.list(now),
    };
  }

  private findCookie(name: string, domain: string, path: string): StoredCookie | undefined {
    return this.cookies.find(
      (c) => c.name === name && c.domain === domain && c.path === path,
    );
  }

  private parsedView(p: ParsedSetCookie) {
    return {
      name: p.name,
      value: p.value,
      domain: p.domain ?? null,
      path: p.path ?? null,
      maxAge: p.maxAge ?? null,
      secure: p.secure,
    };
  }

  private view(c: StoredCookie, now: number): CookieView {
    const expired = c.expiresAt !== undefined && c.expiresAt <= now;
    return {
      id: c.seq,
      name: c.name,
      value: c.value,
      domain: c.domain,
      hostOnly: c.hostOnly,
      host: c.host,
      path: c.path,
      secure: c.secure,
      session: c.expiresAt === undefined,
      expiresAt: c.expiresAt ?? null,
      expired,
      createdAt: c.createdAt,
    };
  }

  private storeRejected(
    status: StoreCode | ParseErrorCode,
    reason: string,
    host?: string,
    parsed?: ParsedSetCookie,
  ): StoreResponse {
    return {
      ok: false,
      status,
      reason,
      responseHost: host,
      parsed: parsed ? this.parsedView(parsed) : undefined,
      cookie: null,
      jar: this.list(Date.now()),
    };
  }
}
