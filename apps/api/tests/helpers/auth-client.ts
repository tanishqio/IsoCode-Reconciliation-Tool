// A tiny HTTP client for tests: keeps no state, so each test passes the cookie and CSRF token itself.
export interface CallOptions {
  cookie?: string;
  csrf?: string;
  json?: unknown;
  form?: FormData;
}

export interface CallResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  headers: Headers;
  /** Every Set-Cookie header, unchanged. */
  setCookies: string[];
  /** The "name=value" part of the session cookie, ready to send back. Undefined if none was set. */
  sessionCookie: string | undefined;
}

/** JSON if it is JSON, the plain text if not, null if empty. */
function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function call(
  baseUrl: string,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (options.cookie) headers["cookie"] = options.cookie;
  if (options.csrf) headers["x-csrf-token"] = options.csrf;
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form) {
    body = options.form;
  }

  const res = await fetch(`${baseUrl}${path}`, { method, headers, body });
  const text = await res.text();
  const data = parseBody(text);
  const setCookies = res.headers.getSetCookie();
  const sessionCookie = setCookies
    .map((value) => value.split(";")[0] ?? "")
    .find((pair) => pair.startsWith("sid=") && pair.length > "sid=".length);
  return { status: res.status, data, headers: res.headers, setCookies, sessionCookie };
}

export async function signIn(baseUrl: string, email: string, password: string) {
  const result = await call(baseUrl, "POST", "/api/auth/login", { json: { email, password } });
  return {
    ...result,
    cookie: result.sessionCookie as string,
    csrf: result.data?.csrfToken as string,
  };
}
