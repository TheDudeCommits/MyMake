# MyMake

MyMake is a Privy-authenticated AI-powered UI editor for uploaded React frontend projects. It accepts a zipped frontend app, spins up a live preview runner, lets you pick elements directly in the preview, and sends focused edit requests to AI models with revision history, attachments, device previews, Monaco editing, export support, and per-user project ownership.

## Stack

- Next.js 14 App Router with TypeScript and Tailwind
- Custom Node server for same-origin preview proxying
- SQLite plus filesystem snapshots for project persistence
- OpenAI, Codex, and Claude model routing for AI code edits
- Monaco editor for direct file editing
- Railway as the intended deployment target

## Environment

Copy `.env.example` to `.env.local` for local work and set these values in Railway:

```bash
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
NEXT_PUBLIC_PRIVY_APP_ID=your-privy-app-id
PRIVY_APP_SECRET=your-privy-app-secret
PRIMARY_OWNER_EMAIL=your-admin-email@example.com
GITHUB_CLIENT_ID=your-github-oauth-app-client-id
GITHUB_CLIENT_SECRET=your-github-oauth-app-client-secret
STORAGE_ROOT=/data/mymake
SQLITE_DB_PATH=/data/mymake/mymake.sqlite
```

`STORAGE_ROOT` should point at a persistent Railway volume in production.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000/auth`, sign in with Privy, and upload a `.zip` containing a single Next.js, Vite React, or supported static frontend project.

## What v1 Supports

- Single uploaded Next.js or Vite React frontend repos with local assets
- Live iframe preview with desktop, tablet, and mobile sizes
- Element picking from the rendered preview
- AI edits with optional image/file attachments
- Server-saved revisions with undo and redo
- Manual file editing with Monaco
- Code export as a zip

## What v1 Rejects

- Monorepos and workspaces
- Projects that rely on `app/api` or `pages/api`
- Projects that appear to depend on external databases or companion services

## Deployment Notes

- Use Railway because uploaded projects need long-lived preview runners and persistent storage.
- Set the service start command to `npm run start`.
- Attach a volume and mount it so `STORAGE_ROOT` and `SQLITE_DB_PATH` live on persistent disk.
- GitHub import/connect/push requires a GitHub OAuth app configured with `read:user` and `repo` scopes.
