import fs from "fs";
import readline from "readline";
import "dotenv/config";
import { google } from "googleapis";

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  TOKENS_PATH = "tokens.json"
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
  console.error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI in .env");
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

const url = oAuth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES
});

console.log("\nOpen this URL and authorize:\n");
console.log(url);
console.log("\nPaste the returned code here:\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("> ",
  async (code) => {
    rl.close();
    try {
      const { tokens } = await oAuth2Client.getToken(code.trim());
      if (!tokens.refresh_token) {
        console.warn("\nNo refresh_token received. Re-run auth after revoking access or ensure prompt=consent.\n");
      }
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
      console.log(`\nSaved ${TOKENS_PATH}. You can now run the server.\n`);
    } catch (err) {
      console.error("Failed to exchange code for tokens:", err.message);
      process.exit(1);
    }
  }
);
