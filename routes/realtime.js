// routes/realtime.js (or wherever you keep routes)
const express = require("express");
const router = express.Router();
const crypto = require("crypto");

// If you're already using axios in your app, use it.
// Otherwise Node 18+ has global fetch.
const axios = require("axios");

const OPENAI_API_KEY = process.env.REALTIME_API_KEY;

// OPTIONAL: tighten this to your real embed origins
const ALLOWED_ORIGINS = new Set([
    "https://voiceai.tradewindsapp.com",
    "https://app.novelcrm.com",
    "http://localhost:5173",
]);


function enforceOrigin(req, res, next) {
    const origin = req.headers.origin;
    // If you're not embedding cross-origin, you can relax/remove this.
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return res.status(403).json({ error: "Origin not allowed" });
    }
    return next();
}

const ephemStore = new Map();

function newEphemId() {
    return crypto.randomBytes(16).toString("hex");
}

function pruneEphemStore() {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, rec] of ephemStore.entries()) {
        if (!rec?.expiresAt || rec.expiresAt <= now) {
            ephemStore.delete(id);
        }
    }
}
// OPTIONAL: basic auth gate so randoms can't mint secrets
// Replace with your tenant/session auth (JWT, cookie session, etc.)
function requireAuth(req, res, next) {
    // Example: require an internal header from your app
    // if (req.headers["x-internal-key"] !== process.env.INTERNAL_KEY) ...
    return next();
}
router.get("/ping", (req, res) => {
    return res.json({ message: "pong" });
});
router.post("/web-session", async (req, res) => {
    try {
        pruneEphemStore();

        const apiKey = process.env.REALTIME_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: "Missing REALTIME_API_KEY" });
        }

        const headers = {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        };

        if (process.env.REALTIME_VOICE_PROJECT_ID) {
            headers["OpenAI-Project"] = process.env.REALTIME_VOICE_PROJECT_ID;
        }

        const body = {
            expires_after: { anchor: "created_at", seconds: 600 },
            session: {
                type: "realtime",
                model: "gpt-realtime"
            }
        };

        const r = await fetch(
            "https://api.openai.com/v1/realtime/client_secrets",
            {
                method: "POST",
                headers,
                body: JSON.stringify(body),
            }
        );

        const text = await r.text().catch(() => "");
        let json;
        try { json = JSON.parse(text); } catch { json = null; }

        if (!r.ok) {
            console.error("[web-session] mint failed:", r.status, text);
            return res.status(500).json({
                error: "Failed to mint client secret",
                details: json || text
            });
        }

        // Support both response shapes:
        // A) { value, expires_at, session }
        // B) { client_secret: { value, expires_at }, ... }
        const value =
            json?.value ||
            json?.client_secret?.value ||
            json?.client_secret?.client_secret?.value;

        const expiresAt =
            json?.expires_at ||
            json?.client_secret?.expires_at ||
            json?.client_secret?.client_secret?.expires_at;

        if (!value) {
            console.error("[web-session] unexpected response:", json);
            return res.status(500).json({
                error: "Failed to mint client secret",
                details: { message: "client secret value missing", json }
            });
        }

        if (!value) {
            console.error("[web-session] unexpected response:", json);
            return res.status(500).json({
                error: "Failed to mint client secret",
                details: { message: "client_secret.value missing", json }
            });
        }

        const ephemId = newEphemId();
        ephemStore.set(ephemId, { value, expiresAt });

        return res.json({
            ephemId,
            client_secret: {
                value,
                expires_at: expiresAt
            },
            // optional: pass session through if you want to debug
            // session: json?.session
        });
    } catch (e) {
        console.error("[web-session] exception:", e);
        res.status(500).json({
            error: "Failed to mint client secret",
            details: { message: e?.message || String(e) }
        });
    }
});



const { startControlledCall } = require("../realtime_controller");

// TEMP: replace with DB lookup later
const tmpAgent = require("../tmp_agent.json");

router.post("/attach", async (req, res) => {
    try {
        const { callId, ephemId } = req.body || {};
        if (!callId) return res.status(400).json({ error: "callId required" });
        if (!ephemId) return res.status(400).json({ error: "ephemId required" });

        const rec = router._ephemStore.get(ephemId);
        if (!rec) {
            return res.status(401).json({
                error: "ephemeral key expired or missing — refresh web session"
            });
        }

        const ephemeralKey = rec.value;

        const agentSpec = require("../tmp_agent.json");
        const dynamicVars = {};

        await startControlledCall({
            callId,
            agentSpec,
            dynamicVars,
            sipHeaders: [],
            direction: "web",
            callSid: null,
            deps: {
                apiKey: ephemeralKey,   // 🔑 THIS IS THE IMPORTANT PART
                env: process.env,
                axios: require("axios"),
                twilioClient: null,
                postRefer: null,
            },
        });

        res.json({ ok: true });

    } catch (e) {
        console.error("[attach] error:", e);
        res.status(500).json({ error: e?.message || String(e) });
    }
});


router._ephemStore = ephemStore;
module.exports = router;

