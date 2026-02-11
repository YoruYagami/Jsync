# ⚡ JSync — The Robust Obsidian → MEGA Sync

A **production-grade**, bidirectional synchronization engine for your Obsidian vault using **MEGA** cloud storage.

Built with **reliability** and **data integrity** as core principles, JSync mirrors the behavior of professional sync clients (like Joplin) but fully integrated into your Obsidian workflow.

## 🌟 Key Features

*   **Bidirectional Sync**: Changes propagate instantly between devices. Edits on your phone appear on your desktop.
*   **Conflict-Free Editing**: Automatic conflict resolution via rename/copy or strategy (Remote Wins / Local Wins).
*   **Smart Rename Tracking**: Drag-and-drop file moves are detected as **Renames**, not delete+upload, saving bandwidth.
*   **Debounced Auto-Sync**: Waits for a "quiet period" after you stop typing (default 10s) before syncing. No interruptions.
*   **Optimized Performance**:
    *   **Mtime-First Hashing**: Only re-hashes changed files (CPU usage reduced by >95%).
    *   **Ghost-File Reconciliation**: Cleanly handles files deleted on both devices while offline.
*   **Privacy-First**: Sync state is stored in `.obsidian/jsync/`, keeping your vault root clean and metadata private.
*   **Encryption**: Full end-to-end encryption via standard MEGA protocols.

## 🛠️ How It Works (Under the Hood)

JSync implements a rigorous 3-step synchronization cycle designed for maximum safety:

### The Sync Cycle
Every sync operation follows this exact sequence:

1.  **Lock Acquisition**
    *   Before starting, JSync acquires a **SYNC lock** on MEGA.
    *   This prevents two devices from modifying the remote state simultaneously, avoiding race conditions.
    *   Locks have a timeout (TTL) to self-heal if a device crashes mid-sync.

2.  **State Loading & Optimization**
    *   Loads local sync state from `.obsidian/jsync/sync-state.json`.
    *   **Mtime-First Scan**: Checks file modification times (`mtime`) against the last sync. If unchanged, it skips the expensive MD5 re-calculation.

3.  **Step 1: Upload (Local → Remote)**
    *   Detects new/modified local files.
    *   **Conflict Handling**: If a file changed locally AND remotely since the last sync:
        *   **Standard Strategy (Copy)**: Renames the local file (e.g., `Note (Conflict 2024-...).md`), uploads it, then downloads the remote version. Preserves all data.
        *   **Remote Wins**: Discards local changes.
        *   **Local Wins**: Overwrites remote file.

4.  **Step 1.5: Smart Rename Detection**
    *   If a file `Folder/A.md` is missing locally but a new file `Folder/B.md` exists with the **exact same hash**, JSync deduces a Move operation.
    *   **Action**: Instructs MEGA to move the remote file. This is instant and saves bandwidth.

5.  **Step 2: Delete Remote**
    *   Propagates safe local deletions to the cloud.
    *   **Safety Check**: If the remote file was updated since the last sync, deletion is aborted to prevent accidental data loss (it will be re-downloaded instead).

6.  **Step 3: Delta (Remote → Local)**
    *   Downloads new or modified files from MEGA.
    *   **Ghost-File Cleanup**: If a file was deleted on *both* devices while offline, JSync detects this "double-delete" and cleanly removes the stale entry from the sync state.

## ⚙️ Configuration

| Setting | Default | Description |
|---|---|---|
| **MEGA Email** | — | Your MEGA account email |
| **MEGA Password** | — | Password (stored securely) |
| **Remote Folder** | `/JSync` | Root folder on MEGA |
| **Auto-Sync Interval** | 5 min | How often to check for remote changes |
| **Sync Debounce** | 10 sec | Wait time after typing stops before syncing |
| **Sync Attachments** | ✓ | Sync images, PDFs, binaries |
| **Conflict Strategy** | Copy | `copy` (safest), `remote-wins`, `local-wins` |
| **Excluded Folders** | `.obsidian, .trash` | Folders to never sync |
| **Max File Size** | 50 MB | Skip files larger than this |

## 📦 Installation

### Manual Install
1.  Download the latest release or build from source:
    ```bash
    git clone https://github.com/Start9-Labs/jsync-obsidian
    cd jsync-obsidian
    npm install
    npm run build
    ```
2.  Copy `main.js`, `manifest.json`, `styles.css` to `.obsidian/plugins/jsync-mega/`.
3.  Enable in Obsidian → Settings → Community Plugins.

## 🗺️ Project Structure

For developers interested in the architecture:

```
src/
├── main.ts          # Plugin lifecycle, commands, debounce logic
├── sync-engine.ts   # Core synchronization logic (algorithms, conflict resolution)
├── sync-state.ts    # Local metadata management (.obsidian/jsync/)
├── mega-client.ts   # MEGA API wrapper (auth, filesystem ops)
├── settings.ts      # Settings UI & data model
└── utils.ts         # Hashing, paths, helpers
```

## License
MIT