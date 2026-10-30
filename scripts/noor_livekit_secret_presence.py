"""Read-only Noor Dev Worker secret-name inventory (never values).

Only `noor-site-staging` is allowed. Invokes Wrangler's documented
`secret list` endpoint: returns name/type metadata, NOT secret contents.
Do not forward raw subprocess output to CI logs or any third party.
"""
import json
import os
import subprocess

WORKER="noor-site-staging"
REQUIRED=frozenset({"LIVEKIT_URL","LIVEKIT_API_KEY","LIVEKIT_API_SECRET"})

def secret_names(payload):
    if not isinstance(payload,list):
        raise ValueError("Unexpected Cloudflare metadata shape")
    found=set()
    for entry in payload:
        if (not isinstance(entry,dict) or
            not isinstance(entry.get("name"),str) or
            not isinstance(entry.get("type"),str)):
            raise ValueError("Unexpected Cloudflare secret item")
        if entry["type"] in ("secret_text","secret_key"):
            found.add(entry["name"])
    return found

def probe():
    if not os.getenv("CLOUDFLARE_ACCOUNT_ID") or not os.getenv("CLOUDFLARE_API_TOKEN"):
        raise RuntimeError("Cloudflare GitHub deployment credentials not configured")
    result=subprocess.run(
        ["npx","--yes","wrangler@4.45.0","secret","list","--name",WORKER,"--format","json"],
        capture_output=True,text=True,check=False,timeout=120,
    )
    if result.returncode:
        # Raw error payloads may contain provider metadata. Do not expose.
        raise RuntimeError("Unable to query Noor Dev Worker secret names")
    try:
        found=secret_names(json.loads(result.stdout))
    except (ValueError,TypeError) as err:
        raise RuntimeError("Unexpected secret names API metadata") from None
    missing=sorted(REQUIRED-found)
    # Only the expected names and a yes/no are disclosed, NEVER values.
    if missing:
        print("CHECK: noor-site-staging LiveKit Dev secrets incomplete")
        print("MISSING_NAMES: "+", ".join(missing))
        return False
    print("PASS: noor-site-staging contains all three LiveKit Dev secret names")
    print("SAFE: no secret values retrieved; no deploy or provider call attempted")
    return True

if __name__=="__main__":
    raise SystemExit(0 if probe() else 2)
