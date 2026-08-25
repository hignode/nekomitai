/**
 * Minimal outbound HTTP client for the Gateway's *API* calls — OAuth token
 * exchange, Spotify Web API, SoundCloud's widget API.
 *
 * Why this is not proxy.ts's fetchTarget: that one is the Web-Mode display
 * path. It is GET-only, follows redirects, and — deliberately — attaches the
 * cookie jar. None of that belongs on an API call carrying a bearer token, and
 * two of them (cookies, redirects) would be actively wrong there.
 *
 * What IS shared is the TLS quirk: CEP's bundled Node often ships without a
 * working root-CA store, so ordinary https fails to verify. The first cert
 * error flips a process-wide flag and everything after it skips straight to
 * the unverified path. That flag lives here now so the proxy and the API
 * client agree about it instead of each discovering it separately.
 */
import { http, https } from "../cep/node";

const CERT_ERRS = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
  "UNABLE_TO_GET_ISSUER_CERT",
]);

let tlsInsecure = false;

export const isCertError = (e: NodeJS.ErrnoException): boolean =>
  CERT_ERRS.has(String(e.code));
export const isTlsInsecure = (): boolean => tlsInsecure;
export const markTlsInsecure = (): void => {
  tlsInsecure = true;
};

export type ApiResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export type ApiRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  /** Already-encoded body (JSON string or form-urlencoded). */
  body?: string;
  timeoutMs?: number;
};

/**
 * One request, no redirect following, no cookies. Resolves on any HTTP status
 * — callers branch on `status` (Spotify uses 204/401/403/404 as control flow,
 * so treating non-2xx as a rejection would just mean unwrapping it again).
 */
export const apiRequest = (
  target: string,
  init: ApiRequestInit = {},
  insecure = tlsInsecure
): Promise<ApiResponse> =>
  new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      return reject(new Error("Bad URL: " + target));
    }
    const mod = u.protocol === "http:" ? http : https;
    const body = init.body;
    // Explicit options, never a URL object: CEP's panel-realm URL is a
    // different class than Node's and request() misparses it.
    const opts: any = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: (u.pathname || "/") + (u.search || ""),
      method: init.method || "GET",
      rejectUnauthorized: !insecure,
      headers: {
        Accept: "application/json",
        ...(init.headers || {}),
        ...(body !== undefined
          ? { "Content-Length": String(Buffer.byteLength(body)) }
          : {}),
      },
    };
    const req = mod.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
      res.on("error", reject);
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      // First cert failure on this machine: remember it, retry unverified.
      if (!insecure && isCertError(e)) {
        markTlsInsecure();
        apiRequest(target, init, true).then(resolve, reject);
        return;
      }
      reject(e);
    });
    req.setTimeout(init.timeoutMs ?? 15000, () => {
      req.destroy(new Error("Request timed out"));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });

/** apiRequest + JSON.parse. `json` is null for empty bodies (Spotify answers
 * 204 No Content for "nothing is playing" and for most player commands). */
export const apiJson = async (
  target: string,
  init: ApiRequestInit = {}
): Promise<{ status: number; json: any }> => {
  const res = await apiRequest(target, init);
  let json: any = null;
  if (res.body) {
    try {
      json = JSON.parse(res.body);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
};
