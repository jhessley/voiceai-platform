"use strict";

const WebSocket = require("ws");
const CryptoJS = require("crypto-js");

// One controller per callId (prevents double-attaching)
const controllers = new Map(); // callId -> { ws, pending, meta, transcript, ... }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function signRetellStyle(bodyString, secret) {
  return CryptoJS.HmacSHA256(bodyString, secret).toString(CryptoJS.enc.Hex);
}

async function postAgentWebhookRetellStyle({ webhookUrl, webhookSecret, payload }) {
  if (!webhookUrl) return { ok: true, skipped: true, reason: "no webhook_url" };

  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (webhookSecret) headers["x-retell-signature"] = signRetellStyle(body, webhookSecret);

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);

    try {
      const r = await fetch(webhookUrl, { method: "POST", headers, body, signal: ctrl.signal });
      clearTimeout(t);

      const text = await r.text().catch(() => "");
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}

      if (r.ok) return { ok: true, status: r.status, text, json };

      if (attempt < maxAttempts) await sleep(250 * Math.pow(2, attempt - 1));
      else return { ok: false, status: r.status, text, json };
    } catch (e) {
      clearTimeout(t);
      if (attempt < maxAttempts) await sleep(250 * Math.pow(2, attempt - 1));
      else return { ok: false, error: e?.message || String(e) };
    }
  }
}

// ---------- Mustache utilities (same behavior as your index.js) ----------
function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = String(path).split(".").map(p => p.trim()).filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
    else return undefined;
  }
  return cur;
}

function renderMustacheString(str, vars) {
  if (typeof str !== "string") return str;
  return str.replace(/{{\s*([^}]+?)\s*}}/g, (match, key) => {
    const val = getByPath(vars, key);
    if (val === undefined || val === null) return match;
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  });
}

function deepRenderMustache(input, vars) {
  if (input == null) return input;
  if (typeof input === "string") return renderMustacheString(input, vars);
  if (Array.isArray(input)) return input.map(v => deepRenderMustache(v, vars));
  if (typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) out[k] = deepRenderMustache(v, vars);
    return out;
  }
  return input;
}

function normalizeJsonSchemaForOpenAI(schema) {
  if (schema == null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeJsonSchemaForOpenAI);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    const nk = (k === "additional_properties") ? "additionalProperties" : k;
    out[nk] = normalizeJsonSchemaForOpenAI(v);
  }
  return out;
}

function toolDefsFromFlowTools(flowTools = []) {
  return (flowTools || [])
    .filter(t => (t?.type || "").toLowerCase() !== "conversation" && t?.name)
    .map(t => ({
      type: "function",
      name: String(t.name).toLowerCase(),
      description: t.description || "Custom flow tool",
      parameters: normalizeJsonSchemaForOpenAI(
        t.parameters || { type: "object", properties: {}, additionalProperties: true }
      ),
    }));
}

// ---------- Transcript helpers ----------
function toPlainTranscript(events) {
  return events
    .filter(e => e.type === "user" || e.type === "agent")
    .map(e => `${e.type === "user" ? "User" : "Agent"}: ${e.text}`)
    .join("\n");
}

function toPlainTranscriptWithTools(events) {
  return events.map(e => {
    if (e.type === "user") return `User: ${e.text}`;
    if (e.type === "agent") return `Agent: ${e.text}`;
    if (e.type === "tool_call") return `Tool call: ${e.name}(${JSON.stringify(e.args)})`;
    if (e.type === "tool_result") return `Tool result: ${e.name} -> ${JSON.stringify(e.output)}`;
    return "";
  }).filter(Boolean).join("\n");
}

function toTranscriptObject(events, { includeTools }) {
  return events
    .filter(e => includeTools ? true : (e.type === "user" || e.type === "agent"))
    .map(e => {
      if (e.type === "user") return { role: "user", content: e.text, timestamp: e.ts };
      if (e.type === "agent") return { role: "agent", content: e.text, timestamp: e.ts };
      if (e.type === "tool_call") return { role: "tool", tool_event: "call", name: e.name, args: e.args, timestamp: e.ts };
      if (e.type === "tool_result") return { role: "tool", tool_event: "result", name: e.name, output: e.output, timestamp: e.ts };
      return null;
    })
    .filter(Boolean);
}

// ---------- Call accept (phone only) ----------
async function acceptPhoneCall({ callId, apiKey, model = "gpt-realtime", instructions }) {
  const acceptUrl = `https://api.openai.com/v1/realtime/calls/${callId}/accept`;

  const acceptRes = await fetch(acceptUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "realtime",
      model,
      instructions: instructions || "",
    }),
  });

  if (!acceptRes.ok) {
    const body = await acceptRes.text().catch(() => "");
    const err = new Error(`ACCEPT failed ${acceptRes.status}: ${body}`);
    err.status = acceptRes.status;
    err.body = body;
    throw err;
  }

  return true;
}

// ---------- Build session parts (shared) ----------
function buildSessionParts({ agentSpec, dynamicVars, env }) {
  const flow = agentSpec.conversationFlow || {};
  const VOICE = (env?.VOICE) || process.env.VOICE || "marin";

  // built-in tools
  const builtins = [
    {
      type: "function",
      name: "transfer_call",
      description: "Transfer the current call to a phone number (E.164) or target_uri (tel: / sip:).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          phone_number: { type: "string", description: "Destination phone number in E.164, e.g. +13865551234" },
          target_uri: { type: "string", description: "Optional explicit target URI, e.g. tel:+1386... or sip:alice@example.com" },
          handoff_message: { type: "string", description: "What the agent should say before transferring" }
        }
      }
    },
    {
      type: "function",
      name: "end_call",
      description: "End the current phone call immediately.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          closing_message: { type: "string", description: "Optional final message before ending the call" }
        }
      }
    }
  ];

  const renderedTools = deepRenderMustache(flow.tools || [], dynamicVars || {});
  const flowToolDefs = toolDefsFromFlowTools(renderedTools);
  const flowToolsByName = Object.fromEntries(
    (renderedTools || []).map(t => [String(t.name || "").toLowerCase(), t])
  );

  const TOOL_DEFS = [...builtins, ...flowToolDefs];

  const renderedFlow = deepRenderMustache(flow, dynamicVars || {});
  const renderedAgentPrompt = agentSpec.prompt
    ? renderMustacheString(agentSpec.prompt, dynamicVars || {})
    : "";

  const instructions =
    (renderedAgentPrompt ? renderedAgentPrompt + "\n\n" : "") +
    "Use the following conversation flow as a guide. If you encounter a tool or function, execute the tool or function.\n" +
    JSON.stringify(renderedFlow);

  return {
    VOICE,
    TOOL_DEFS,
    flowToolsByName,
    renderedFlow,
    instructions,
  };
}

// ---------- Start/reuse a controller for any call_id ----------
async function startControlledCall({
  callId,
  agentSpec,
  dynamicVars = {},
  sipHeaders = [],
  direction = "inbound", // inbound | outbound | web
  callSid = null,

  deps,
}) {
  if (!callId) throw new Error("startControlledCall: callId is required");
  if (!agentSpec) throw new Error("startControlledCall: agentSpec is required");
  if (!deps?.apiKey) throw new Error("startControlledCall: deps.apiKey is required");

  // idempotent attach
  if (controllers.has(callId)) {
    return { ok: true, already: true };
  }

  const {
    apiKey,
    env = process.env,
    axios,
    twilioClient,
    postRefer, // your existing helper (optional; required for transfer)
  } = deps;

  const startTs = Date.now();

  const parts = buildSessionParts({ agentSpec, dynamicVars, env });
  const { VOICE, TOOL_DEFS, flowToolsByName, instructions } = parts;

  // Per-call transcript event store
  const transcript = { events: [] };
  function pushEvent(evt) {
    transcript.events.push({ ts: Date.now(), ...evt });
  }

  // Track streaming function calls
  const pending = new Map(); // function call_id -> { name, args: "" }

  async function runCustomTool(ctx) {
    const tool = ctx.toolDef;
    const timeout = tool.timeout_ms || 120000;
    const args = ctx.toolArgs || {};
    const body = tool.args_at_root ? args : { args };

    const resp = await axios({
      method: tool.method || "POST",
      url: tool.url,
      headers: tool.headers || {},
      params: tool.query_params || {},
      data: body,
      timeout,
      validateStatus: () => true
    });

    if (resp.status >= 200 && resp.status < 300) {
      return { ok: true, status: resp.status, data: resp.data };
    }
    return { ok: false, status: resp.status, data: resp.data };
  }

  async function tool_transfer_call(args) {
    const { phone_number, target_uri, handoff_message } = args || {};
    const TARGET_URI =
      (target_uri && String(target_uri).trim()) ||
      (phone_number ? `tel:${String(phone_number).trim()}` : null) ||
      env.TRANSFER_URI || null;

    if (!TARGET_URI) return { ok: false, error: "Missing phone_number or target_uri (and no TRANSFER_URI fallback)." };

    return {
      ok: true,
      transferring: true,
      target: TARGET_URI,
      handoff_message: handoff_message || "One moment while I connect you."
    };
  }

  async function tool_end_call(args) {
    const closing_message = args?.closing_message || "";
    return { ok: true, ending: true, closing_message };
  }

  async function executeTool(toolName, toolArgs, runtimeCtx) {
    const name = String(toolName || "").toLowerCase();

    if (name === "transfer_call") return await tool_transfer_call(toolArgs, runtimeCtx);
    if (name === "end_call") return await tool_end_call(toolArgs, runtimeCtx);

    const tool = flowToolsByName[name];
    if (!tool) return { ok: false, error: `Unknown tool: ${toolName}` };

    return await runCustomTool({
      axios,
      toolDef: tool,
      toolArgs: toolArgs || {}
    });
  }

  // Open WS sideband control channel for this callId (works for phone + web)
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${callId}`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  controllers.set(callId, {
    ws,
    pending,
    transcript,
    meta: { callSid, direction, startTs },
    agentSpec,
  });

  ws.on("open", () => {
    // IMPORTANT: always send instructions + tools here
    // - Phone: you also used /accept; session.update can refine/override.
    // - Web: this is how you set the brain.
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime",
        instructions,
        audio: {
          input: {
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 600,
              create_response: true,
              interrupt_response: true
            }
          },
          output: { voice: VOICE }
        },
        tools: TOOL_DEFS,
      }
    }));

    // Kick off the conversation (same for all transports)
    ws.send(JSON.stringify({ type: "response.create" }));
  });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg?.type === "error") {
      console.error("RT error:", JSON.stringify(msg));
      return;
    }

    // Start tracking a function call item
    if (msg.type === "response.output_item.added" && msg.item?.type === "function_call") {
      const { call_id, name } = msg.item;
      pending.set(call_id, { name, args: "" });
      return;
    }

    // Accumulate streaming args
    if (msg.type === "response.function_call_arguments.delta") {
      const rec = pending.get(msg.call_id);
      if (rec) rec.args += msg.delta || "";
      return;
    }

    // Execute tool on completion
    if (msg.type === "response.output_item.done" && msg.item?.type === "function_call") {
      const fcId = msg.item.call_id;
      const toolName = msg.item.name;

      const rec = pending.get(fcId);
      const argsText = rec?.args || "{}";

      let parsedArgs = {};
      try { parsedArgs = argsText ? JSON.parse(argsText) : {}; }
      catch {
        parsedArgs = {};
      }

      pushEvent({ type: "tool_call", name: toolName, args: parsedArgs });

      const runtimeCtx = {
        ws,
        callId,
        env,
        twilioClient,
        callSid,
        postRefer,
      };

      let toolResult;
      try {
        toolResult = await executeTool(toolName, parsedArgs, runtimeCtx);
        pushEvent({ type: "tool_result", name: toolName, output: toolResult });
      } catch (e) {
        toolResult = { ok: false, error: e?.message || String(e) };
      }

      // Return tool output to model ALWAYS
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: fcId,
          output: JSON.stringify(toolResult)
        }
      }));

      pending.delete(fcId);

      const lower = String(toolName || "").toLowerCase();

      // Built-in transfer/end only makes sense for phone calls
      const isPhone = direction === "inbound" || direction === "outbound";

      if (lower === "transfer_call" && toolResult?.ok && isPhone) {
        ws.send(JSON.stringify({
          type: "response.create",
          response: { instructions: toolResult.handoff_message || "One moment while I connect you." }
        }));

        const settleDelay = Number(env.TRANSFER_DELAY_MS || 1500);
        setTimeout(async () => {
          try {
            if (!postRefer) {
              console.error("postRefer not provided; cannot REFER");
              return;
            }
            console.log("Issuing REFER to:", toolResult.target);
            await postRefer({ callId, targetUri: toolResult.target });
          } catch (e) {
            console.error("REFER exception:", e?.message || e);
          }
        }, settleDelay);

        return;
      }

      if (lower === "end_call" && toolResult?.ok && isPhone) {
        const closing = toolResult.closing_message || "";
        if (closing) {
          ws.send(JSON.stringify({
            type: "response.create",
            response: { instructions: closing }
          }));
        }

        const HANGUP_DELAY = Number(env.HANGUP_DELAY_MS || 600);
        setTimeout(async () => {
          try {
            if (!callSid || !twilioClient) {
              console.error("Cannot hang up: missing callSid or twilioClient for callId", callId);
              return;
            }
            await twilioClient.calls(callSid).update({ status: "completed" });
          } catch (e) {
            console.error("Twilio hangup failed:", e?.message || e);
          }
        }, HANGUP_DELAY);

        return;
      }

      // Continue model after normal tools
      ws.send(JSON.stringify({ type: "response.create", response: {} }));
      return;
    }

    // User transcription (if enabled)
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const userText =
        msg.transcript ||
        msg.item?.transcript ||
        msg.item?.content?.map(c => c?.text).filter(Boolean).join(" ") ||
        "";
      if (userText) pushEvent({ type: "user", text: userText });
      return;
    }

    // Assistant spoken transcript (you were using response.output_audio_transcript.done)
    if (msg.type === "response.output_audio_transcript.done") {
      const agentSpoken = msg.transcript || "";
      if (agentSpoken) pushEvent({ type: "agent", text: agentSpoken });
      return;
    }
  });

  ws.on("close", async (code, reason) => {
    const c = controllers.get(callId);
    controllers.delete(callId);

    const endTs = Date.now();
    const meta = c?.meta || { startTs, direction, callSid };

    const events = c?.transcript?.events || [];
    const transcriptText = toPlainTranscript(events);
    const transcriptWithTools = toPlainTranscriptWithTools(events);
    const transcriptObj = toTranscriptObject(events, { includeTools: false });
    const transcriptObjWithTools = toTranscriptObject(events, { includeTools: true });

    const disconnection_reason =
      meta.disconnection_reason ||
      (code === 1000 ? "user_hangup" : "unknown");

    // For web calls, call_type can be "web_call" (your schema)
    const call_type = (meta.direction === "web") ? "web_call" : "phone_call";

    await postAgentWebhookRetellStyle({
      webhookUrl: agentSpec.webhook_url,
      webhookSecret: agentSpec.webhook_secret,
      payload: {
        event: "call_ended",
        call: {
          call_type,
          direction: meta.direction === "web" ? "web" : meta.direction,
          call_id: callId,
          agent_id: agentSpec.agent_id || agentSpec.id || "unknown",
          call_status: "ended",
          start_timestamp: meta.startTs || undefined,
          end_timestamp: endTs,
          disconnection_reason,
          ...(transcriptText ? { transcript: transcriptText } : {}),
          ...(transcriptWithTools ? { transcript_with_tool_calls: transcriptWithTools } : {}),
          ...(transcriptObj?.length ? { transcript_object: transcriptObj } : {}),
          ...(transcriptObjWithTools?.length ? { transcript_object_with_tool_calls: transcriptObjWithTools } : {}),
        },
      },
    });

    // cleanup per-call pending map
    try { pending.clear(); } catch {}
    console.log("Realtime WS closed", code, reason?.toString?.() || "", "callId=", callId);
  });

  ws.on("error", (err) => {
    console.error("Realtime WS error:", err);
  });

  return { ok: true };
}

module.exports = {
  acceptPhoneCall,
  buildSessionParts,
  startControlledCall,
};
