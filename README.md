# ⚡ JSync — Obsidian MEGA Sync

Robust bidirectional sync for your Obsidian vault via **MEGA** cloud storage.

## Features

- **Bidirectional Sync** — Upload local changes to MEGA, download remote changes to your vault
- **Delta Sync** — Only syncs files that have changed since the last sync (via content hashing + mtime)
- **Conflict Resolution** — Detects files modified on both sides; creates conflict copies, or use remote-wins / local-wins strategy
- **Auto-Sync** — Configurable background sync interval (default: 5 minutes)
- **Attachment Sync** — Syncs binary files (images, PDFs, etc.) alongside markdown notes
- **Folder Sync** — Mirrors your vault's folder structure on MEGA
- **Status Bar** — Real-time sync status and progress
- **Commands** — Sync Now, Force Full Re-Sync, Toggle Auto-Sync, Connect/Disconnect

## Installation

### Manual Install
1. Build the plugin:
   ```bash
   cd Jsync
   npm install
   npm run build
   ```
2. Copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/jsync-mega/` folder
3. Enable the plugin in Obsidian → Settings → Community Plugins
4. Configure your MEGA credentials in the JSync settings tab

## Configuration

| Setting | Default | Description |
|---|---|---|
| MEGA Email | — | Your MEGA account email |
| MEGA Password | — | MEGA account password (stored locally) |
| Remote Folder | `/JSync` | Root folder on MEGA |
| Auto-Sync Interval | 5 min | Background sync frequency |
| Sync Attachments | ✓ | Sync binary files |
| Conflict Strategy | Copy | `copy` / `remote-wins` / `local-wins` |
| Excluded Folders | `.obsidian, .trash` | Folders to never sync |
| Max File Size | 50 MB | Skip files larger than this |

## Commands

- **JSync: Sync Now** — Manual sync trigger
- **JSync: Force Full Re-Sync** — Reset sync state + full re-sync
- **JSync: Toggle Auto-Sync** — Enable/disable background sync
- **JSync: Connect to MEGA** — Establish MEGA connection
- **JSync: Disconnect from MEGA** — Close connection

## Architecture

```
src/
├── main.ts          # Plugin entry point (commands, ribbon, status bar)
├── mega-client.ts   # MEGA API wrapper (put/get/delete/list/mkdir)
├── sync-engine.ts   # Core sync logic (delta detection, conflict resolution)
├── sync-state.ts    # Per-file sync state tracking (.jsync/sync-state.json)
├── settings.ts      # Settings tab UI + data model
└── utils.ts         # Hashing, path manipulation, formatting utilities
```

## How Sync Works

1. **Scan** local vault files (mtime + MD5 hash) and remote MEGA files
2. **Compare** against last-sync state to detect: new, modified, deleted (both sides)
3. **Execute** sync actions in order: uploads → downloads → remote deletes → local deletes
4. **Resolve** conflicts: create conflict copy (default), or apply remote/local-wins strategy
5. **Save** updated sync state to `.jsync/sync-state.json`

## License

MIT