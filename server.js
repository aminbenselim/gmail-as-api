import crypto from "crypto";
import fs from "fs";
import path from "path";
import express from "express";
import "dotenv/config";
import { google } from "googleapis";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const MailComposer = require("nodemailer/lib/mail-composer");

const BODY_LIMIT = "25mb";
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DATA_DIR = path.resolve("data");
const TOKENS_PATH = path.join(DATA_DIR, "tokens.json");

const app = express();
app.use(express.json({ limit: BODY_LIMIT }));

const PORT = 3000;
const { API_KEY, FROM_EMAIL } = process.env;

if (!API_KEY) {
  console.error("Missing API_KEY in .env");
  process.exit(1);
}
if (!FROM_EMAIL) {
  console.error("Missing FROM_EMAIL in .env (use your Gmail address or alias)");
  process.exit(1);
}

let cachedAuthClient = null;
const oauthStates = new Map();
const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function loadOAuthClient() {
  if (cachedAuthClient) return cachedAuthClient;

  if (!fs.existsSync(TOKENS_PATH)) {
    throw new Error(
      `tokens.json not found at ${TOKENS_PATH}. Run: npm run auth or visit /auth/start.`
    );
  }

  const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
  if (!tokens.refresh_token) {
    throw new Error("tokens.json missing refresh_token. Re-run auth with prompt=consent.");
  }

  const oAuth2Client = createOAuthClient();
  oAuth2Client.setCredentials(tokens);

  oAuth2Client.on("tokens", (newTokens) => {
    if (!newTokens.access_token && !newTokens.refresh_token) return;
    const merged = { ...oAuth2Client.credentials, ...newTokens };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(merged, null, 2));
    } catch (err) {
      console.warn("Failed to update tokens.json:", err.message);
    }
  });

  cachedAuthClient = oAuth2Client;
  return cachedAuthClient;
}

function createOAuthClient() {
  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Missing Google OAuth env vars");
  }

  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function formatAddress(address, name) {
  if (!address) return undefined;
  if (!name) return address;
  return { name, address };
}

function parseDataUrl(value) {
  if (typeof value !== "string") return null;
  const match = /^data:([^;]+);base64,(.+)$/i.exec(value);
  if (!match) return null;
  return { contentType: match[1], contentBase64: match[2] };
}

function normalizeAttachments(input) {
  if (!input) return undefined;
  if (!Array.isArray(input)) {
    throw new ValidationError("attachments must be an array");
  }

  return input.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object") {
      throw new ValidationError(`attachments[${index}] must be an object`);
    }

    const {
      filename,
      content,
      contentBase64,
      contentType,
      encoding,
      cid,
      contentDisposition
    } = attachment;

    if (!filename) {
      throw new ValidationError(`attachments[${index}].filename is required`);
    }

    let finalContent = content;
    let finalEncoding = encoding;
    let finalContentType = contentType;

    const dataUrl = parseDataUrl(finalContent);
    if (dataUrl) {
      finalContent = dataUrl.contentBase64;
      finalEncoding = "base64";
      finalContentType = finalContentType || dataUrl.contentType;
    }

    if (!finalContent && contentBase64) {
      finalContent = contentBase64;
      finalEncoding = finalEncoding || "base64";
    }

    if (!finalContent) {
      throw new ValidationError(`attachments[${index}].content or contentBase64 is required`);
    }

    const normalized = {
      filename,
      content: finalContent
    };

    if (finalEncoding) normalized.encoding = finalEncoding;
    if (finalContentType) normalized.contentType = finalContentType;
    if (cid) normalized.cid = cid;
    if (contentDisposition) normalized.contentDisposition = contentDisposition;

    return normalized;
  });
}

function normalizeHeaders(headers) {
  if (!headers) return undefined;
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new ValidationError("headers must be an object");
  }

  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    normalized[key] = String(value);
  }

  return normalized;
}

function cleanupStates() {
  const now = Date.now();
  for (const [state, meta] of oauthStates.entries()) {
    if (now - meta.createdAt > AUTH_STATE_TTL_MS) {
      oauthStates.delete(state);
    }
  }
}

function buildMimeMessage(mail) {
  return new Promise((resolve, reject) => {
    mail.compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message);
    });
  });
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/auth/start", (req, res) => {
  try {
    cleanupStates();

    const state = crypto.randomBytes(16).toString("hex");
    oauthStates.set(state, { createdAt: Date.now() });

    const oAuth2Client = createOAuthClient();
    const url = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state
    });

    res.redirect(url);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query || {};
    if (error) {
      return res.status(400).send("Authorization failed.");
    }
    if (!code || !state) {
      throw new ValidationError("Missing code or state.");
    }

    const stored = oauthStates.get(state);
    if (!stored) {
      throw new ValidationError("Invalid or expired state.");
    }
    oauthStates.delete(state);

    const oAuth2Client = createOAuthClient();
    const { tokens } = await oAuth2Client.getToken(String(code));

    const existing = fs.existsSync(TOKENS_PATH)
      ? JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"))
      : {};
    const merged = { ...existing, ...tokens };

    if (!merged.refresh_token) {
      throw new Error("No refresh token received. Revoke app and retry.");
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(merged, null, 2));

    res.send("Authorization successful. You can now use /send.");
  } catch (e) {
    if (e instanceof ValidationError) {
      return res.status(400).send(e.message);
    }
    res.status(500).send(e.message);
  }
});

app.post("/send", async (req, res) => {
  try {
    const key = req.header("x-api-key");
    if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });

    const {
      to,
      subject,
      text,
      html,
      cc,
      bcc,
      replyTo,
      replyToName,
      fromName,
      headers,
      inReplyTo,
      references,
      messageId,
      priority,
      attachments
    } = req.body || {};

    const normalizedHeaders = normalizeHeaders(headers);
    const normalizedAttachments = normalizeAttachments(attachments);
    const hasAttachments =
      Array.isArray(normalizedAttachments) && normalizedAttachments.length > 0;

    if (!to || !subject || (!text && !html && !hasAttachments)) {
      throw new ValidationError("Require: to, subject, and text/html or attachments");
    }

    const auth = loadOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    const formattedFrom = formatAddress(FROM_EMAIL, fromName);
    const formattedReplyTo = formatAddress(replyTo, replyToName);

    const mail = new MailComposer({
      to,
      cc,
      bcc,
      replyTo: formattedReplyTo,
      from: formattedFrom,
      subject,
      text,
      html,
      headers: normalizedHeaders,
      inReplyTo,
      references,
      messageId,
      priority,
      attachments: normalizedAttachments
    });

    const mime = await buildMimeMessage(mail);
    const raw = base64UrlEncode(mime);

    const resp = await gmail.users.messages.send({
      userId: "me",
      resource: { raw }
    });

    res.json({ id: resp?.data?.id, threadId: resp?.data?.threadId });
  } catch (e) {
    if (e instanceof ValidationError) {
      return res.status(400).json({ error: e.message });
    }
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});
