# MyMake

MyMake is a personal AI-powered UI editor for uploaded Next.js projects. It accepts a zipped frontend app, spins up a live preview runner, lets you pick elements directly in the preview, and sends focused edit requests to Claude with revision history, attachments, device previews, Monaco editing, and export support.

## Stack

- Next.js 14 App Router with TypeScript and Tailwind
- Custom Node server for same-origin preview proxying
- SQLite plus filesystem snapshots for project persistence
- Claude Sonnet 4 (`claude-sonnet-4-20250514`) for AI code edits
- Monaco editor for direct file editing
- Railway as the intended deployment target

## Environment

Copy `.env.example` to `.env.local` for local work and set these values in Railway:

```bash
APP_PASSCODE=your-private-passcode
ANTHROPIC_API_KEY=your-anthropic-key
STORAGE_ROOT=/data/mymake
SQLITE_DB_PATH=/data/mymake/mymake.sqlite
```

`STORAGE_ROOT` should point at a persistent Railway volume in production.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000/auth`, unlock the app with your passcode, and upload a `.zip` containing a single Next.js frontend project.

## What v1 Supports

- Single uploaded Next.js frontend repos with local assets
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
