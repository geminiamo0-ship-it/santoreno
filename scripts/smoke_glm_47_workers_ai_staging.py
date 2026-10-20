#!/usr/bin/env python3
"""Single low-token live GLM Workers AI SSE smoke; no private prompts or content in logs."""
import json
import os
import requests

url = ("https://api.cloudflare.com/client/v4/accounts/" +
       os.environ["CLOUDFLARE_ACCOUNT_ID"] +
       "/ai/run/@cf/zai-org/glm-4.7-flash")
payload = {
    "messages": [
        {"role": "system", "content": "Answer in English, in one short sentence."},
        {"role": "user", "content": "Give one well-known example of a heart valve disease."},
    ],
    "stream": True,
    "max_completion_tokens": 120,
    "chat_template_kwargs": {"enable_thinking": False},
}
finish = False
done = False
text_len = 0
event_count = 0
with requests.post(url, json=payload, headers={
    "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"],
    "Content-Type": "application/json",
}, stream=True, timeout=(15, 75)) as response:
    if response.status_code != 200:
        raise RuntimeError("GLM Workers AI unavailable: HTTP " + str(response.status_code))
    for line in response.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data:"):
            continue
        body = line[5:].strip()
        if body == "[DONE]":
            done = True
            break
        event = json.loads(body)
        event_count += 1
        if event.get("error"):
            raise RuntimeError("GLM provider returned error frame")
        choices = event.get("choices") or []
        if not choices:
            continue
        delta = choices[0].get("delta") or {}
        answer = delta.get("content")
        if isinstance(answer, str):
            text_len += len(answer)
        reason = choices[0].get("finish_reason")
        if reason is not None:
            if reason != "stop":
                raise RuntimeError("GLM incomplete reason: " + str(reason))
            finish = True
if not (done and finish and text_len > 5):
    raise RuntimeError("GLM SSE missing answer or verified stop + DONE completion")
print("GLM_STAGING_WORKERS_AI_STREAM_VERIFIED",
      {"events": event_count, "output_chars": text_len}, flush=True)
