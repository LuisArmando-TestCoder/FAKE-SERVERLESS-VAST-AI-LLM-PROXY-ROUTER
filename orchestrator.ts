
type Task = {
    id: string;
    type: "llm";
    prompt: string;
    model?: string;               // optional, defaults in agent
    callbackUrl: string;          // where to POST the final result
    headers?: Record<string, string>;
};

const VAST_API = "https://console.vast.ai/api/v0";
const VAST_API_KEY = Deno.env.get("VAST_API_KEY")!;
const VAST_INSTANCE_ID = Deno.env.get("VAST_INSTANCE_ID")!;
const AGENT_URL = Deno.env.get("AGENT_URL")!;
const AGENT_TOKEN = Deno.env.get("AGENT_TOKEN")!;
const TRIGGER_TOKEN = Deno.env.get("TRIGGER_TOKEN")!;

if (!VAST_API_KEY || !VAST_INSTANCE_ID || !AGENT_URL || !AGENT_TOKEN || !TRIGGER_TOKEN) {
    console.error("Missing required env vars");
    Deno.exit(1);
}

const queue: Task[] = [];
let processing = false;

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function vast(method: string, path: string, body?: unknown) {
    const res = await fetch(`${VAST_API}${path}`, {
        method,
        headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "authorization": `Bearer ${VAST_API_KEY}`,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Vast ${method} ${path} ${res.status}: ${text}`);
    }
    return res.json();
}

async function startInstanceIfNeeded() {
    // idempotent start via manage-instance
    // Body uses target_state per Vast API (create-instance shows this field)
    // https://docs.vast.ai/api/manage-instance , https://docs.vast.ai/api/create-instance
    await vast("PUT", `/instances/${VAST_INSTANCE_ID}/`, { target_state: "running" });
}

async function stopInstance() {
    // stop to cut active GPU rental; note storage still bills until destroyed (see billing docs)
    // https://docs.vast.ai/api/manage-instance , https://docs.vast.ai/billing-help
    await vast("PUT", `/instances/${VAST_INSTANCE_ID}/`, { target_state: "stopped" });
}

async function waitForAgent(timeoutMs = 5 * 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(`${AGENT_URL}/health`);
            if (res.ok) return;
        } catch (_) { }
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error("Agent not reachable in time");
}

async function callAgentGenerate(task: Task) {
    const res = await fetch(`${AGENT_URL}/generate`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-agent-token": AGENT_TOKEN,
        },
        body: JSON.stringify({
            prompt: task.prompt,
            model: task.model ?? "llama3.1:8b", // default; agent can override
        }),
    });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(`Agent error ${res.status}: ${t}`);
    }
    return res.json() as Promise<{ output: string }>;
}

async function postCallback(task: Task, result: { output: string }) {
    await fetch(task.callbackUrl, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(task.headers ?? {}),
        },
        body: JSON.stringify({
            id: task.id,
            type: task.type,
            output: result.output,
            status: "complete",
        }),
    });
}

async function processQueue() {
    if (processing) return;
    processing = true;
    try {
        if (queue.length === 0) return;

        await startInstanceIfNeeded();
        await waitForAgent();

        while (queue.length > 0) {
            const task = queue.shift()!;
            try {
                const result = await callAgentGenerate(task);
                await postCallback(task, result);
            } catch (err) {
                // On failure, send failure to callback and continue
                try {
                    await fetch(task.callbackUrl, {
                        method: "POST",
                        headers: { "content-type": "application/json", ...(task.headers ?? {}) },
                        body: JSON.stringify({ id: task.id, type: task.type, status: "error", error: String(err) }),
                    });
                } catch { }
            }
        }

        // Queue empty: stop instance
        await stopInstance();
    } finally {
        processing = false;
    }
}

Deno.serve(async (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/enqueue" && req.method === "POST") {
        const hType = req.headers.get("x-task-type")?.toLowerCase();
        const body = await req.json().catch(() => ({}));
        const type = (body.type ?? hType) as string;

        if (type !== "llm") return json({ ok: false, error: "only LLM tasks are accepted" }, 400);
        if (!body.prompt || !body.callbackUrl) return json({ ok: false, error: "prompt and callbackUrl required" }, 400);

        const task: Task = {
            id: crypto.randomUUID(),
            type: "llm",
            prompt: String(body.prompt),
            model: body.model,
            callbackUrl: String(body.callbackUrl),
            headers: body.headers,
        };
        const wasEmpty = queue.length === 0;
        queue.push(task);

        // If a trigger arrives later, fine. If you want auto-kickoff when empty->nonempty, uncomment:
        // if (wasEmpty) processQueue().catch(console.error);

        return json({ ok: true, enqueued: task.id, size: queue.length });
    }

    if (url.pathname === "/trigger" && req.method === "POST") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${TRIGGER_TOKEN}`) return json({ ok: false, error: "unauthorized" }, 401);
        processQueue().catch(console.error);
        return json({ ok: true, status: processing ? "processing" : "queued" });
    }

    if (url.pathname === "/health") {
        return json({ ok: true, queue: queue.length, processing });
    }

    return new Response("Not Found", { status: 404 });
});