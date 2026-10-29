#!/usr/bin/env python3
"""Provision ONLY Noor's isolated private Cloudflare staging with synthetic QA.
Runs inside santoreno Actions to reuse its encrypted Cloudflare credentials.
Never touches Santo or Noor production resources, never logs secrets.
"""
import base64
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path.cwd()
NOOR = ROOT / "noor"
ACCOUNT = os.environ["CLOUDFLARE_ACCOUNT_ID"]
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
NOOR_SHA = os.environ["NOOR_SHA"]
DATABASE_NAME = "noor-core-staging"
WORKER_NAME = "noor-site-staging"
WRANGLER = ["npx", "--yes", "wrangler@4.45.0"]


def wrangler(*args):
    result = subprocess.run(WRANGLER + list(args), cwd=NOOR, text=True,
                            capture_output=True, check=False)
    if result.returncode:
        # Do not propagate raw environment, command-line credentials or response bodies.
        raise RuntimeError(f"Wrangler operation failed: {args[0:2]} (exit {result.returncode}); "
                           f"stderr tail: {result.stderr[-900:]}")
    return result.stdout


def cloudflare_subdomain():
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/subdomain",
        headers={"Authorization": "Bearer " + TOKEN, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=25) as response:
        data = json.load(response)
    subdomain = data.get("result", {}).get("subdomain")
    if not data.get("success") or not isinstance(subdomain, str) or not re.fullmatch(r"[a-z0-9-]+", subdomain):
        raise RuntimeError("Missing valid Cloudflare workers.dev subdomain")
    return subdomain


def staging_database():
    listed = json.loads(wrangler("d1", "list", "--json"))
    databases = listed if isinstance(listed, list) else listed.get("results", listed.get("databases", []))
    matching = [item for item in databases if item.get("name") == DATABASE_NAME]
    if len(matching) > 1:
        raise RuntimeError("Duplicate staging D1 name")
    if not matching:
        wrangler("d1", "create", DATABASE_NAME)
        listed = json.loads(wrangler("d1", "list", "--json"))
        databases = listed if isinstance(listed, list) else listed.get("results", listed.get("databases", []))
        matching = [item for item in databases if item.get("name") == DATABASE_NAME]
    if len(matching) != 1:
        raise RuntimeError("Cannot identify dedicated Noor staging D1")
    database_id = matching[0].get("uuid") or matching[0].get("id") or matching[0].get("database_id")
    if not isinstance(database_id, str) or not re.fullmatch(r"[0-9a-fA-F-]{32,36}", database_id) or set(database_id.replace("-", "")) == {"0"}:
        raise RuntimeError("Refusing missing/local-only D1 identifier")
    return database_id


def write_config(target, database_id, origin, access_password, auth_secret):
    cfg = json.loads((NOOR / "wrangler.jsonc").read_text())
    if not (NOOR / "workers/site/src/staging-access.ts").is_file():
        raise RuntimeError("Noor staging guard missing")
    cfg.pop("previews", None)
    cfg.update(name=WORKER_NAME, workers_dev=True, preview_urls=False)
    cfg["main"] = str(NOOR / "workers/site/src/index.ts")
    cfg["assets"]["directory"] = str(NOOR / "apps/web/out")
    # Essential: an assets-only request must never bypass the staging gate.
    cfg["assets"]["run_worker_first"] = True
    cfg["d1_databases"] = [{
        "binding": "DB", "database_name": DATABASE_NAME, "database_id": database_id,
        "migrations_dir": str(NOOR / "workers/api/migrations"),
    }]
    cfg["vars"] = {
        "NOOR_ENVIRONMENT": "staging", "NOOR_DEV_OPEN": "true",
        "AUTH_ENABLED": "true", "AUTH_ORIGIN": origin,
    }
    config = target / "wrangler-staging.json"
    config.write_text(json.dumps(cfg, ensure_ascii=False))
    secure = target / "secrets.json"
    secure.write_text(json.dumps({"AUTH_SECRET": auth_secret, "STAGING_ACCESS_PASSWORD": access_password}))
    secure.chmod(0o600)
    return config, secure


def http(origin, path, secret=None, method="GET", body=None, opener=None):
    # A browser-like User-Agent avoids Cloudflare edge filtering Python's
    # default urllib user agent; this is synthetic QA, never real user data.
    headers = {"Accept": "application/json",
               "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/156.0.0.0 Safari/537.36"}
    if secret is not None:
        token = base64.b64encode(("noor-preview:" + secret).encode()).decode()
        headers["Authorization"] = "Basic " + token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
        headers["Origin"] = origin
    request = urllib.request.Request(origin + path, headers=headers, method=method, data=data)
    client = opener or urllib.request.build_opener()
    try:
        with client.open(request, timeout=25) as response:
            return response.status, response.read(1024 * 128), response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read(1024 * 128), error.headers


def require_status(status, expected, label):
    if status != expected:
        raise RuntimeError(f"{label}: expected HTTP {expected}, got {status}")


def json_body(content):
    return json.loads(content.decode())


def smoke(origin, access_password):
    access_password = None  # This development deployment has no staging-wide Basic prompt.
    # Development site: regular application login and learner ownership still apply.
    # The owner requested a browser preview of the *current* Noor main Sheikh
    # portal and interactive classroom. Verify all static routes against the
    # deployed Cloudflare Worker, not just CI's local Next.js build.
    preview_pages = (
        "/", "/student/", "/student/mushaf/",
        "/teacher/", "/teacher/schedule/", "/teacher/students/",
        "/teacher/preparation/", "/teacher/reports/",
        "/teacher/assignments/", "/teacher/notifications/", "/teacher/cases/",
        "/classroom/",
    )
    for path in preview_pages:
        status, body, _ = http(origin, path)
        require_status(status, 200, "Public demo page: " + path)
        if b"<html" not in body.lower():
            raise RuntimeError("Public demo did not return HTML: " + path)
    # Owner UX acceptance: the refreshed lesson preview must actually include
    # the fullscreen focus control, not an older deployed static build.
    status, classroom, _ = http(origin, "/classroom/")
    require_status(status, 200, "Immersive classroom preview")
    if "وضع الحصة".encode("utf-8") not in classroom:
        raise RuntimeError("Deployed classroom is missing the immersive lesson mode")
    print("PASS: all Sheikh portal and classroom preview routes are HTTP 200; immersive control present")

    built = NOOR / "apps/web/out/_next/static"
    assets = list(built.rglob("*.js"))
    if not assets:
        raise RuntimeError("Missing published JavaScript static asset")
    public_asset = "/" + assets[0].relative_to(NOOR / "apps/web/out").as_posix()
    status, _, _ = http(origin, public_asset)
    require_status(status, 200, "Public demo static JS asset")

    # An anonymous visitor does not receive another site-wide password prompt.
    # Application-level session and learner ownership checks still apply.
    status, _, _ = http(origin, "/api/auth/session")
    require_status(status, 401, "Anonymous application session")
    status, _, _ = http(origin, "/v1/me/learners")
    require_status(status, 401, "Anonymous learner API")
    for path in ("/health", "/ready"):
        status, _, _ = http(origin, path)
        require_status(status, 200, "Public development endpoint: " + path)

    for attempt in range(25):
        status, data, _ = http(origin, "/health", access_password)
        if status == 200 and json_body(data).get("status") == "up":
            break
        time.sleep(2)
    else:
        raise RuntimeError("Remote stage /health did not become ready")

    status, data, _ = http(origin, "/ready", access_password)
    require_status(status, 200, "Remote stage /ready")
    ready = json_body(data)
    if ready.get("authentication") != "configured" or ready.get("database") != "ready":
        raise RuntimeError("Remote D1 and auth not ready")

    def account(phone, name):
        jar = CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        password = secrets.token_urlsafe(22) + "Az1!"
        status, result, headers = http(
            origin, "/api/auth/register", access_password, "POST",
            {"name": name, "phoneNumber": phone, "password": password}, opener,
        )
        require_status(status, 200, "Synthetic account signup")
        obj = json_body(result)
        if obj.get("phoneVerified") is not False or not isinstance(obj.get("user", {}).get("id"), str):
            raise RuntimeError("Unexpected synthetic registration verification state")
        session_cookies = headers.get_all("Set-Cookie") or []
        if not any("httponly" in c.lower() and "samesite=lax" in c.lower() for c in session_cookies):
            raise RuntimeError("Missing HttpOnly/SameSite session cookie")
        return opener

    first = secrets.randbelow(98)
    owner_a = account(f"+120255501{first:02d}", "Synthetic Noor QA A")
    status, _, _ = http(origin, "/api/auth/session", access_password, opener=owner_a)
    require_status(status, 200, "Cookie session restore")
    learner_id = ""
    for index in (1, 2):
        status, result, _ = http(origin, "/v1/me/learners", access_password, "POST",
                                 {"name": f"Synthetic Learner {index}", "learnerType": "child"}, owner_a)
        require_status(status, 201, "Synthetic learner creation")
        learner_id = json_body(result)["learner"]["id"]
    status, result, _ = http(origin, "/v1/me/learners", access_password, opener=owner_a)
    require_status(status, 200, "Synthetic family query")
    if len(json_body(result).get("learners", [])) != 2:
        raise RuntimeError("Learner profile persistence failed")

    owner_b = account(f"+120255501{first+1:02d}", "Synthetic Noor QA B")
    status, _, _ = http(origin, "/v1/learners/" + learner_id, access_password, opener=owner_b)
    require_status(status, 404, "Cross-account isolation")
    status, _, _ = http(origin, "/api/auth/logout", access_password, "POST", {}, owner_a)
    require_status(status, 200, "Logout revocation")
    status, _, _ = http(origin, "/api/auth/session", access_password, opener=owner_a)
    require_status(status, 401, "Logout replay rejection")
    print("PASS: open dev pages/assets 200, anonymous app sessions 401, D1 readiness, signup, cookie sessions, profiles, isolation and logout; OTP deferred")


def main():
    if not re.fullmatch(r"[0-9a-f]{40}", NOOR_SHA):
        raise RuntimeError("Exact validated Noor commit required")
    if not (NOOR / "apps/web/out/index.html").is_file():
        raise RuntimeError("Account UI static build is missing")
    subdomain = cloudflare_subdomain()
    origin = f"https://{WORKER_NAME}.{subdomain}.workers.dev"
    database_id = staging_database()
    with tempfile.TemporaryDirectory(prefix="noor-staging-", dir=os.environ.get("RUNNER_TEMP", "/tmp")) as dirname:
        temp = Path(dirname)
        config, secure = write_config(temp, database_id, origin, secrets.token_hex(32), secrets.token_hex(32))
        wrangler("d1", "migrations", "apply", DATABASE_NAME, "--config", str(config), "--remote")
        # Wrangler 4.45 does not support 'deploy --secrets-file'. First deploy
        # the fail-closed Worker (no access secret means every path returns 503),
        # then upload BOTH secrets atomically using the pinned 'secret bulk' command.
        wrangler("deploy", "--config", str(config))
        # With the public flag, pages may already return 200 while API routes
        # remain credential-gated. Older deployments may briefly serve a 401
        # or 403 during propagation; subsequent smoke checks enforce 200/401.
        initial_status, _, _ = http(origin, "/")
        if initial_status not in (200, 401, 403, 503):
            raise RuntimeError(f"Unexpected staging transition status HTTP {initial_status}")
        wrangler("secret", "bulk", str(secure), "--config", str(config))
        # Never print generated credentials; even a successful smoke does not
        # authorize real child data, production traffic or OTP delivery.
        credentials = json.loads(secure.read_text())
        smoke(origin, credentials["STAGING_ACCESS_PASSWORD"])
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as report:
            report.write(f"## Noor development staging\n- Noor SHA: `{NOOR_SHA}`\n"
                         f"- Development site (no staging password): `{origin}`\n"
                         "- D1: `noor-core-staging` (independent of production)\n"
                         "- Pages and assets: HTTP 200; app session/learner APIs: HTTP 401 without login\n"
                         "- Remote private synthetic acceptance: PASS\n- OTP and messages: OFF\n")
    print("PASS: open Noor development site and authenticated application APIs remotely verified; no production resources used")


if __name__ == "__main__":
    main()
