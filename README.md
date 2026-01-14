# Gmail API Sender

A small Node.js + Docker service that sends email through the Gmail API and exposes `POST /send` for automation. It supports browser-based OAuth (recommended for servers) and attachment sending.

## Features

- Gmail API send via OAuth2 refresh token
- Browser-based OAuth flow (`/auth/start` → Google → `/auth/callback`)
- `/send` endpoint with attachments, headers, reply threading fields
- Docker image and Docker Compose with persistent tokens

## Requirements

- Google Cloud project with Gmail API enabled
- OAuth client (Web application recommended for server use)

## Google Cloud Setup

1. Enable Gmail API in Google Cloud Console.
2. Create OAuth client credentials.
   - Use **Web application** if you want browser-based auth on a server.
   - Add redirect URI: `https://your-domain.example/auth/callback` (or local `http://localhost:3000/auth/callback`).
3. Copy the client ID and secret into `.env`.

## Environment

Copy the example and edit values:

```bash
cp .env.example .env
```

Key variables:

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- `API_KEY` for `/send`
- `FROM_EMAIL` (must be your Gmail address or alias)
- `AUTH_KEY` (optional, protects `/auth/start`)
- `TOKENS_PATH` (use `/data/tokens.json` in Docker Compose)

## Browser OAuth (recommended for server deployments)

1. Ensure `GOOGLE_REDIRECT_URI` matches your deployed callback URL.
2. Open in your browser:

```
https://your-domain.example/auth/start?key=YOUR_AUTH_KEY
```

3. Approve access; tokens are saved to `TOKENS_PATH`.

Optional:
- `AUTH_SUCCESS_REDIRECT` and `AUTH_FAILURE_REDIRECT` to redirect after auth.
- `AUTH_STATE_TTL_MS` (default 10 minutes) for OAuth state expiration.

## Local One-Time Auth (optional)

If you prefer a local CLI flow (e.g., during development):

```bash
npm install
npm run auth
```

This writes `tokens.json` in the project directory.

## Run Locally

```bash
npm install
npm start
```

## Run with Docker

```bash
docker build -t gmail-sender .
docker run -p 3000:3000 --env-file .env -v "$PWD/tokens.json:/app/tokens.json:ro" gmail-sender
```

## Run with Docker Compose (persistent tokens)

Edit `docker-compose.yml` to use your GHCR image (replace `OWNER/REPO`):

```yaml
image: ghcr.io/OWNER/REPO:latest
```

Then:

```bash
docker compose up -d
```

To perform browser auth, open:

```
https://your-domain.example/auth/start?key=YOUR_AUTH_KEY
```

Tokens are stored in the `gmail_tokens` volume at `/data/tokens.json`.

## GitHub Actions (CI Build)

On merge to `main` or `master`, GitHub Actions builds and pushes to GHCR:

- `ghcr.io/<owner>/<repo>:latest`
- `ghcr.io/<owner>/<repo>:<commit_sha>`

Make sure GHCR packages are enabled for your repo and the workflow has `packages: write` permissions (already set).

## API

### Health

`GET /health`

Response:

```json
{ "ok": true }
```

### Send Email

`POST /send`

Headers:

```
x-api-key: <API_KEY>
```

Body (JSON):

```json
{
  "to": "you@example.com",
  "subject": "Hello",
  "text": "Sent from the API"
}
```

### Attachments + Extra Fields

```json
{
  "to": "you@example.com",
  "cc": "cc@example.com",
  "bcc": "bcc@example.com",
  "replyTo": "reply@example.com",
  "replyToName": "Support",
  "fromName": "Gmail Sender",
  "subject": "Report",
  "text": "See attached.",
  "headers": { "X-Job-Id": "daily-report" },
  "attachments": [
    {
      "filename": "note.txt",
      "contentBase64": "SGVsbG8gZnJvbSBUYXNrZXI=",
      "contentType": "text/plain"
    }
  ]
}
```

Inline attachment example:

```json
{
  "to": "you@example.com",
  "subject": "Inline image",
  "html": "<img src=\"cid:logo\" />",
  "attachments": [
    {
      "filename": "logo.png",
      "contentBase64": "iVBORw0KGgoAAAANSUhEUgAA...",
      "contentType": "image/png",
      "cid": "logo",
      "contentDisposition": "inline"
    }
  ]
}
```

Supported fields:

- `to`, `cc`, `bcc`
- `subject`
- `text`, `html`
- `from` (only if `ALLOW_FROM_OVERRIDE=true`)
- `fromName`, `replyTo`, `replyToName`
- `headers` (object of header name → value)
- `inReplyTo`, `references`, `messageId`, `priority`
- `attachments` array (`filename`, `contentBase64` or `content` data URL, optional `contentType`, `encoding`, `cid`, `contentDisposition`)

## Security Notes

- Keep `API_KEY` and `AUTH_KEY` long and random.
- Do not expose `/auth/start` publicly unless protected by `AUTH_KEY`.
- `FROM_EMAIL` must be a valid Gmail address or alias on the authenticated account.

## Troubleshooting

- No refresh token: revoke the app in Google Account security settings, then re-authorize.
- 400 from Gmail API: check that `FROM_EMAIL` matches your account/alias and that the OAuth client has the correct redirect URI.
- Large attachments: raise `BODY_LIMIT` and ensure Gmail raw size limits are not exceeded (~35 MB).
