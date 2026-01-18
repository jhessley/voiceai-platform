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


// DB + Novel factory (NEW)

const { OpenAI } = require('openai');
const WebSocket = require('ws');
const app = express();

const port = 1923;


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
app.use((req, res, next) => {
  console.log("voiceai");
  next();
});

// #endregion

// #region Root & Test Routes
app.get('/', (req, res) => {
  res.send('Welcome to voice ai app!');
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

// Small per-call state (used by hangup interlock; safe to keep)
const callState = new Map(); // callId -> { awaitingHangupConfirm: boolean, confirmResetTimer: NodeJS.Timeout | null }
// --- MUST BE ABOVE express.json/urlencoded/multer ---
app.post("/openai/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
  const client = new OpenAI({
    apiKey: process.env.REALTIME_API_KEY,
    webhookSecret: process.env.openai_webhook_secret, // whsec_...
  });

  let event;
  try {
    event = await client.webhooks.unwrap(req.body, req.headers); // Buffer, not string
    console.log("Webhook received: ", event.data.sip_headers);
    // console.log("event:", event.type);
  } catch (e) {
    console.error("Invalid OpenAI webhook signature", e);
    return res.sendStatus(400);
  }

  if (event.type === "realtime.call.incoming") {
    const callId = event.data.call_id;
    const sipHeaders = event.data.sip_headers || [];

    const fName = getHeaderCI(sipHeaders, ["x-fname"]);
    const lName = getHeaderCI(sipHeaders, ["x-lname"]);
    const dob = getHeaderCI(sipHeaders, ["x-dob"]);
    const callee = getHeaderCI(sipHeaders, ["x-callee"]);

    console.log("Caller metadata from SIP headers:", {
      fName,
      lName,
      dob,
      callee
    });

    const acceptUrl = `https://api.openai.com/v1/realtime/calls/${callId}/accept`;
    const referUrl = `https://api.openai.com/v1/realtime/calls/${callId}/refer`;
    const VOICE = process.env.VOICE || "marin";
    const GREETING = process.env.GREETING || "Thanks for calling Island Doctors. How can I help you today?";
    const CLOSING = process.env.CLOSING_LINE || "Thanks for calling NovelCRM. Have a great day! Goodbye.";
    const HANGUP_DELAY = Number(process.env.DELAY_BEFORE_HANGUP_MS || 1200);
    const TRANSFER_DELAY = Number(process.env.TRANSFER_DELAY_MS || 800);
    const TRANSFER_NUM = process.env.TRANSFER_NUMBER || "+13869653832"; // 888-555-1234
    const instructions = `Current time: {{current_time_{{my_timezone}} }}
If asked, speak the language that the user prefers.
## The patient you are attempting to reach
First Name: ${decodeURIComponent(fName || "")}
Last Name: ${decodeURIComponent(lName || "")}
## Identity
You are Betty from Island Doctors calling former patients over the phone to understand why they left the practice. You are a professional and friendly patient advocate. 

## Style Guardrails
Be Concise: Respond succinctly, addressing one topic at most.
Embrace Variety: Use diverse language and rephrasing to enhance clarity without repeating content.
Be Conversational: Use simple language, making the chat feel like talking to a trusted professional advocate.
Avoid multiple questions in a single response.
When asking if we can do something for the user, avoid phrasing that asks if they 'want' something such as 'would you like us to...' instead use phrasing that asks permission such as 'Can we...'.
Get clarity: If the user only partially answers a question, or if the answer is unclear, keep asking to get clarity.
Use a colloquial way of referring to the date (like Friday, January 14th, or Tuesday, January 12th, 2024 at 8am).

## Response Guideline
Adapt and Guess: Try to understand transcripts that may contain transcription errors. Avoid mentioning "transcription error" in the response.
Stay in Character: Keep conversations within your role's scope, guiding them back creatively without repeating.
Ensure Fluid Dialogue: Respond in a role-appropriate, direct manner to maintain a smooth conversation flow.

## Task
You will follow the steps below, do not skip steps, and only ask up to one question in response.

1. Begin with a self-introduction and verify if you are speaking to the correct person.
  
2. Explain that This is a quick member feedback call from Island Doctors. We want to be sure that you're receiving the best possible care but we've noticed that you're no longer relying on us for your primary care.  Would you mind having a quick discussion about the events that led up to you changing your primary care provider?
    Responses:
    If the user agrees, continue.
    If the user objects based on time like 'not now', 'I'm busy', 'maybe later', 'some other time' Empathize and ask when they would like a call back. Leave the question open ended. Don't make any suggestions. Once they provide any suggestion, say thank you and ask if they want you to hang up now. Do not ask for a more specific time than they provided.  Any suggestion should be accepted.
    If the user begins to tell you about their experience, assume they have agreed to discuss and continue.
    If the user says they do not want to talk, thank them for their time ask if they want you to hang up now.

3. Goal: Understand why the patient left, identify any service issues, and invite them to consider returning if appropriate. Ask short open ended questions without offering any suggestions on what the answer might be. 
  example: “Can you tell us why you left Island Doctors?

  Silently Categorize the reason they left as:
  Service Issue - they were dissatisfied with the quality of care or something happened that made them unhappy with the service.
  Circumstance Change - Something changed that caused them to leave such as: the patient moved, the office closed, Insurance requirements.
  Patient Unaware - The patient did not know that their provider was changed or did not know why their provider was changed. This can happen sometimes when changes are made to their insurance plan.

  Do not say the category.

  If the reason they left is a Service Issue, empathize with them without being apologetic. Ask no more than two open ended follow up question about their concerns. Assure them that we want to correct any issues that led to their being unhappy. Provide one of the Reasons To Stay if applicable. Ask them if you can get a patient advocate on the line right now (this will be a transfer but don't refer to it that way) to better serve them. Don't offer any promises or solutions other than a call from the advocate. Never say we'll make sure it doesn't happen again or offer any other indication of steps to be taken.

  If the reason they left is a Circumstance Change, assure them that we enjoyed having them as a member and ask if they would stick with us if not for the circumstance. Ask them if you can get a patient advocate on the line right now (this will be a transfer but don't refer to it that way) to better understand what changed. Don't offer any promises or solutions other than a call from the advocate.

  If the reason they left is a Patient Unaware, explain that sometimes things get changed unexpectedly. Ask them if you can get a patient advocate on the line right now (this will be a transfer but don't refer to it that way) to better understand what happened. Don't offer any promises or solutions other than a call from the advocate.

4. Ask if we were able to address your concerns, would you consider returning to Island Doctors for your care?

    If they say no, skip to step 7.

    Based on their previous responses suggest a reason they should stay with island doctors that makes sense for their concerns. The goal is to encourge them to stay without being pushy. If none of the Reasons To Stay fit the user's concerns, skip this step and continue.

5. While you were with us, how satisfied were you with your doctor and our office staff?

6. Based on your experience, would you recommend Island Doctors to a friend or family member?

7. Just so you know — you’ll always have a place here if you decide to come back. We accept many Medicare Advantage plans and can help make switching back easy.

8. Can a member of our Patient Advocacy Team call you later to help ensure that you are receiving the best care that you deserve?

    If they say yes, verify if we should call them on this same number or get the number they prefer to be called on. Ask one question at a time. Ask if there is a prefered time for someone to call. Thank them for their time and ask if they have any other question or if they want to hang up now.

    If they say no, thank them for their time and say goodbye.


    ## Reasons To Stay
    You get same day walk-ins (moultree area), 
    Stick with the doctor you know
     Did they get bloodwork, semiglutide, work-out classes (like Tai Chi, silver sneakers cert)
     Focus on the patient relationships with the existing staff and clinics.
     Catered health delivery, now have electronic health records 
     Not owned by private equity, not a huge corporation, 
     tying modern medicine with old fashioned community clinics, been here for 30 years, 
     patient centric focus, large hispanic patient population,
     free vitamins are offered to all patients `

    // Optional: Twilio CallSid if you keep the hangup tool
    const callSid = getHeaderCI(event.data.sip_headers, ["x-twilio-callsid", "x-callsid", "callsid"]);
    // console.log("Twilio CallSid:", callSid || "(not found)");

    // --- Tools (Hello World, Hangup interlock, NEW: Transfer) ---
    const TOOL_DEFS = [
      {
        type: "function",
        name: "get_phrase_of_the_day",
        description: "Returns the phrase of the day for this call.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        type: "function",
        name: "end_the_call",
        description: "Request to end the phone call. Must be confirmed by the caller.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        type: "function",
        name: "transfer_to_specialist",
        description: `Transfer the call to a live agent at ${TRANSFER_NUM}.`,
        parameters: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        type: "function",
        name: "change_voice",
        description: `Change the voice of the agent..`,
        parameters: { type: "object", properties: { voice: { type: "string", enum: ["marin", "alloy", "ballad", "ash"], description: "Voice" } }, additionalProperties: false }
      },
      {
        type: "function",
        name: "post_json_endpoint",
        description: "Post a JSON payload to an endpoint URL when something important happens in the call. If the endpoint responds with JSON containing a 'message' field, you should read that message back to the caller.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Destination endpoint URL. If omitted, use the default WEBHOOK_URL."
            },
            event: {
              type: "string",
              description: "Short name describing what triggered this endpoint, e.g. 'patient_left_service_issue'."
            },
            payload: {
              type: "object",
              description: "Additional JSON data to send with the event.",
              additionalProperties: true
            }
          },
          required: ["event"],
          additionalProperties: false
        }
      }

    ];

    // --- Accept (minimal) ---
    const acceptRes = await fetch(acceptUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REALTIME_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "realtime",
        model: "gpt-realtime",
        instructions: instructions,

      }),
    });
    if (!acceptRes.ok) {
      const body = await acceptRes.text().catch(() => "");
      console.error("ACCEPT failed:", acceptUrl, acceptRes.status, body);
      return res.sendStatus(500);
    }


    // --- WS connect & drive session ---
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?call_id=${callId}`,
      { headers: { Authorization: `Bearer ${process.env.REALTIME_API_KEY}` } }
    );

    const pending = new Map(); // function call_id -> { name, args: "" }

    ws.on("open", () => {
      console.log("WS open; set voice + tools, then greet...");
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          audio: {
            // input: {
            //   turn_detection: {
            //     type: "semantic_vad",
            //     "eagerness": "low",
            //     // optional tuning knobs – examples:
            //     // threshold: 0.5,
            //     // prefix_padding_ms: 200,
            //     // silence_duration_ms: 300
            //   }
            // },
            output: {
              voice: VOICE
            }
          }, // SIP-friendly placement
          tools: TOOL_DEFS,
          instructions: instructions

        }
      }));

      setTimeout(() => {
        ws.send(JSON.stringify({
          type: "response.create",
          response: { instructions: GREETING }
        }));
      }, 300);
    });
    const callReady = new Map(); // callId -> { ready: boolean };
    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // if (msg?.type) console.log("RT event:", msg.type);
      if (msg?.type === "error") { console.error("RT error:", JSON.stringify(msg)); return; }
      if (msg?.type === "response.done" || msg?.type === "output_audio_buffer.started") {
        const s = callReady.get(callId) || { ready: false };
        s.ready = true;
        callReady.set(callId, s);
      }

      // Tool call started
      if (msg.type === "response.output_item.added" && msg.item?.type === "function_call") {
        const { call_id, name } = msg.item;
        pending.set(call_id, { name, args: "" });
      }

      // Args streaming (unused for no-arg tools; handled anyway)
      if (msg.type === "response.function_call_arguments.delta") {
        const rec = pending.get(msg.call_id);
        if (rec) rec.args += msg.delta || "";
      }
      if (msg.type === "response.created" && msg.response?.id) {
        const st = callState.get(callId) || {};
        st.lastResponseId = msg.response.id;
        callState.set(callId, st);
      }

      // mark speaking on/off
      if (msg.type === "output_audio_buffer.started") {
        const st = callState.get(callId) || {};
        st.speaking = true;
        callState.set(callId, st);
      }

      if (msg.type === "output_audio_buffer.stopped") {
        const st = callState.get(callId) || {};
        st.speaking = false;

        // if a voice change was requested while speaking, apply it now
        if (st.pendingVoice) {
          const v = st.pendingVoice;
          st.pendingVoice = null;
          callState.set(callId, st);

          ws.send(JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              model: "gpt-realtime",
              audio: { output: { voice: v } }
            }
          }));

          // optional: brief confirmation in the new voice
          ws.send(JSON.stringify({
            type: "response.create",
            response: { instructions: `Okay—I'll continue in the ${v} voice.` }
          }));
        } else {
          callState.set(callId, st);
        }
      }

      // Tool call ready
      if (msg.type === "response.function_call_arguments.done") {
        const rec = pending.get(msg.call_id);
        if (!rec) return;

        let result;
        const state = callState.get(callId) || { awaitingHangupConfirm: false, confirmResetTimer: null };


        try {
          if (rec.name === "get_phrase_of_the_day") {
            result = { phrase: "Hello World" };


          } else if (rec.name === "change_voice") {
            // Parse args safely
            let args = {};
            try { args = rec.args ? JSON.parse(rec.args) : {}; } catch { }
            const requested = String(args.voice || "").toLowerCase();

            const allowed = new Set(["marin", "alloy", "ballad", "ash"]);
            if (!allowed.has(requested)) {
              result = { ok: false, error: `Unsupported voice "${requested}". Allowed: marin, alloy, ballad, ash.` };
            } else {
              const st = callState.get(callId) || {};
              if (st.speaking) {
                // Queue the change; apply when audio stops
                st.pendingVoice = requested;
                callState.set(callId, st);
                result = {
                  ok: true,
                  queued: true,
                  voice: requested,
                  message: `Voice change queued; will switch after the current line finishes.`
                };
              } else {
                // Apply immediately
                ws.send(JSON.stringify({
                  type: "session.update",
                  session: {
                    type: "realtime",
                    model: "gpt-realtime",
                    audio: { output: { voice: requested } }
                  }
                }));
                result = { ok: true, queued: false, voice: requested, message: `Voice changed to ${requested}.` };

                // Optional: confirm audibly right away (in the new voice)
                ws.send(JSON.stringify({
                  type: "response.create",
                  response: { instructions: `Switching to the ${requested} voice.` }
                }));
              }
            }
          } else if (rec.name === "end_the_call") {
            // Two-step interlock
            if (!state.awaitingHangupConfirm) {
              state.awaitingHangupConfirm = true;
              if (state.confirmResetTimer) clearTimeout(state.confirmResetTimer);
              state.confirmResetTimer = setTimeout(() => {
                const s = callState.get(callId);
                if (s) s.awaitingHangupConfirm = false;
              }, 45000);
              callState.set(callId, state);

              result = { ok: false, pending: true, message: "Awaiting explicit user confirmation to hang up." };

              ws.send(JSON.stringify({
                type: "response.create",
                response: { instructions: "I’m happy to wrap up. Would you like me to disconnect the call now?" }
              }));

              // We'll still fall through to send function_call_output below, then return.

            } else {
              if (!callSid) {
                result = { ok: false, error: "No Twilio CallSid available to complete the call." };
              } else {
                result = { ok: true, ended: true };
                ws.send(JSON.stringify({
                  type: "response.create",
                  response: { instructions: CLOSING }
                }));
                setTimeout(async () => {
                  try { await twilioClient.calls(callSid).update({ status: "completed" }); }
                  catch (e) { console.error("Twilio hangup failed:", e?.message || e); }
                }, HANGUP_DELAY);
              }
              state.awaitingHangupConfirm = false;
              if (state.confirmResetTimer) clearTimeout(state.confirmResetTimer);
              callState.set(callId, state);
            }

          } else if (rec.name === "transfer_to_specialist") {
            const TARGET_URI =
              process.env.TRANSFER_URI || `tel:${TRANSFER_NUM}`; // try SIP URI via env if tel: keeps 400'ing

            // Immediately acknowledge the tool call so we never hit "Missing item.output"
            const toolAck = { ok: true, transferring: true, target: TARGET_URI };
            ws.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: msg.call_id,
                output: JSON.stringify(toolAck)
              }
            }));

            // Speak the handoff line
            ws.send(JSON.stringify({
              type: "response.create",
              response: { instructions: "One moment while I connect you to a specialist." }
            }));

            const settleDelay = Number(process.env.TRANSFER_DELAY_MS || 1500);
            setTimeout(async () => {
              if (!(callReady.get(callId) || {}).ready) {
                await new Promise(r => setTimeout(r, 900));
              }
              console.log("Issuing REFER to:", TARGET_URI);
              const referRes = await postRefer({ callId, targetUri: TARGET_URI });
              console.error("referRes:", referRes); // includes status and any body text/request-id
            }, settleDelay);

            pending.delete(msg.call_id);
            return;
          } else if (rec.name === "post_json_endpoint") {
            let args = {};
            try { args = rec.args ? JSON.parse(rec.args) : {}; } catch { }

            const defaultUrl = process.env.WEBHOOK_URL || 'https://httpbin.org/post';
            const url = args.url || defaultUrl;

            if (!url) {
              result = { ok: false, error: "No webhook URL provided and WEBHOOK_URL is not set." };
            } else {
              // Build a sample payload, merging any model-provided payload
              const basePayload = {
                source: "voiceai.tradewindsapp.com",
                event: args.event || "unknown_event",
                callId,
                timestamp: new Date().toISOString()
              };

              const extraPayload = (args.payload && typeof args.payload === "object")
                ? args.payload
                : {};

              const finalPayload = { ...basePayload, ...extraPayload };

              try {
                const resp = await axios.post(url, finalPayload, {
                  headers: { "Content-Type": "application/json" },
                  timeout: 5000
                });

                console.log("post_json_endpoint success:", {
                  url,
                  status: resp.status
                });

                // Extract a friendly message for the model to read
                let msgText = "";
                if (resp.data && typeof resp.data === "object" && resp.data.message) {
                  // Your /test/endpoint returns { message: "...", receivedData: {...} }
                  msgText = String(resp.data.message);
                } else if (typeof resp.data === "string") {
                  msgText = resp.data.slice(0, 200);
                } else {
                  msgText = JSON.stringify(resp.data).slice(0, 200);
                }

                result = {
                  ok: true,
                  url,
                  status: resp.status,
                  message: msgText    // <-- this is what the agent should speak
                };
              } catch (err) {
                console.error("post_json_endpoint error:", {
                  url,
                  message: err.message,
                  status: err.response?.status,
                  data: err.response?.data
                });

                result = {
                  ok: false,
                  url,
                  status: err.response?.status || 0,
                  error: err.message
                };
              }

            }
          } else {
            result = { error: `Unknown tool: ${rec.name}` };
          }
        } catch (err) {
          result = { error: String(err?.message || err) };
        }

        // Send tool result back to the model
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: msg.call_id,
            output: JSON.stringify(result)
          }
        }));

        // Decide whether to continue the model speaking:
        const ended = (rec.name === "end_the_call" && result.ok === true && result.ended === true);
        const transferred = (rec.name === "transfer_to_specialist" && result.ok === true);
        if (!(ended || transferred)) {
          ws.send(JSON.stringify({ type: "response.create" }));
        }

        pending.delete(msg.call_id);
      }
    });

    ws.on("close", () => {
      console.log("Realtime WS closed");
      const s = callState.get(callId);
      if (s?.confirmResetTimer) clearTimeout(s.confirmResetTimer);
      callState.delete(callId);
    });

    ws.on("error", (err) => console.error("Realtime WS error:", err));
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




// #endregion

// #region Start server
app.use((req, res, next) => {
  res.status(404).send('404 Not Found');
});

app.listen(port, () => {
  console.log(`MedDocs app listening at http://localhost:${port}`);
});

// Graceful shutdown for DB (NEW)
process.on('SIGINT', async () => { try { await db.close(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await db.close(); } finally { process.exit(0); } });
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

let customFieldsDefinition = null;

async function flattenContacts(location, contacts, appName = 'defaultApp') {
  const output = [];

  for (const contact of contacts) {
    // Ensure custom field definitions are loaded
    if (!customFieldsDefinition) {
      customFieldsDefinition = await novel.getCustomFieldsByLocation(
        location,
        appName,
        'contact'
      );
    }

    const flatContact = { ...contact };
    delete flatContact.customFields;

    for (const field of contact.customFields || []) {
      const fieldDef = customFieldsDefinition.customFields.find(def => def.id === field.id);
      if (fieldDef && fieldDef.fieldKey && fieldDef.fieldKey.startsWith('contact.')) {
        const fieldKeyName = fieldDef.fieldKey.split('contact.')[1]; // e.g., 'reorder_products'
        flatContact[fieldKeyName] = field.value;
      }
    }

    output.push(flatContact);
  }
  return output;
}
// #endregion
const nodeExecutors = {
  // node.type === "conversation"
  async conversation(ctx, node) {
    // node.instruction.type: "prompt" | "static_text"
    // Send a response.create with the instruction text
    const text =
      node.instruction?.type === "static_text"
        ? renderTemplate(node.instruction.text, ctx.vars)
        : node.instruction?.text;

    await ctx.wsSend({
      type: "response.create",
      response: { instructions: text || "" }
    });

    return { next: pickNextNodeId(ctx, node) };
  },

  // node.type === "function" (your "local tool" concept in flow)
  async function(ctx, node) {
    // find tool by node.tool_id or node.name
    const tool = ctx.toolsById[node.tool_id] || ctx.toolsByName[node.name?.toLowerCase()];
    if (!tool) return { error: `Tool not found for node ${node.id}` };

    // call the tool via your existing "custom webhook" runner (HTTP POST)
    const result = await runCustomTool(ctx, tool);

    // store response variables if needed
    ctx.vars = { ...ctx.vars, ...result.variables };

    return { next: pickNextNodeId(ctx, node), result };
  },

  async transfer_call(ctx, node) {
    // reuse your existing postRefer() approach
    const number = node.transfer_destination?.number;
    const targetUri = number ? `tel:${number}` : (process.env.TRANSFER_URI || null);
    if (!targetUri) return { error: "No transfer target" };

    await ctx.wsSend({ type: "response.create", response: { instructions: node.instruction?.text || "Transferring now." } });
    await ctx.defer(async () => ctx.postRefer({ callId: ctx.callId, targetUri }), Number(process.env.TRANSFER_DELAY_MS || 1500));

    return { stop: true }; // stop further model generation after transfer
  },

  async end(ctx, node) {
    await ctx.wsSend({ type: "response.create", response: { instructions: node.instruction?.text || "Goodbye." } });
    // optionally also hang up via Twilio callSid if you have it
    return { endConversation: true };
  },

  // extract_dynamic_variables nodes: you can implement this in two ways:
  // 1) run an LLM extraction step (tool-free) and fill ctx.vars
  // 2) treat it as “routing logic” handled by your app
  async extract_dynamic_variables(ctx, node) {
    // simplest: call the model to output JSON variables, then set ctx.vars and pick edge by equations
    const extracted = await runExtraction(ctx, node.variables);
    ctx.vars = { ...ctx.vars, ...extracted };
    return { next: pickNextNodeId(ctx, node) };
  }
};

async function runCustomTool(ctx, tool) {
  // tool.args_at_root true means incoming args go at root.
  // In your JSON tool schema, args is nested under { name, args }.
  // Pick one convention and normalize here.

  const payload = ctx.toolArgs; // <- the args the model provided for THIS tool
  const timeout = tool.timeout_ms || 120000;

  const resp = await ctx.axios({
    method: tool.method || "POST",
    url: tool.url,
    headers: tool.headers || {},
    params: tool.query_params || {},
    data: payload,
    timeout
  });

  // Decide what to return into the flow vars
  // Example: webhook returns { nearbyLocations: [...], updated: true }
  return {
    raw: resp.data,
    variables: resp.data && typeof resp.data === "object" ? resp.data : {}
  };
}
