// /home/ec2-user/app_voiceai_tradewindsapp/index.js

// #region Imports & Setup
const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, '.env'),
  override: true
});
const express = require('express');

const cors = require('cors');
const CryptoJS = require('crypto-js');
const multer = require('multer');
const axios = require('axios');
const session = require('express-session');
const OUTBOUND_FROM = process.env.OUTBOUND_FROM || process.env.TWILIO_NUMBER;
const PUBLIC_HOSTNAME = process.env.PUBLIC_HOSTNAME;
const realtimeRoutes = require("./routes/realtime.js");
const { acceptPhoneCall, buildSessionParts, startControlledCall } = require("./realtime_controller.js");


// DB + Novel factory (NEW)

const { OpenAI } = require('openai');
const WebSocket = require('ws');
const app = express();

const port = parseInt(process.env.PORT || "1923", 10);



app.set('trust proxy', 1);
// #endregion

// #region Middleware
//app.use(express.json()); //commented for openai testing
const jsonParser = express.json();
app.use((req, res, next) => {
  if (req.path === "/openai/webhooks") return next(); // skip JSON parser here
  return jsonParser(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));
console.log("STATIC DIR:", path.join(__dirname, "public"));

app.use((req, res, next) => {
  console.log("voiceai");
  next();
});
app.use("/realtime", realtimeRoutes);

// #endregion

// #region Root & Test Routes
app.get('/', (req, res) => {
  res.send('Welcome to TradeWindsApp voice ai app!');
});
app.post('/test/endpoint', async (req, res) => {
  const { caller, message } = req.body;
  console.log('Test endpoint hit with body:', req.body);
  res.json({ message: `Hi, ${caller}. Your lucky number is 72`, receivedData: req.body });
});
// #endregion

app.post("/twilio/refer", express.urlencoded({ extended: false }), (req, res) => {
  // 1) Read & sanitize the REFER target
  const raw = String(req.body.ReferTransferTarget || "").trim();      // e.g. "<tel:+1386...>" or "sip:foo@example.com"
  const noBrackets = raw.replace(/^<|>$/g, "");                       // remove angle brackets
  console.log("Refer target (raw):", raw);
  // 2) Choose a valid Twilio callerId for the new outbound leg
  // Prefer an env var; fall back to the Twilio number that originally took the call.
  const callerId =
    process.env.REFER_CALLER_ID ||                                  // e.g. "+15551234567" (Twilio-owned)
    req.body.To ||                                                  // Twilio sends "To" = your Twilio number
    process.env.TWILIO_NUMBER || "";

  // 3) Build TwiML with proper verb and a fallback
  let dialChild;
  if (noBrackets.startsWith("sip:")) {
    const sipUri = noBrackets.slice(4);                              // strip "sip:"
    dialChild = `<Sip>${sipUri}</Sip>`;
  } else {
    const e164 = noBrackets.replace(/^tel:/, "");                    // "tel:+1..." -> "+1..."
    dialChild = `<Number>${e164}</Number>`;
  }
  console.log('dialChild: ', dialChild);
  // Optional: set a short timeout and return a friendly message if it fails.
  const fallbackRedirectUrl = process.env.TRANSFER_FAIL_REDIRECT_URL; // absolute URL back to your assistant, optional

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}" answerOnBridge="true" timeout="20">
    ${dialChild}
  </Dial>
  <Say>Sorry, we couldn’t complete the transfer.</Say>
  ${fallbackRedirectUrl ? `<Redirect method="POST">${fallbackRedirectUrl}</Redirect>` : ""}
</Response>`;

  res.type("text/xml").send(twiml);
});

async function postRefer({ callId, targetUri }) {
  //targetUri = 'tel:+13869653832'
  const headers = {
    Authorization: `Bearer ${process.env.REALTIME_API_KEY}`,   // same key you used for /accept
    "Content-Type": "application/json",
    // "OpenAI-Beta": "realtime=v1",
  };
  // Strongly recommended unless your key is project-scoped:
  if (process.env.REALTIME_VOICE_PROJECT_ID) headers["OpenAI-Project"] = process.env.REALTIME_VOICE_PROJECT_ID; // proj_...

  let res;
  try {
    res = await fetch(`https://api.openai.com/v1/realtime/calls/${callId}/refer`, {
      method: "POST",
      headers,
      body: JSON.stringify({ target_uri: targetUri }), // ONLY this field
    });
    console.log("res: ", res);
  } catch (e) {
    console.error("REFER network error:", e?.message || e);
    return { ok: false, status: 0, bodyText: `exception: ${e?.message || e}` };
  }

  const bodyText = await res.text().catch(() => "");
  const reqId = res.headers.get("x-request-id") || res.headers.get("x-openai-request-id");
  if (!res.ok) {
    console.error("REFER failed:",
      res.status,
      bodyText || "(empty body)",
      reqId ? `request-id=${reqId}` : "");
  }
  return { ok: res.ok, status: res.status, bodyText, requestId: reqId };
}





// require Twilio only if you also keep the hangup tool in this file
const twilioClient = require('twilio')(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
const tmpAgent = require('./tmp_agent.json');
const { render } = require('ejs');
// Small per-call state (used by hangup interlock; safe to keep)
const callState = new Map(); // callId -> { awaitingHangupConfirm: boolean, confirmResetTimer: NodeJS.Timeout | null }
const callMeta = new Map();
const callText = new Map();   // callId -> { user: [], agent: [] } for transcript building
const callTranscript = new Map(); // callId -> { events: [] }

// --- MUST BE ABOVE express.json/urlencoded/multer ---
app.post("/openai/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
  const client = new OpenAI({
    apiKey: process.env.REALTIME_API_KEY,
    webhookSecret: process.env.openai_webhook_secret, // whsec_...
  });

  let event;
  try {
    event = await client.webhooks.unwrap(req.body, req.headers); // Buffer, not string
    console.log("Webhook received: ", JSON.stringify(event, null, 2));
  } catch (e) {
    console.error("Invalid OpenAI webhook signature", e);
    return res.sendStatus(400);
  }

  // -----------------------
  // TEMP HARD-CODED FLOW
  // -----------------------
  function loadHardcodedAgentSpec() {
    // TEMP: replace with DB lookup by agent_id later
    return tmpAgent
  }

  function safeJson(s) {
    try { return s ? JSON.parse(s) : {}; } catch { return {}; }
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
    return flowTools
      .filter(t => (t?.type || "").toLowerCase() !== "conversation" && t?.name)
      .map(t => ({
        type: "function",
        name: String(t.name).toLowerCase(),
        description: t.description || "Custom flow tool",
        parameters: normalizeJsonSchemaForOpenAI(
          t.parameters || {
            type: "object",
            properties: {},
            additionalProperties: true
          }
        )
      }));
  }



  // -----------------------
  // MAIN HANDLER
  // -----------------------
  if (event.type === "realtime.call.incoming") {
    const callId = event.data.call_id;

    // Try to pull callSid from headers if you have it there:
    const sipHeaders = event.data.sip_headers || [];
    const callSid = getHeaderCI(sipHeaders, ["x-twilio-callsid", "x-call-sid", "call-sid"]);
    callMeta.set(callId, { callSid });

    callTranscript.set(callId, { events: [] });

    function pushEvent(callId, evt) {
      const t = callTranscript.get(callId);
      if (!t) return;
      t.events.push({
        ts: Date.now(),
        ...evt,
      });
    }

    // ---- Load spec + build instructions/tools (ONLY tools; NO flow runner)
    const agentSpec = loadHardcodedAgentSpec();
    const flow = agentSpec.conversationFlow || {};

    callText.set(callId, { user: [], agent: [] });

    // mark start time
    const startTs = Date.now();
    callMeta.set(callId, { ...(callMeta.get(callId) || {}), startTs });

    // Best-effort phone fields: if you have them in SIP headers, map them here
    // (If you don’t, omit them — Retell omits fields like metadata/dynamic vars when not provided.) :contentReference[oaicite:7]{index=7}
    const from_number =
      getHeaderCI(sipHeaders, ["from", "x-from-number", "x-caller"]) || undefined;
    const to_number =
      getHeaderCI(sipHeaders, ["to", "x-to-number", "x-called"]) || undefined;

    // Retell-like payload shape :contentReference[oaicite:8]{index=8}
    const webhookRes = await postAgentWebhookRetellStyle({
      webhookUrl: agentSpec.webhook_url,
      webhookSecret: agentSpec.webhook_secret,
      payload: {
        event: "call_started",
        call: {
          call_type: "phone_call",
          direction: "inbound",
          call_id: callId,
          agent_id: agentSpec.agent_id || agentSpec.id || "unknown",
          call_status: "registered",
          ...(from_number ? { from_number } : {}),
          ...(to_number ? { to_number } : {}),
          // include these only if you use them
          // metadata: {},
          // retell_llm_dynamic_variables: {},
          start_timestamp: startTs,
        },
      },
    });
    const dynamicVars =
      (webhookRes?.json?.retell_llm_dynamic_variables && typeof webhookRes.json.retell_llm_dynamic_variables === "object"
        ? webhookRes.json.retell_llm_dynamic_variables
        : null) ||
      (webhookRes?.json?.dynamic_variables && typeof webhookRes.json.dynamic_variables === "object"
        ? webhookRes.json.dynamic_variables
        : {});


    // callVars.set(callId, dynamicVars);

        // Build unified session config (same for inbound/outbound/web)
    const parts = buildSessionParts({
      agentSpec,
      dynamicVars,
      env: process.env,
    });

    // Phone calls still need accept
    await acceptPhoneCall({
      callId,
      apiKey: process.env.REALTIME_API_KEY,
      model: "gpt-realtime",
      instructions: parts.instructions,
    });

    // Start the unified controller (WS sideband)
    await startControlledCall({
      callId,
      agentSpec,
      dynamicVars,
      sipHeaders,
      direction: "inbound", // you can detect outbound via headers later
      callSid,
      deps: {
        apiKey: process.env.REALTIME_API_KEY,
        env: process.env,
        axios,
        twilioClient,
        postRefer, // your existing helper
      },
    });


  }

  return res.sendStatus(200);
});


function getHeaderCI(sipHeaders = [], names = []) {
  if (!Array.isArray(sipHeaders)) return null;
  const want = names.map(n => String(n).toLowerCase());
  for (const h of sipHeaders) {
    const name = (h?.name || h?.[0] || "").toLowerCase();
    if (want.includes(name)) {
      return String(h?.value ?? h?.[1] ?? "").trim();
    }
  }
  return null;
}

// Start an outbound call that will connect to OpenAI first, then to the callee
app.post('/outbound/call', async (req, res) => {
  try {
    const { to, firstName, lastName, dob } = req.body || {};

    if (!to) {
      return res.status(400).json({ error: 'Missing "to" number in body' });
    }
    if (!OUTBOUND_FROM) {
      return res.status(500).json({ error: 'OUTBOUND_FROM/TWILIO_NUMBER is not configured' });
    }
    if (!PUBLIC_HOSTNAME) {
      return res.status(500).json({ error: 'PUBLIC_HOSTNAME is not configured' });
    }

    const baseSipUri = process.env.OPENAI_SIP_URI;
    if (!baseSipUri) {
      return res.status(500).json({ error: 'OPENAI_SIP_URI is not configured' });
    }

    const enc = v => encodeURIComponent(String(v));

    // Build ONLY non-empty headers, and make sure names start with x-
    const headerParts = [];
    if (firstName) headerParts.push(`x-fname=${enc(firstName)}`);
    if (lastName) headerParts.push(`x-lname=${enc(lastName)}`);
    if (dob) headerParts.push(`x-dob=${enc(dob)}`);
    if (to) headerParts.push(`x-callee=${enc(to)}`);

    const headersQuery = headerParts.join('&');
    const sipUriWithParams = headersQuery
      ? `${baseSipUri}?${headersQuery}`
      : baseSipUri;

    const twimlUrl = `https://${PUBLIC_HOSTNAME}/twilio/outbound-twiml?to=${encodeURIComponent(to)}`;

    console.log('Starting outbound call (OpenAI first) with metadata', {
      sipUriWithParams,
      callee: to,
      from: OUTBOUND_FROM,
      twimlUrl
    });

    const call = await twilioClient.calls.create({
      to: sipUriWithParams,
      from: OUTBOUND_FROM,
      url: twimlUrl
    });

    return res.json({ sid: call.sid, status: call.status });
  } catch (err) {
    console.error('Error starting outbound call:', err);
    return res.status(500).json({ error: 'Failed to start outbound call' });
  }
});




// TwiML for outbound calls: once OpenAI answers, dial the human and bridge them
app.all('/twilio/outbound-twiml', express.urlencoded({ extended: false }), (req, res) => {
  const callee = req.query.to;

  if (!callee) {
    console.error('Missing callee "to" in query string for outbound TwiML');
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>We are unable to connect your call right now.</Say>
</Response>`);
    return;
  }

  const safeCallee = String(callee).trim();
  const callerId = OUTBOUND_FROM || process.env.TWILIO_NUMBER || '';

  console.log('Serving outbound TwiML, connecting OpenAI to callee:', safeCallee);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}"
        answerOnBridge="true"
        record="record-from-answer-dual"
        referUrl="https://voiceai.tradewindsapp.com/twilio/refer"
        referMethod="POST">
    <Number>${safeCallee}</Number>
  </Dial>
</Response>`;

  res.type('text/xml').send(twiml);
});

app.post("/webhooks/incoming-call", async (req, res) => {
  const secret = process.env.AGENT_WEBHOOK_SECRET || ""; // same secret your sender uses
  // const v = verifyRetellSignature(req, secret);
  // if (!v.ok) return res.status(401).json({ error: "invalid_signature", detail: v.reason });

  const event = req.body?.event;
  const call = req.body?.call || {};
  console.log("[INCOMING CALL WEBHOOK]", { event, call_id: call.call_id, agent_id: call.agent_id });
  console.log("req.body: ", req.body);
  // Only respond with variables for started calls (you can extend to other events)
  if (event !== "call_started") {
    // For non-start events, just ack
    return res.status(200).json({ ok: true });
  }

  // ---- SAMPLE dynamic variables for testing ----
  // Match Retell-style key: retell_llm_dynamic_variables
  // (You can name this however you want, but keep consistent with your sender/consumer.)
  const dynamic_variables = {
    firstName: "Jason",
    lastName: "Jones",
    preferredLanguage: "en",
    accountStatus: "active",
    memberId: "M-123456",
    locationName: "Lake City",
    callbackNumber: "+13865551234",
    // useful for your own debugging
    debug_call_id: call.call_id || "",
    debug_agent_id: call.agent_id || "",
    officeHours: "false"
  };

  // Optional metadata object (often echoed into logs / downstream)
  const metadata = {
    testMode: true,
    receivedAt: new Date().toISOString(),
    from_number: call.from_number,
    to_number: call.to_number,
  };


  return res.status(200).json({
    dynamic_variables,
    metadata,
  });
});


// #endregion

// #region Start server
app.use((req, res, next) => {
  res.status(404).send('404 Not Founded');
});

app.listen(port, () => {
  console.log(`Realtime app listening at http://localhost:${port}`);
});


// #endregion

// #region Helper Functions
function requireAuth(req, res, next) {
  if (!req.session.user) {
    console.log('user: ', JSON.stringify(req.session.user));
    return res.redirect('/sso.html');
  }
  next();
}

function addFormattedDOB(contacts) {
  return contacts.map(contact => {
    const dob = contact.dateOfBirth
      ? new Date(contact.dateOfBirth).toLocaleDateString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      })
      : null;
    return { ...contact, dob };
  });
}



// #endregion





async function runCustomTool(ctx) {
  const tool = ctx.toolDef;
  const timeout = tool.timeout_ms || 120000;
  const args = ctx.toolArgs || {};

  // args_at_root: if false, you might want to wrap args, but your sample is true
  const body = tool.args_at_root ? args : { args };

  const resp = await ctx.axios({
    method: tool.method || "POST",
    url: tool.url,
    headers: tool.headers || {},
    params: tool.query_params || {},
    data: body,
    timeout,
    validateStatus: () => true
  });
  console.log("resp: ", resp);
  if (resp.status >= 200 && resp.status < 300) {
    return { ok: true, status: resp.status, data: resp.data };
  }
  return { ok: false, status: resp.status, data: resp.data };
}


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

  // Replace {{ key }} with vars[key] (supports dot paths like {{patient.firstName}})
  return str.replace(/{{\s*([^}]+?)\s*}}/g, (match, key) => {
    const val = getByPath(vars, key);
    if (val === undefined || val === null) return match; // leave placeholder if not found
    if (typeof val === "object") return JSON.stringify(val); // object -> JSON string
    return String(val);
  });
}

function deepRenderMustache(input, vars) {
  if (input == null) return input;

  if (typeof input === "string") {
    return renderMustacheString(input, vars);
  }

  if (Array.isArray(input)) {
    return input.map(v => deepRenderMustache(v, vars));
  }

  if (typeof input === "object") {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = deepRenderMustache(v, vars);
    }
    return out;
  }

  // numbers/booleans/etc
  return input;
}




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
      try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }

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


function toPlainTranscript(events) {
  // only user + agent
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
      if (e.type === "tool_call") {
        return {
          role: "tool",
          tool_event: "call",
          name: e.name,
          args: e.args,
          timestamp: e.ts
        };
      }
      if (e.type === "tool_result") {
        return {
          role: "tool",
          tool_event: "result",
          name: e.name,
          output: e.output,
          timestamp: e.ts
        };
      }
      return null;
    })
    .filter(Boolean);
}
