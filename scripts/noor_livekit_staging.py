"""CR-02A/B2: isolated synthetic LiveKit gateway acceptance with NO media.

The same signed teacher and household learner are validated in both configured
and unconfigured Dev. A provider-enabled environment must issue *both* short,
least-privilege tokens; no token or provider response may enter CI logs.
"""
import base64
import json
import re
import time
from urllib.parse import urlsplit


def _jwt_claims(token, now=None):
    """Inspect only safe structural properties; never print/store the JWT."""
    if not isinstance(token, str) or len(token)>8192:
        raise RuntimeError("Unsafe LiveKit token encoding")
    parts=token.split(".")
    if len(parts)!=3 or any(not re.fullmatch(r"[A-Za-z0-9_-]+", p) for p in parts):
        raise RuntimeError("Malformed LiveKit token")
    def unpack(value):
        data=base64.urlsafe_b64decode(value+"="*((-len(value))%4))
        return json.loads(data)
    try:
        header, claims=unpack(parts[0]),unpack(parts[1])
    except (ValueError,UnicodeError,TypeError):
        raise RuntimeError("Malformed LiveKit token claims") from None
    if not isinstance(header,dict) or header!={"alg":"HS256","typ":"JWT"} or not isinstance(claims,dict):
        raise RuntimeError("Unsafe LiveKit JWT header")
    issued=claims.get("iat")
    if (not isinstance(issued,int) or isinstance(issued,bool) or
        abs(issued-int(time.time() if now is None else now))>90 or
        claims.get("nbf")!=issued or claims.get("exp")!=issued+120 or
        not isinstance(claims.get("iss"),str) or len(claims["iss"])<8 or
        not isinstance(claims.get("jti"),str) or not claims["jti"]):
        raise RuntimeError("Unsafe LiveKit JWT issue/expiry claims")
    sub=claims.get("sub")
    video=claims.get("video")
    if not isinstance(sub,str) or not re.fullmatch(r"nq-[a-zA-Z0-9_-]{32}",sub):
        raise RuntimeError("Unexpected LiveKit participant identity")
    if not isinstance(video,dict) or not re.fullmatch(
            r"nq-[a-zA-Z0-9_-]{32}",str(video.get("room",""))):
        raise RuntimeError("Unexpected LiveKit room identity")
    exact={
        "room":video["room"],"roomJoin":True,"roomAdmin":False,
        "roomCreate":False,"roomList":False,"roomRecord":False,
        "canPublish":True,"canPublishSources":["camera","microphone"],
        "canPublishData":False,"canSubscribe":True,
        "canUpdateOwnMetadata":False,
    }
    if video!=exact:
        raise RuntimeError("Unsafe LiveKit media grants")
    return {"room":video["room"],"identity":sub,"issuer":claims["iss"]}


def _valid_server_url(url):
    if not isinstance(url,str):
        return False
    try:
        parsed=urlsplit(url)
        return (parsed.scheme=="wss" and
                bool(re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)*\.livekit\.cloud",
                                  parsed.hostname or "")) and
                not parsed.username and not parsed.password and not parsed.port and
                parsed.path=="" and parsed.query=="" and parsed.fragment=="" and
                url=="wss://"+parsed.hostname)
    except ValueError:
        return False


def verify_livekit_gateway(origin, owner, teacher, learner_id, other_learner,
                           lesson_id, post, http, require_status, json_body):
    if not re.fullmatch(r"https://noor-site-staging\.[a-z0-9-]+\.workers\.dev",origin):
        raise RuntimeError("CR-02A refused non-isolated origin")
    if any(not isinstance(v,str) or not re.fullmatch(r"[0-9a-fA-F-]{36}",v)
           for v in (learner_id,other_learner,lesson_id)):
        raise RuntimeError("CR-02A refused unverified synthetic identity")
    if learner_id==other_learner:
        raise RuntimeError("CR-02A refused duplicate learner IDs")
    student="/v1/me/learners/"+learner_id+"/lessons/"+lesson_id+"/media-token"
    teacher_path="/v1/teacher/lessons/"+lesson_id+"/media-token"
    modes=[]
    claims=[]
    urls=[]
    for path,principal in ((student,owner),(teacher_path,teacher)):
        code,raw,headers=http(origin,path,method="POST",body={},opener=principal)
        if headers.get("Cache-Control")!="no-store":
            raise RuntimeError("CR-02A media response not private")
        value=json_body(raw)
        if code==503:
            if (value.get("code")!="LIVEKIT_NOT_CONFIGURED" or
                "participantToken" in value or "serverUrl" in value):
                raise RuntimeError("CR-02A disabled token response unsafe")
            modes.append("unconfigured")
        elif code==200:
            if (value.get("code")!="MEDIA_TOKEN_ISSUED" or
                value.get("expiresInSeconds")!=120 or
                not _valid_server_url(value.get("serverUrl"))):
                raise RuntimeError("CR-02A malformed configured ticket")
            # The only handling of an actual credential remains in process memory.
            # Never concatenate token/URL into an assertion or exception message.
            parsed=_jwt_claims(value.get("participantToken"))
            modes.append("configured")
            claims.append(parsed)
            urls.append(value["serverUrl"])
        else:
            raise RuntimeError("CR-02A unexpected authorized issuer HTTP status")
        code,_,_=http(origin,path,method="GET",opener=principal)
        require_status(code,405,"CR-02A POST-only token endpoint")
        code,raw,_=http(origin,path,method="POST",
                         body={"role":"teacher","room":"forged","grants":["roomAdmin"]},
                         opener=principal)
        require_status(code,400,"CR-02A reject forged room/role/grants")
    if len(set(modes))!=1:
        raise RuntimeError("CR-02A inconsistent issuer mode between signed actors")
    configured=modes[0]=="configured"
    if configured:
        if (len(claims)!=2 or claims[0]["room"]!=claims[1]["room"] or
            claims[0]["identity"]==claims[1]["identity"] or
            claims[0]["issuer"]!=claims[1]["issuer"] or
            urls[0]!=urls[1]):
            raise RuntimeError("CR-02A failed room/role credential isolation")

    if configured:
        # Actual server-side LiveKit API auth, read-only and room-filtered.
        # The server returns ONLY a safe status; never request provider payloads
        # or log a participant JWT/LiveKit key.
        provider="/v1/teacher/lessons/"+lesson_id+"/livekit-provider-check"
        code,raw,headers=http(origin,provider,method="POST",body={},opener=teacher)
        if code!=200:
            # Only this exact internal enum can enter CI logs: no raw HTTP data.
            safe=json_body(raw).get("code")
            if safe not in ("LIVEKIT_PROVIDER_AUTH_REJECTED",
                            "LIVEKIT_PROVIDER_UNAVAILABLE",
                            "LIVEKIT_PROVIDER_BAD_REQUEST",
                            "LIVEKIT_PROVIDER_RATE_LIMITED",
                            "LIVEKIT_PROVIDER_HTTP_4XX",
                            "LIVEKIT_PROVIDER_UPSTREAM_5XX",
                            "LIVEKIT_PROVIDER_BAD_RESPONSE",
                            "LIVEKIT_PROVIDER_NETWORK_ERROR",
                            "LIVEKIT_NOT_CONFIGURED"):
                safe="UNRECOGNIZED_SAFE_STATUS"
            raise RuntimeError("CR-02A Dev provider probe failed: "+safe)

        if (json_body(raw).get("code")!="LIVEKIT_PROVIDER_REACHABLE" or
            headers.get("Cache-Control")!="no-store"):
            raise RuntimeError("CR-02A provider returned invalid safe status")
        code,_,_=http(origin,provider,method="GET",opener=teacher)
        require_status(code,405,"CR-02A provider check POST-only")
        code,_,_=http(origin,provider,method="POST",
                      body={"room":"forged"},opener=teacher)
        require_status(code,400,"CR-02A provider check rejects injected room")
        for principal,status in ((owner,404),(None,401)):
            code,_,_=http(origin,provider,method="POST",body={},opener=principal)
            require_status(code,status,"CR-02A provider check actor scope")
        print("PASS: CR-02A Dev LiveKit provider authenticated server-side read-only; no media or room created")

    for path,who,status in ((student,teacher,404),(teacher_path,owner,404),
                             (student,None,401),(teacher_path,None,401),
                             ("/v1/me/learners/"+other_learner+"/lessons/"+
                              lesson_id+"/media-token",owner,404)):
        code,_,_=http(origin,path,method="POST",body={},opener=who)
        require_status(code,status,"CR-02A owner/teacher isolation")

    mute="/v1/teacher/lessons/"+lesson_id+"/mute-learner-microphone"
    if not configured:
        code,raw,headers=http(origin,mute,method="POST",body={},opener=teacher)
        require_status(code,503,"CR-02B2 unconfigured mute fail-closed")
        value=json_body(raw)
        if value.get("code")!="LIVEKIT_NOT_CONFIGURED" or headers.get("Cache-Control")!="no-store":
            raise RuntimeError("CR-02B2 disabled mute returned invented provider state")
    # In configured mode do NOT call successful Sheikh mute: this isolated QA
    # intentionally never sends room service moderation requests to LiveKit.
    code,_,_=http(origin,mute,method="GET",opener=teacher)
    require_status(code,405,"CR-02B2 Sheikh mute POST only")
    for body in ({"muted":False},{"trackSid":"forged"},{"room":"other"},
                 {"identity":"child","muted":True}):
        code,_,_=http(origin,mute,method="POST",body=body,opener=teacher)
        require_status(code,400,"CR-02B2 forged track/room/unmute denied")
    for principal,status in ((owner,404),(None,401)):
        code,_,_=http(origin,mute,method="POST",body={},opener=principal)
        require_status(code,status,"CR-02B2 Sheikh-only mute authorization")
    print("PASS: CR-02B2 isolated Dev teacher-only microphone mute policy; "
          "forged unmute 400, learner 404, anonymous 401")
    print("PASS: CR-02A isolated Dev signed actors "+(
        "both issued time-limited scoped JWTs" if configured else
        "both returned disabled-provider 503/no token")+
        "; forged 400, foreign 404, anonymous 401, GET 405; no secrets/media logged")
