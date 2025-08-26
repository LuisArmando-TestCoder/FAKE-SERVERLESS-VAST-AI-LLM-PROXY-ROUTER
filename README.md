Got you. Here’s a clean, trigger-driven setup that starts your Vast.ai H100 instance only when an LLM job appears, runs the request via Ollama, returns the result, and shuts the instance down when the queue is empty.

I’m giving you two small pieces:

1. a **Deno orchestrator** you run anywhere cheap (it exposes `/enqueue` and `/trigger`)
2. a tiny **agent** you run on the Vast instance that proxies to **Ollama**

I’ll also point out the exact Vast.ai API calls you’ll hit to start/stop/destroy so billing behaves the way you want.

---

# 1) Orchestrator (Deno, TypeScript)

**What it does**

* `POST /enqueue` — accept a task only if it’s LLM-typed, push to queue
* `POST /trigger` — your external system pings this; if there’s work, we:

  * start the Vast instance (idempotent)
  * wait until the agent is reachable
  * sequentially send tasks to the agent (which calls Ollama)
  * POST the result to each task’s `callbackUrl`
  * when queue is empty, stop the Vast instance

**Env you set**

```
VAST_API_KEY=...           # Vast.ai user API key
VAST_INSTANCE_ID=123456    # your stopped/runnable instance id on Vast
AGENT_URL=http://IP:7788   # public URL to the agent on the instance
AGENT_TOKEN=supersecret    # shared secret between orchestrator and agent
TRIGGER_TOKEN=anothersecret# to protect /trigger
```

**Run**

```bash
deno run -A orchestrator.ts
```

---

# 2) Agent on the Vast instance (tiny Flask proxy to Ollama)

**What it does**

* `/health` → 200 when ready
* `/generate` → calls local `http://127.0.0.1:11434/api/generate` with `stream:false` and returns the full text

**Install Ollama (one-time)**

```bash
curl -fsSL https://ollama.com/install.sh | sh
# ensure it's serving
nohup ollama serve >/var/log/ollama.log 2>&1 &
```

**Agent code — `agent.py`**

```python
from flask import Flask, request, jsonify
import requests
import os

app = Flask(__name__)
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "supersecret")

@app.get("/health")
def health():
    return jsonify({"ok": True})

@app.post("/generate")
def generate():
    if request.headers.get("x-agent-token") != AGENT_TOKEN:
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    data = request.get_json(force=True)
    prompt = data.get("prompt", "")
    model = data.get("model", "llama3.1:8b")
    try:
        r = requests.post(
            "http://127.0.0.1:11434/api/generate",
            json={"model": model, "prompt": prompt, "stream": False},
            timeout=600,
        )
        r.raise_for_status()
        out = r.json().get("response", "")
        return jsonify({"ok": True, "output": out})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=7788)
```

**Run agent**

```bash
pip3 install flask requests
export AGENT_TOKEN=supersecret
nohup python3 agent.py >/var/log/agent.log 2>&1 &
```

**Autostart on Vast when the container boots**

Vast containers run `/root/onstart.sh` automatically if present, so you can drop this in to ensure Ollama + agent launch after every start. ([Vast AI][1])

```bash
# /root/onstart.sh
#!/usr/bin/env bash
set -e
# start ollama if not already
pgrep -x ollama >/dev/null || (nohup ollama serve >/var/log/ollama.log 2>&1 & sleep 2)
# start agent
cd /root/agent
export AGENT_TOKEN=supersecret
nohup python3 agent.py >/var/log/agent.log 2>&1 &
```

> Be sure the offer/instance exposes the agent port (7788) publicly or via your firewall/security group.

---

# How you start/stop/destroy on Vast.ai (so billing behaves)

* **Start/Stop an existing instance (recommended):** `PUT /api/v0/instances/{id}/` with a body like `{ "target_state": "running" }` or `{ "target_state": "stopped" }`. That’s the “manage instance” endpoint your orchestrator uses. ([Vast AI][2])

* **Create (rent) a new instance:** `PUT /api/v0/asks/{id}/` with body containing `"target_state": "running"` and your disk/env settings — that accepts an offer and launches it. ([Vast AI][3])

* **Destroy (to stop storage billing too):** `DELETE /api/v0/instances/{id}/`. Stopped instances still accrue storage and bandwidth charges; destroy them when done to eliminate those. ([Vast AI][4])

* **CLI inside the instance (optional):** You can install `vastai` CLI and `vastai stop instance <id>` from *inside* the container if you ever want the instance to self-stop after work finishes. ([Vast AI][1])

---

# Wiring it together

**1) Enqueue an LLM job**

```bash
curl -X POST http://YOUR-ORCH:port/enqueue \
  -H 'content-type: application/json' \
  -H 'x-task-type: llm' \
  -d '{
    "prompt":"Explain attention as if I know calculus.",
    "callbackUrl":"https://yourapp.com/llm-callback",
    "model":"llama3.1:8b"
  }'
```

**2) Trigger processing (no polling)**

```bash
curl -X POST http://YOUR-ORCH:port/trigger \
  -H "authorization: Bearer $TRIGGER_TOKEN"
```

The orchestrator will:

* start the Vast instance
* wait for the agent
* call Ollama
* POST the final text to `callbackUrl`
* when the queue is empty, **stop** the instance

If you want zero storage billing while idle, call `DELETE /instances/{id}/` instead of stopping, at the cost of longer cold starts and re-pulling your image. ([Vast AI][5])

---

# Notes that save you money

* **Stopped ≠ free**: GPU rental stops, but **storage and bandwidth** still bill. Destroy when you’re truly idle. ([Vast AI][5])
* Prefer **stop** over **destroy** if you want fast warm starts and keep model weights on disk.
* If your instance must stop itself after a final job, you can either:

  * have the orchestrator send the stop call once it verifies the queue is empty, or
  * let the agent call `vastai stop instance $CONTAINER_ID` using the per-instance key (doc shows how to generate/use it). ([Vast AI][1])
