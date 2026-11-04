// Sign in with LinkedIn (OpenID Connect), signed session cookies, and the owner's approval flow.
//
//   GET  /auth/linkedin       start sign-in (redirect to LinkedIn, with a state cookie against CSRF)
//   GET  /auth/callback       LinkedIn redirects back: exchange the code, read the profile, set the session
//   POST /auth/logout         clear the session
//   GET  /api/me              { loginEnabled, tier, user }
//   POST /api/access-request  a signed-in member asks for recruiter access { company, role, note? }
//   GET  /api/admin/users     owner only: every signed-in user and their status
//   POST /api/admin/decide    owner only: { sub, decision: "approve" | "reject" | "revoke" }
//
// LinkedIn's OpenID Connect profile has name, email and photo, but no job title, so nobody becomes
// a recruiter by signing in: the owner approves each request. The tier is re-read from KV on every
// request, so revoking access takes effect within KV's propagation time, not when a cookie expires.
//
// Env: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET (secret), SESSION_SECRET (secret, 32+ chars),
//      OWNER_EMAILS (comma-separated; must match LinkedIn's verified email), RATE_KV.
//      Optional LINKEDIN_REDIRECT_URI (default <origin>/auth/callback; must match the LinkedIn app).

import { sameToken } from "./feedback.js";
import { cleanInput } from "./inject.js";

export const LINKEDIN_AUTHORIZE = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_USERINFO = "https://api.linkedin.com/v2/userinfo";
export const SESSION_COOKIE = "sid";
const STATE_COOKIE = "li_state";
export const SESSION_DAYS = 7;
const USER_PREFIX = "user:";
const FIELD_MAX = 80;
const NOTE_MAX = 300;

export function loginEnabled(env) {
  return Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.RATE_KV &&
    typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= 32);
}

// ---- signed session cookie ----------------------------------------------------------------

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function sessionSig(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode("session:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text))));
}

// user: { sub, email, name, picture, email_verified }. Returns the cookie value.
export async function signSession(env, user, now = Date.now()) {
  const payload = { s: user.sub, e: user.email || "", n: user.name || "", p: user.picture || "",
    v: user.email_verified === true, x: Math.floor(now / 1000) + SESSION_DAYS * 86400 };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return body + "." + (await sessionSig(env.SESSION_SECRET, body));
}

// Returns { sub, email, name, picture, email_verified } or null for a missing, forged or expired cookie.
export async function readSession(request, env, now = Date.now()) {
  const value = cookieOf(request, SESSION_COOKIE);
  if (!value || !env.SESSION_SECRET) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig || !sameToken(sig, await sessionSig(env.SESSION_SECRET, body))) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(fromB64url(body))); } catch { return null; }
  if (!p || typeof p.s !== "string" || !p.s || !(p.x > now / 1000)) return null;
  return { sub: p.s, email: p.e, name: p.n, picture: p.p, email_verified: p.v === true };
}

export function cookieOf(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function cookie(name, value, { maxAge, path = "/" } = {}) {
  return `${name}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// ---- who is asking --------------------------------------------------------------------------

function isOwner(env, s) {
  const owners = String(env.OWNER_EMAILS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  return s.email_verified && owners.includes(String(s.email || "").toLowerCase());
}

async function userRecord(env, sub) {
  try { return await env.RATE_KV.get(USER_PREFIX + sub, "json"); } catch { return null; }
}

// { tier, user, loginEnabled }. user is the session plus the stored status, or null.
export async function getViewer(request, env) {
  const enabled = loginEnabled(env);
  if (!enabled) return { tier: "public", user: null, loginEnabled: false };
  const s = await readSession(request, env);
  if (!s) return { tier: "public", user: null, loginEnabled: true };
  if (isOwner(env, s)) return { tier: "owner", user: { ...s, status: "owner" }, loginEnabled: true };
  const rec = await userRecord(env, s.sub);
  const status = (rec && rec.status) || "none";
  return { tier: status === "approved" ? "recruiter" : "member", user: { ...s, status }, loginEnabled: true };
}

// ---- routes ---------------------------------------------------------------------------------

// Browsers drop Set-Cookie from Responses built in page scripts, so the cookies are also kept on
// res.cookies for the browser test page. The Worker runtime sends the real headers.
function withCookies(res, cookies) {
  for (const c of cookies) res.headers.append("set-cookie", c);
  res.cookies = cookies;
  return res;
}

function authJson(status, data, cookies = []) {
  return withCookies(new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }), cookies);
}

function redirect(location, cookies = []) {
  return withCookies(new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } }), cookies);
}

function authSameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function redirectUri(env, url) {
  return env.LINKEDIN_REDIRECT_URI || url.origin + "/auth/callback";
}

// Handles the auth and admin routes; returns null for any other path. limit(request) applies the
// per-IP rate limit (src/worker.js) to the writes a visitor can trigger.
export async function handleAuth(request, env, url, fetchImpl, limit = async () => true) {
  const path = url.pathname;
  if (path === "/api/me") {
    if (request.method !== "GET") return authJson(405, { error: "method_not_allowed" });
    const v = await getViewer(request, env);
    const user = v.user && { name: v.user.name, email: v.user.email, picture: v.user.picture, status: v.user.status };
    return authJson(200, { loginEnabled: v.loginEnabled, tier: v.tier, user: user || null });
  }
  if (path === "/auth/linkedin") return start(env, url);
  if (path === "/auth/callback") return callback(request, env, url, fetchImpl);
  if (path === "/auth/logout") {
    if (request.method !== "POST") return authJson(405, { error: "method_not_allowed" });
    if (!authSameOrigin(request)) return authJson(403, { error: "forbidden" });
    return authJson(200, { ok: true }, [cookie(SESSION_COOKIE, "", { maxAge: 0 })]);
  }
  if (path === "/api/access-request") return accessRequest(request, env, limit);
  if (path === "/api/admin/users") return adminUsers(request, env);
  if (path === "/api/admin/decide") return adminDecide(request, env);
  return null;
}

function start(env, url) {
  if (!loginEnabled(env)) return authJson(404, { error: "login_not_configured" });
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const q = new URLSearchParams({ response_type: "code", client_id: env.LINKEDIN_CLIENT_ID,
    redirect_uri: redirectUri(env, url), state, scope: "openid profile email" });
  return redirect(`${LINKEDIN_AUTHORIZE}?${q}`, [cookie(STATE_COOKIE, state, { maxAge: 600, path: "/auth" })]);
}

async function callback(request, env, url, fetchImpl) {
  if (!loginEnabled(env)) return authJson(404, { error: "login_not_configured" });
  const clearState = cookie(STATE_COOKIE, "", { maxAge: 0, path: "/auth" });
  const state = url.searchParams.get("state") || "";
  const expected = cookieOf(request, STATE_COOKIE) || "";
  if (url.searchParams.get("error")) return redirect("/?login=cancelled", [clearState]);
  if (!state || !sameToken(state, expected)) return redirect("/?login=failed", [clearState]);
  const code = url.searchParams.get("code");
  if (!code) return redirect("/?login=failed", [clearState]);
  let profile;
  try {
    const tok = await fetchImpl(LINKEDIN_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(env, url),
        client_id: env.LINKEDIN_CLIENT_ID, client_secret: env.LINKEDIN_CLIENT_SECRET }).toString(),
    });
    if (!tok.ok) throw new Error("token " + tok.status);
    const { access_token } = await tok.json();
    const me = await fetchImpl(LINKEDIN_USERINFO, { headers: { authorization: "Bearer " + access_token } });
    if (!me.ok) throw new Error("userinfo " + me.status);
    profile = await me.json();
  } catch (err) {
    console.warn("linkedin sign-in failed:", err && err.message);
    return redirect("/?login=failed", [clearState]);
  }
  if (!profile || typeof profile.sub !== "string" || !profile.sub) return redirect("/?login=failed", [clearState]);
  const user = { sub: profile.sub, email: String(profile.email || "").slice(0, 200), name: String(profile.name || "").slice(0, 120),
    picture: String(profile.picture || "").slice(0, 500), email_verified: profile.email_verified === true };
  const rec = (await userRecord(env, user.sub)) || { status: "none", first_seen: new Date().toISOString() };
  try {
    await env.RATE_KV.put(USER_PREFIX + user.sub, JSON.stringify({ ...rec, sub: user.sub, name: user.name, email: user.email,
      email_verified: user.email_verified, last_seen: new Date().toISOString() }));
  } catch (err) {
    console.warn("user record not stored:", err && err.message);
  }
  return redirect("/?login=ok", [clearState, cookie(SESSION_COOKIE, await signSession(env, user), { maxAge: SESSION_DAYS * 86400 })]);
}

const field = (v, n) => (typeof v === "string" ? cleanInput(v).slice(0, n) : "");

async function accessRequest(request, env, limit) {
  if (request.method !== "POST") return authJson(405, { error: "method_not_allowed" });
  if (!authSameOrigin(request)) return authJson(403, { error: "forbidden" });
  const v = await getViewer(request, env);
  if (!v.user) return authJson(401, { error: "sign_in_required" });
  if (v.tier === "owner" || v.tier === "recruiter") return authJson(200, { ok: true, status: v.user.status });
  let body;
  try { body = await request.json(); } catch { return authJson(400, { error: "bad_json" }); }
  const company = field(body && body.company, FIELD_MAX), role = field(body && body.role, FIELD_MAX), note = field(body && body.note, NOTE_MAX);
  if (company.length < 2 || role.length < 2) return authJson(400, { error: "company_and_role_required" });
  if (!(await limit(request))) return authJson(429, { error: "rate_limited" });
  const rec = (await userRecord(env, v.user.sub)) || {};
  try {
    await env.RATE_KV.put(USER_PREFIX + v.user.sub, JSON.stringify({ ...rec, sub: v.user.sub, name: v.user.name, email: v.user.email,
      email_verified: v.user.email_verified, status: "pending", company, role, note, requested: new Date().toISOString() }));
  } catch (err) {
    console.warn("access request not stored:", err && err.message);
    return authJson(503, { error: "storage" });
  }
  console.log(JSON.stringify({ event: "access_request" }));
  return authJson(200, { ok: true, status: "pending" });
}

async function requireOwner(request, env) {
  const v = await getViewer(request, env);
  return v.tier === "owner" ? null : authJson(v.user ? 403 : 401, { error: v.user ? "forbidden" : "sign_in_required" });
}

async function adminUsers(request, env) {
  if (request.method !== "GET") return authJson(405, { error: "method_not_allowed" });
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  const names = [];
  let cursor;
  do {
    const page = await env.RATE_KV.list({ prefix: USER_PREFIX, cursor });
    names.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const order = { pending: 0, approved: 1, none: 2, rejected: 3, revoked: 4 };
  const users = (await Promise.all(names.map((n) => env.RATE_KV.get(n, "json").catch(() => null)))).filter(Boolean)
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || String(b.requested || b.last_seen || "").localeCompare(String(a.requested || a.last_seen || "")));
  return authJson(200, { count: users.length, users });
}

const DECISIONS = { approve: "approved", reject: "rejected", revoke: "revoked" };

async function adminDecide(request, env) {
  if (request.method !== "POST") return authJson(405, { error: "method_not_allowed" });
  if (!authSameOrigin(request)) return authJson(403, { error: "forbidden" });
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch { return authJson(400, { error: "bad_json" }); }
  const status = DECISIONS[body && body.decision];
  const sub = typeof (body && body.sub) === "string" ? body.sub : "";
  if (!status || !sub) return authJson(400, { error: "bad_decision" });
  const rec = await userRecord(env, sub);
  if (!rec) return authJson(404, { error: "unknown_user" });
  await env.RATE_KV.put(USER_PREFIX + sub, JSON.stringify({ ...rec, status, decided: new Date().toISOString() }));
  console.log(JSON.stringify({ event: "access_decision", status }));
  return authJson(200, { ok: true, status });
}
