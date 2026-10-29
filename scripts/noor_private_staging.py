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


def http(origin, path, secret=None, method="GET", body=None, opener=None, max_bytes=1024 * 128):
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
            return response.status, response.read(max_bytes), response.headers
    except urllib.error.HTTPError as error:
        return error.code, error.read(max_bytes), error.headers


def require_status(status, expected, label):
    if status != expected:
        raise RuntimeError(f"{label}: expected HTTP {expected}, got {status}")


def json_body(content):
    return json.loads(content.decode())


def smoke(origin, access_password, database_id):
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
    # Next.js static HTML can contain >128KB of serialized React state.
    # Truncating the body hid the new Quran component after the header.
    status, classroom, _ = http(origin, "/classroom/", max_bytes=1024 * 1024)
    require_status(status, 200, "Immersive classroom preview")
    if "وضع الحصة".encode("utf-8") not in classroom:
        raise RuntimeError("Deployed classroom is missing the immersive lesson mode")
    # Additional owner-approved dense layout markers. Check the actual served
    # HTML to reject a stale previous staging build, not just local Next build.
    for marker in ("ضبط الوقت التجريبي", "الصفحة السابقة", "الصفحة التالية"):
        if marker.encode("utf-8") not in classroom:
            raise RuntimeError("Stale classroom staging: missing compact UI marker " + marker)
    # Exact deployed markup from Noor PR #133: the old Quran component used
    # duplicated mobile height restrictions and kept the Quran tiny. Reject
    # a stale Cloudflare Pages asset/SSR build, not just an HTTP 200 document.
    if b'data-quran-layout="viewport-fit"' not in classroom:
        raise RuntimeError("Staging still serves old tiny-Quran layout")
    print("PASS: deployed classroom contains new viewport-fit Quran and compact controls")


    # A random .js file in the build output may not be referenced by this
    # route (and Cloudflare assets can propagate after HTML). Test the actual
    # browser scripts linked by the deployed classroom HTML.
    linked = re.findall(rb'<script[^>]+src="(/_next/static/[^"]+\.js)"', classroom)
    if not linked:
        raise RuntimeError("No browser JavaScript scripts referenced by classroom HTML")
    tested = []
    for raw_path in dict.fromkeys(linked).keys():
        path = raw_path.decode("ascii")
        if not (NOOR / "apps/web/out" / path.lstrip("/")).is_file():
            raise RuntimeError("Classroom references a JS file absent from build")
        status = 0
        for attempt in range(18):
            status, _, _ = http(origin, path)
            if status == 200:
                break
            if status not in (404, 503):
                raise RuntimeError(f"Classroom JS asset HTTP {status}")
            time.sleep(2)
        require_status(status, 200, "Referenced classroom JS " + str(len(tested)+1))
        tested.append(path)
        if len(tested) >= 3:
            break
    print(f"PASS: {len(tested)} real classroom JS script assets loaded HTTP 200")

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

    first = secrets.randbelow(9999998)
    owner_a = account(f"+1202{first:07d}", "Synthetic Noor QA A")
    # Secrets uploaded immediately after Wrangler deploy may take time to
    # converge across Cloudflare isolates. Keep real authorization checks;
    # retry 401 only for this short synthetic post-deploy QA window.
    for attempt in range(15):
        status, result, _ = http(origin, "/api/auth/session", access_password, opener=owner_a)
        if status == 200:
            break
        if status != 401:
            raise RuntimeError(f"Unexpected signed-session status HTTP {status}")
        time.sleep(2)
    require_status(status, 200, "Cookie session restore")
    if not json_body(result).get("user", {}).get("id"):
        raise RuntimeError("Cookie session returned no verified user")

    learner_id = ""
    for index in (1, 2):
        for attempt in range(15):
            status, result, _ = http(origin, "/v1/me/learners", access_password, "POST",
                                     {"name": f"Synthetic Learner {index}", "learnerType": "child"}, owner_a)
            if status == 201:
                break
            if status != 401:
                raise RuntimeError(f"Unexpected learner create status HTTP {status}")
            time.sleep(2)
        require_status(status, 201, "Synthetic learner creation")
        learner_id = json_body(result)["learner"]["id"]
    status, result, _ = http(origin, "/v1/me/learners", access_password, opener=owner_a)
    require_status(status, 200, "Synthetic family query")
    if len(json_body(result).get("learners", [])) != 2:
        raise RuntimeError("Learner profile persistence failed")

    owner_b = account(f"+1202{first+1:07d}", "Synthetic Noor QA B")
    status, _, _ = http(origin, "/v1/learners/" + learner_id, access_password, opener=owner_b)
    require_status(status, 404, "Cross-account isolation")
    # Actual private Quran persistence acceptance on the SAME open Dev origin.
    # Use disposable owner accounts and the independently verified 6236 anchors.
    from uuid import uuid4
    endpoint = "/v1/me/learners/" + learner_id + "/mushaf"
    def persist(kind, item_id, payload, expected=0, action="put"):
        command = {"operationId": str(uuid4()), "itemId": item_id,
                   "kind": kind, "action": action, "page": 1,
                   "expectedVersion": expected, "payload": payload}
        code, body, _ = http(origin, endpoint, access_password, "POST", command, owner_a)
        require_status(code, 201, "Quran "+kind+" "+action)
        value = json_body(body).get("item", {})
        if value.get("itemId") != item_id or value.get("version") != expected+1:
            raise RuntimeError("D1 private Quran save ACK did not match expected revision")
        return value
    stroke = "synthetic-ink-" + str(uuid4())
    persist("pen", stroke, {"color": "#f6cd46", "width": 3,
                            "points": [{"x": 120, "y": 220}, {"x": 180, "y": 280}]})
    persist("marker", "synthetic-marker-"+str(uuid4()),
            {"color": "#86c5a8", "width": 16,
             "points": [{"x": 180, "y": 320}, {"x": 230, "y": 340}]})
    note = "note-synthetic-" + str(uuid4())
    note_data = {"target": {"surah": 1, "ayah": 1, "wordIndex": None},
                 "color": "#f6cd46", "text": "Synthetic development check"}
    persist("note", note, note_data)
    persist("bookmark", "bookmark-1", {})
    code, page_data, _ = http(origin, endpoint+"?page=1", access_password, opener=owner_a)
    require_status(code, 200, "Quran stored page read")
    if not any(item.get("itemId") == stroke for item in json_body(page_data).get("items", [])):
        raise RuntimeError("Saved Quran pen not present after D1 reload")
    persist("note", note, {}, 1, "hide")
    code, index_data, _ = http(origin, endpoint+"?index=1", access_password, opener=owner_a)
    require_status(code, 200, "Quran stored index read")
    if not any(item.get("itemId") == note and item.get("version") == 2
               and item.get("visible") is False
               for item in json_body(index_data).get("items", [])):
        raise RuntimeError("Private Quran tombstone not preserved after reload")
    persist("note", note, note_data, 2)
    code, _, _ = http(origin, endpoint+"?page=1", access_password, opener=owner_b)
    require_status(code, 404, "Other account Quran isolation")
    print("PASS: open Dev account-backed Quran pen/marker/note/bookmark, save/reload/restore, foreign-owner 404")

    # Noor #157: all mutations are authenticated *through deployed staging*,
    # never direct SQL. Only read-only D1 counts are used for archive audit proof.
    if not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", learner_id):
        raise RuntimeError("Unexpected learner identifier from deployed Noor")
    profile_path = "/v1/me/learners/" + learner_id + "/profile-actions"
    code, payload, _ = http(origin, "/v1/me/learners", access_password, opener=owner_a)
    require_status(code, 200, "Profile revisions initial GET")
    profiles = json_body(payload).get("learners", [])
    if len(profiles) != 2 or any(p.get("revision") != 1 for p in profiles):
        raise RuntimeError("Profiles lack 0008 revision migration or expected initial state")
    command = {"action": "rename", "name": "Synthetic Learner 2 Updated",
               "expectedRevision": 1, "operationId": str(uuid4())}
    code, _, _ = http(origin, profile_path, access_password, "POST", command, owner_b)
    require_status(code, 404, "Foreign owner profile mutation denied")
    code, payload, _ = http(origin, profile_path, access_password, "POST", command, owner_a)
    require_status(code, 200, "Profile rename with D1 CAS")
    if json_body(payload).get("revision") != 2:
        raise RuntimeError("D1 rename ACK revision mismatch")
    code, payload, _ = http(origin, profile_path, access_password, "POST", command, owner_a)
    require_status(code, 200, "Profile rename replay")
    if json_body(payload).get("code") != "OPERATION_ALREADY_APPLIED":
        raise RuntimeError("Duplicate rename generated a new mutation")
    stale = {**command, "operationId": str(uuid4()), "name": "Stale edit"}
    code, _, _ = http(origin, profile_path, access_password, "POST", stale, owner_a)
    require_status(code, 409, "Profile edit with stale expectedRevision")
    code, payload, _ = http(origin, "/v1/me/learners", access_password, opener=owner_a)
    require_status(code, 200, "Renamed learner refresh")
    profile = next((p for p in json_body(payload).get("learners", [])
                    if p.get("id") == learner_id), None)
    if not profile or profile.get("name") != command["name"] or profile.get("revision") != 2:
        raise RuntimeError("Confirmed profile rename missing after remote GET")

    archive = {"action": "archive", "expectedRevision": 2, "operationId": str(uuid4())}
    code, payload, _ = http(origin, profile_path, access_password, "POST", archive, owner_a)
    require_status(code, 200, "Profile archive")
    if json_body(payload).get("revision") != 3:
        raise RuntimeError("Archive ACK revision mismatch")
    code, payload, _ = http(origin, "/v1/me/learners", access_password, opener=owner_a)
    require_status(code, 200, "Active sibling list after archive")
    active = json_body(payload).get("learners", [])
    if len(active) != 1 or any(p.get("id") == learner_id for p in active):
        raise RuntimeError("Archived learner leaked into active siblings")
    code, _, _ = http(origin, "/v1/learners/" + learner_id, access_password, opener=owner_a)
    require_status(code, 404, "Archived learner detail denied")
    code, _, _ = http(origin, endpoint + "?page=1", access_password, opener=owner_a)
    require_status(code, 404, "Archived learner private Quran access denied")
    # Verify prior private Quran and its immutable profile audit remain in D1
    # without returning child content, audio or private annotations to logs.
    preserved = d1_read_only(database_id,
        "SELECT (SELECT COUNT(*) FROM private_mushaf_items WHERE learner_id='" + learner_id +
        "') AS quran_count, (SELECT COUNT(*) FROM learner_profile_audit WHERE learner_id='" +
        learner_id + "') AS audit_count")
    if len(preserved) != 1 or preserved[0].get("quran_count", 0) < 4 or preserved[0].get("audit_count") != 2:
        raise RuntimeError("Archive did not preserve private Quran records and audit history")
    print("PASS: Noor profile rename, CAS 409, idempotent replay, cross-owner 404, archive, hidden-after-refresh and private history preserved")

    
    status, _, _ = http(origin, "/api/auth/logout", access_password, "POST", {}, owner_a)
    require_status(status, 200, "Logout revocation")
    status, _, _ = http(origin, "/api/auth/session", access_password, opener=owner_a)
    require_status(status, 401, "Logout replay rejection")
    print("PASS: open dev pages/assets 200, anonymous app sessions 401, D1 readiness, signup, cookie sessions, profiles, isolation and logout; OTP deferred")



# Noor-only, reviewable canonical corpus metadata. Both values come from
# the independent source-verification run in Noor PR #148 / issue #147.
NOOR_MANIFEST_SHA = "864c5474872876b3db8a328d8c74781be83c004a7cdb168ffb4b7eb57477edd2"
NOOR_HAFS_TEXT_SHA = "9b9eb07ff5cff144bf964400924e593d97115e4b937db3c61783f782a5168075"
NOOR_EDITION = "hafs-kfqc:v1.1.1"
NOOR_AYAH_INSERT = re.compile(
    r"^INSERT INTO quran_ayah_anchors\(edition_id,surah,ayah,page,word_count\) "
    r"VALUES\('hafs-kfqc:v1\.1\.1',([0-9]+),([0-9]+),([0-9]+),([0-9]+)\);$"
)


def d1_read_only(database_id, statement):
    """Query only our explicitly identified staging UUID, never a supplied DB name."""
    if not re.fullmatch(r"[0-9a-fA-F-]{32,36}", database_id):
        raise RuntimeError("Invalid staging D1 UUID")
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{database_id}/query"
    body = json.dumps({"sql": statement}).encode()
    request = urllib.request.Request(url, data=body, headers={
        "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json",
        "Accept": "application/json", "User-Agent": "NoorStagingCanonicalChecker/1.0",
    }, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=90) as reply:
            result = json.load(reply)
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        # Do not log HTTP response payloads or authorization headers.
        raise RuntimeError("Cloudflare staging D1 read-only query failed") from None
    if not result.get("success") or len(result.get("result", [])) != 1:
        raise RuntimeError("Cloudflare staging D1 query not acknowledged")
    block = result["result"][0]
    if block.get("success") is not True or not isinstance(block.get("results"), list):
        raise RuntimeError("Cloudflare staging D1 result was invalid")
    return block["results"]


def canonical_quran_staging(config, database_id, temporary):
    """Import only to dedicated noor-core-staging, only when empty and fully verified."""
    source = NOOR / "scripts/noor_quran_anchor_import.py"
    if not source.is_file() or DATABASE_NAME != "noor-core-staging":
        raise RuntimeError("No verified Noor-only Quran import source or staging DB")
    destination = temporary / "canonical-hafs"
    result = subprocess.run([
        "python3", str(source), "--output-dir", str(destination),
        "--expected-manifest-sha256", NOOR_MANIFEST_SHA,
    ], cwd=NOOR, capture_output=True, text=True, check=False, timeout=240)
    if result.returncode:
        raise RuntimeError("Pinned Quran metadata verification refused; staging untouched")
    details = json.loads((destination / "verified-quran-anchors-evidence.json").read_text())
    if (details.get("edition") != NOOR_EDITION or
        details.get("manifest_sha256") != NOOR_MANIFEST_SHA or
        details.get("word_source_sha256") != NOOR_HAFS_TEXT_SHA or
        details.get("ayah_count") != 6236 or details.get("word_total") != 77432 or
        details.get("page_count") != 604):
        raise RuntimeError("Quran source hashes/counts differ; refusing staging write")
    sql_file = destination / "verified-quran-anchors.sql"
    lines = sql_file.read_text().splitlines()
    expected = []
    for line in lines:
        match = NOOR_AYAH_INSERT.fullmatch(line)
        if match:
            expected.append(tuple(int(value) for value in match.groups()))
        elif line.startswith("INSERT INTO quran_ayah_anchors"):
            raise RuntimeError("Unexpected generated Quran SQL")
    if len(expected) != 6236 or len(set(row[:2] for row in expected)) != 6236:
        raise RuntimeError("Generated Quran SQL incomplete")
    expected.sort()
    edition_rows = d1_read_only(database_id,
        "SELECT id,manifest_sha256,page_count FROM quran_editions WHERE id='hafs-kfqc:v1.1.1'")
    existing_rows = d1_read_only(database_id,
        "SELECT surah,ayah,page,word_count FROM quran_ayah_anchors "
        "WHERE edition_id='hafs-kfqc:v1.1.1' ORDER BY surah,ayah")
    def as_tuples(rows):
        return sorted((row["surah"], row["ayah"], row["page"], row["word_count"])
                      for row in rows)
    if edition_rows or existing_rows:
        # Fully idempotent only when EVERY row agrees, not just total counts.
        if (len(edition_rows) != 1 or
            edition_rows[0].get("manifest_sha256") != NOOR_MANIFEST_SHA or
            edition_rows[0].get("page_count") != 604 or
            as_tuples(existing_rows) != expected):
            raise RuntimeError("Refusing existing partial or mismatched Quran staging data")
        print("PASS: all existing 6236 staging Hafs anchors match audited source; no write")
        return
    # Only here may a remote D1 mutation take place, and only for one named
    # isolated Noor staging DB; never Santo / Noor production.
    wrangler("d1", "execute", DATABASE_NAME, "--config", str(config), "--remote",
             "--file", str(sql_file))
    edition_after = d1_read_only(database_id,
        "SELECT id,manifest_sha256,page_count FROM quran_editions WHERE id='hafs-kfqc:v1.1.1'")
    actual = d1_read_only(database_id,
        "SELECT surah,ayah,page,word_count FROM quran_ayah_anchors "
        "WHERE edition_id='hafs-kfqc:v1.1.1' ORDER BY surah,ayah")
    if (len(edition_after) != 1 or
        edition_after[0].get("manifest_sha256") != NOOR_MANIFEST_SHA or
        as_tuples(actual) != expected):
        raise RuntimeError("D1 import did not verify completely; do not enable Quran UI")
    print("PASS: dedicated Noor staging D1 now has 6236 verified Hafs anchors; Quran UI feature OFF")



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
        canonical_quran_staging(config, database_id, temp)
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
        smoke(origin, credentials["STAGING_ACCESS_PASSWORD"], database_id)
        # One ordinary development site only. Do not create a second QA worker.
        # The development build exposes account-backed personal Quran saves.
        # Account-level Better Auth and per-learner D1 authorization still apply.
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
