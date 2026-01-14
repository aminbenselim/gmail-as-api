import fs from "fs";
import express from "express";
import "dotenv/config";
import { google } from "googleapis";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const MailComposer = require("nodemailer/lib/mail-composer");

const BODY_LIMIT = process.env.BODY_LIMIT || "25mb";

const app = express();
app.use(express.json({ limit: BODY_LIMIT }));

const {
  PORT = 3000,
  API_KEY,
  FROM_EMAIL,
  TOKENS_PATH = "tokens.json",
  ALLOW_FROM_OVERRIDE
} = process.env;

if (!API_KEY) {
  console.error("Missing API_KEY in .env");
  process.exit(1);
}
if (!FROM_EMAIL) {
  console.error("Missing FROM_EMAIL in .env (use your Gmail address or alias)");
  process.exit(1);
}

let cachedAuthClient = null;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function loadOAuthClient() {
  if (cachedAuthClient) return cachedAuthClient;

  const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Missing Google OAuth env vars");
  }
  if (!fs.existsSync(TOKENS_PATH)) {
    throw new Error(`tokens.json not found at ${TOKENS_PATH}. Run: npm run auth`);
  }

  const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
  if (!tokens.refresh_token) {
    throw new Error("tokens.json missing refresh_token. Re-run auth with prompt=consent.");
  }

  const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  oAuth2Client.setCredentials(tokens);

  oAuth2Client.on("tokens", (newTokens) => {
    if (!newTokens.access_token && !newTokens.refresh_token) return;
    const merged = { ...oAuth2Client.credentials, ...newTokens };
    try {
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(merged, null, 2));
    } catch (err) {
      console.warn("Failed to update tokens.json:", err.message);
    }
  });

  cachedAuthClient = oAuth2Client;
  return cachedAuthClient;
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

function buildMimeMessage(mail) {
  return new Promise((resolve, reject) => {
    mail.compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message);
    });
  });
}

app.get("/health", (req, res) => res.json({ ok: true }));

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
      from,
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

    const allowFromOverride = ALLOW_FROM_OVERRIDE === "true";
    const fromAddress = allowFromOverride && from ? from : FROM_EMAIL;
    const formattedFrom = formatAddress(fromAddress, fromName);
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
