import { Vault, TFile, TFolder, Notice } from "obsidian";
import { MegaClient, RemoteItem } from "./mega-client";
import { SyncState, SyncItemState } from "./sync-state";
import { computeHash, normalizePath, generateConflictName, isBinaryFile, sleep } from "./utils";
import type { JSyncSettings } from "./settings";

/**
 * Sync action types — modeled exactly after Joplin's SyncAction enum
 */
export type SyncAction =
    | { type: "upload"; path: string; reason: string }
    | { type: "download"; path: string; reason: string }
    | { type: "deleteRemote"; path: string; reason: string }
    | { type: "deleteLocal"; path: string; reason: string }
    | { type: "conflict"; path: string; reason: string };

/**
 * Sync result summary
 */
export interface SyncResult {
    success: boolean;
    uploaded: number;
    downloaded: number;
    deletedLocal: number;
    deletedRemote: number;
    conflicts: number;
    renames: number;
    errors: string[];
    duration: number;
}

/**
 * Callback for progress reporting
 */
export type SyncProgressCallback = (
    message: string,
    current: number,
    total: number
) => void;

/**
 * Lock file info stored on MEGA — Joplin uses SYNC-type locks that
 * allow multiple devices to sync concurrently (not EXCLUSIVE).
 * Each device writes its own lock file.
 */
interface SyncLock {
    deviceId: string;
    clientType: string;
    timestamp: number;
    updatedAt: number;   // auto-refreshed during sync
    expiresAt: number;
}

const LOCK_DIR = ".locks";
const LOCK_TTL_MS = 3 * 60 * 1000;      // 3 minutes — locks expire after this
const LOCK_REFRESH_MS = 60 * 1000;       // refresh lock every 1 min
const HASH_MANIFEST = ".jsync-hashes.json";

/**
 * Core synchronization engine — faithfully modeled after Joplin's Synchronizer.ts
 *
 * Joplin sync model (replicated here):
 * 1. Each device has its own local sync state (≈ Joplin's sync_items table)
 * 2. MEGA is the sync target (≈ Joplin's FileApi) — single source of truth
 * 3. Sync cycle follows Joplin's exact 3-step order:
 *    Step 1: UPLOAD — push local changes to remote
 *    Step 2: DELETE_REMOTE — delete remote items that were deleted locally
 *    Step 3: DELTA — pull remote changes and apply to local
 * 4. SYNC locks (not EXCLUSIVE) allow concurrent syncs from different devices
 * 5. Conflicts: during UPLOAD, if remote was modified since last sync → conflict
 *    During DELTA, remote is newer → update local (no conflict possible
 *    because uploads were already handled in step 1)
 */
export class SyncEngine {
    private vault: Vault;
    private mega: MegaClient;
    private syncState: SyncState;
    private settings: JSyncSettings;
    private isSyncing = false;
    private cancelRequested = false;
    private progressCallback: SyncProgressCallback | null = null;
    private lockRefreshTimer: ReturnType<typeof setInterval> | null = null;
    private remoteHashMap: Record<string, string> = {};

    constructor(
        vault: Vault,
        mega: MegaClient,
        syncState: SyncState,
        settings: JSyncSettings
    ) {
        this.vault = vault;
        this.mega = mega;
        this.syncState = syncState;
        this.settings = settings;
    }

    isBusy(): boolean {
        return this.isSyncing;
    }

    cancel(): void {
        this.cancelRequested = true;
    }

    onProgress(callback: SyncProgressCallback): void {
        this.progressCallback = callback;
    }

    /**
     * Execute a full sync cycle following Joplin's exact algorithm.
     */
    async sync(): Promise<SyncResult> {
        if (this.isSyncing) {
            return {
                success: false, uploaded: 0, downloaded: 0,
                deletedLocal: 0, deletedRemote: 0, conflicts: 0,
                renames: 0, errors: ["Sync already in progress"], duration: 0,
            };
        }

        this.isSyncing = true;
        this.cancelRequested = false;
        const startTime = Date.now();

        const result: SyncResult = {
            success: true, uploaded: 0, downloaded: 0,
            deletedLocal: 0, deletedRemote: 0, conflicts: 0,
            renames: 0, errors: [], duration: 0,
        };

        let lockAcquired = false;

        try {
            if (!this.mega.isConnected()) {
                throw new Error("Not connected to MEGA. Authenticate first.");
            }

            await this.syncState.load();

            // Ensure remote root exists
            await this.mega.mkdir(this.settings.remoteFolder);

            // ── Step 0: Refresh MEGA tree & acquire SYNC lock ──────────
            this.report("Refreshing remote state...", 0, 10);

            // megajs caches file tree at login; we re-login to see files
            // from other devices (equivalent to Joplin's FileApi listing)
            await this.mega.reload();
            await this.mega.mkdir(this.settings.remoteFolder);

            if (this.cancelRequested) throw new Error("Cancelled");

            this.report("Acquiring sync lock...", 1, 10);
            lockAcquired = await this.acquireSyncLock();
            if (!lockAcquired) {
                throw new Error("Sync target is locked by another device performing an upgrade. Try again later.");
            }
            this.startLockRefresh();

            // Load the remote hash manifest for content-based change detection
            this.report("Loading remote state...", 2, 10);
            await this.loadRemoteHashes();

            if (this.cancelRequested) throw new Error("Cancelled");

            // ══════════════════════════════════════════════════════════
            //  Step 1: UPLOAD
            //  Find local items changed since last sync and push to remote.
            //  This is exactly Joplin's "update_remote" step.
            // ══════════════════════════════════════════════════════════

            this.report("Scanning local vault...", 3, 10);
            const localFiles = await this.scanLocalFiles();

            if (this.cancelRequested) throw new Error("Cancelled");

            this.report("Step 1/3: Uploading changes...", 4, 10);
            await this.stepUpload(localFiles, result);

            if (this.cancelRequested) throw new Error("Cancelled");

            // ══════════════════════════════════════════════════════════
            //  Step 1.5: RENAME DETECTION
            //  Detect file moves via hash matching to avoid delete+re-upload.
            // ══════════════════════════════════════════════════════════

            this.report("Detecting renames...", 5, 12);
            await this.stepRenameDetect(localFiles, result);

            if (this.cancelRequested) throw new Error("Cancelled");

            // ══════════════════════════════════════════════════════════
            //  Step 2: DELETE_REMOTE
            //  Delete remote items that have been deleted locally.
            // ══════════════════════════════════════════════════════════

            this.report("Step 2/3: Deleting remote...", 7, 12);
            await this.stepDeleteRemote(localFiles, result);

            if (this.cancelRequested) throw new Error("Cancelled");

            // ══════════════════════════════════════════════════════════
            //  Step 3: DELTA
            //  Pull remote changes and apply to local.
            //  At this point all local changes have been pushed, so
            //  no conflict is possible (exactly like Joplin's delta step).
            // ══════════════════════════════════════════════════════════

            this.report("Step 3/3: Downloading changes...", 9, 12);
            this.mega.clearCache();
            const remoteFiles = await this.scanRemoteFiles();
            await this.stepDelta(localFiles, remoteFiles, result);

            // ── Save state ──────────────────────────────────────────
            this.report("Saving state...", 11, 12);
            await this.saveRemoteHashes();
            this.syncState.setLastSyncTime(Date.now());
            await this.syncState.save();

            this.report("Sync complete!", 12, 12);
        } catch (e: any) {
            result.success = false;
            const msg = e?.message || String(e);
            if (msg !== "Cancelled") {
                result.errors.push(msg);
            }
        } finally {
            this.stopLockRefresh();
            if (lockAcquired) {
                try { await this.releaseSyncLock(); } catch (e) {
                    console.warn("[JSync] Failed to release lock:", e);
                }
            }
            this.isSyncing = false;
            result.duration = Date.now() - startTime;
        }

        return result;
    }

    private report(message: string, current: number, total: number): void {
        if (this.progressCallback) {
            this.progressCallback(message, current, total);
        }
    }

    // ────────────────────────────────────────────────────────────
    //  SYNC LOCK — Joplin SYNC-type (non-exclusive, per-device)
    // ────────────────────────────────────────────────────────────

    private lockFileName(): string {
        const deviceId = this.syncState.getDeviceId();
        return `${this.settings.remoteFolder}/${LOCK_DIR}/sync_${deviceId}.json`;
    }

    /**
     * Acquire a SYNC lock. Unlike EXCLUSIVE locks, multiple SYNC locks
     * can coexist — each device gets their own lock file.
     * We only check that no EXCLUSIVE lock exists.
     */
    private async acquireSyncLock(): Promise<boolean> {
        try {
            // Check for exclusive lock
            const exclusiveLockPath = `${this.settings.remoteFolder}/${LOCK_DIR}/exclusive.json`;
            const exclusiveLock = await this.mega.getOrNull(exclusiveLockPath);

            if (exclusiveLock) {
                const lock = JSON.parse(exclusiveLock.toString("utf-8")) as SyncLock;
                if (Date.now() < lock.expiresAt) {
                    console.log(`[JSync] Exclusive lock held by ${lock.deviceId}`);
                    return false;
                }
                // Expired exclusive lock — safe to proceed
            }

            // Ensure lock directory exists
            await this.mega.mkdir(`${this.settings.remoteFolder}/${LOCK_DIR}`);

            // Write our SYNC lock
            const lock: SyncLock = {
                deviceId: this.syncState.getDeviceId(),
                clientType: "obsidian",
                timestamp: Date.now(),
                updatedAt: Date.now(),
                expiresAt: Date.now() + LOCK_TTL_MS,
            };
            await this.mega.put(this.lockFileName(), JSON.stringify(lock));

            return true;
        } catch (e) {
            console.warn("[JSync] Lock acquisition error, proceeding:", e);
            return true; // Don't block sync on lock errors
        }
    }

    /**
     * Auto-refresh the lock during long syncs (like Joplin's startAutoLockRefresh)
     */
    private startLockRefresh(): void {
        this.lockRefreshTimer = setInterval(async () => {
            try {
                const lock: SyncLock = {
                    deviceId: this.syncState.getDeviceId(),
                    clientType: "obsidian",
                    timestamp: Date.now(),
                    updatedAt: Date.now(),
                    expiresAt: Date.now() + LOCK_TTL_MS,
                };
                await this.mega.put(this.lockFileName(), JSON.stringify(lock));
            } catch (e) {
                console.warn("[JSync] Lock refresh failed:", e);
            }
        }, LOCK_REFRESH_MS);
    }

    private stopLockRefresh(): void {
        if (this.lockRefreshTimer) {
            clearInterval(this.lockRefreshTimer);
            this.lockRefreshTimer = null;
        }
    }

    private async releaseSyncLock(): Promise<void> {
        try {
            await this.mega.delete(this.lockFileName());
        } catch (e) {
            // Non-critical — lock will expire
        }
    }

    // ────────────────────────────────────────────────────────────
    //  REMOTE HASH MANIFEST
    // ────────────────────────────────────────────────────────────

    private async loadRemoteHashes(): Promise<void> {
        const path = `${this.settings.remoteFolder}/${HASH_MANIFEST}`;
        try {
            const data = await this.mega.getOrNull(path);
            this.remoteHashMap = data ? JSON.parse(data.toString("utf-8")) : {};
        } catch (e) {
            console.warn("[JSync] Could not load remote hashes:", e);
            this.remoteHashMap = {};
        }
    }

    private async saveRemoteHashes(): Promise<void> {
        const path = `${this.settings.remoteFolder}/${HASH_MANIFEST}`;
        try {
            await this.mega.put(path, JSON.stringify(this.remoteHashMap));
        } catch (e) {
            console.error("[JSync] Failed to save remote hashes:", e);
        }
    }

    // ────────────────────────────────────────────────────────────
    //  SCANNING
    // ────────────────────────────────────────────────────────────

    private async scanLocalFiles(): Promise<
        Map<string, { mtime: number; size: number; hash: string }>
    > {
        const files = this.vault.getFiles();
        const localMap = new Map<
            string,
            { mtime: number; size: number; hash: string }
        >();

        for (const file of files) {
            if (this.isExcluded(file.path)) continue;
            if (file.stat.size > this.settings.maxFileSizeMB * 1024 * 1024) continue;
            if (!this.settings.syncAttachments && isBinaryFile(file.path)) continue;

            const normalPath = normalizePath(file.path);
            let hash: string;

            // Mtime-first optimization: skip hashing if mtime unchanged
            const syncItem = this.syncState.getItem(normalPath);
            if (syncItem && file.stat.mtime === syncItem.localMtime && file.stat.size === syncItem.size) {
                hash = syncItem.contentHash;
            } else {
                try {
                    if (isBinaryFile(file.path)) {
                        const buf = await this.vault.readBinary(file);
                        hash = computeHash(Buffer.from(buf));
                    } else {
                        const content = await this.vault.read(file);
                        hash = computeHash(content);
                    }
                } catch (e) {
                    console.warn(`[JSync] Could not read ${file.path}, skipping:`, e);
                    continue;
                }
            }

            localMap.set(normalPath, {
                mtime: file.stat.mtime,
                size: file.stat.size,
                hash,
            });
        }

        return localMap;
    }

    private async scanRemoteFiles(): Promise<Map<string, RemoteItem>> {
        const remoteItems = await this.mega.listRecursive(this.settings.remoteFolder);
        const remoteMap = new Map<string, RemoteItem>();
        const prefixLen = normalizePath(this.settings.remoteFolder).length + 1;

        for (const item of remoteItems) {
            if (item.isFolder) continue;
            const relativePath = item.path.substring(prefixLen);
            if (!relativePath) continue;
            if (this.isInternalFile(relativePath)) continue;
            remoteMap.set(relativePath, item);
        }

        return remoteMap;
    }

    private isInternalFile(path: string): boolean {
        const name = path.split("/").pop() || path;
        if (name === HASH_MANIFEST) return true;
        if (path.startsWith(LOCK_DIR + "/") || path.startsWith(".jsync")) return true;
        return false;
    }

    // ────────────────────────────────────────────────────────────
    //  STEP 1: UPLOAD (Joplin's "update_remote" step)
    // ────────────────────────────────────────────────────────────

    /**
     * For each local file that has changed since last sync:
     * - If remote doesn't exist and never synced → CreateRemote
     * - If remote doesn't exist but was synced → it was deleted remotely
     *   → if local changed too → conflict; else → deleteLocal (handled in delta)
     * - If remote exists → check if remote also changed → conflict or upload
     *
     * This exactly mirrors Joplin's UPLOAD step logic from Synchronizer.ts
     */
    private async stepUpload(
        localFiles: Map<string, { mtime: number; size: number; hash: string }>,
        result: SyncResult
    ): Promise<void> {
        const syncItems = this.syncState.getAllItems();

        for (const [path, local] of localFiles) {
            if (this.cancelRequested) break;

            const syncItem = syncItems[path];
            const localChanged = syncItem ? local.hash !== syncItem.contentHash : true;

            // Only process files that have changed since last sync
            if (!localChanged) continue;

            try {
                if (!syncItem) {
                    // Never synced — check if remote already exists
                    const remoteHash = this.remoteHashMap[path];
                    if (remoteHash) {
                        // Remote exists — check for conflict
                        if (remoteHash === local.hash) {
                            // Same content — just register, no transfer needed
                            this.syncState.setItem(path, {
                                localMtime: local.mtime,
                                remoteMtime: Date.now(),
                                contentHash: local.hash,
                                syncedAt: Date.now(),
                                size: local.size,
                            });
                        } else {
                            // Different content — conflict
                            await this.handleConflict(path);
                            result.conflicts++;
                        }
                    } else {
                        // New local file → upload (CreateRemote)
                        await this.doUpload(path);
                        result.uploaded++;
                    }
                } else {
                    // Previously synced — check if remote also changed
                    const remoteHash = this.remoteHashMap[path];
                    const remoteChanged = remoteHash
                        ? remoteHash !== syncItem.contentHash
                        : false;

                    if (remoteChanged) {
                        // Both sides changed → conflict (exactly like Joplin)
                        await this.handleConflict(path);
                        result.conflicts++;
                    } else {
                        // Only local changed → upload (UpdateRemote)
                        await this.doUpload(path);
                        result.uploaded++;
                    }
                }
            } catch (e: any) {
                // Like Joplin's handleCannotSyncItem — log error, continue
                const errMsg = `Upload error ${path}: ${e?.message || e}`;
                console.error(`[JSync] ${errMsg}`);
                result.errors.push(errMsg);
            }
        }
    }

    // ────────────────────────────────────────────────────────────
    //  STEP 1.5: RENAME DETECTION (hash-based move tracking)
    // ────────────────────────────────────────────────────────────

    /**
     * Detect file renames/moves by matching content hashes.
     * If a file disappears from path A and a same-hash file appears at path B,
     * we upload to B and delete from A instead of re-uploading the full content.
     */
    private async stepRenameDetect(
        localFiles: Map<string, { mtime: number; size: number; hash: string }>,
        result: SyncResult
    ): Promise<void> {
        const syncItems = this.syncState.getAllItems();

        // Build index of "deleted locally" items: in sync state but not in local
        const deletedLocally = new Map<string, SyncItemState>();
        for (const [path, item] of Object.entries(syncItems)) {
            if (!localFiles.has(path)) {
                deletedLocally.set(path, item);
            }
        }

        if (deletedLocally.size === 0) return;

        // Build index of "new locally" items: in local but not in sync state
        const newLocally = new Map<string, { mtime: number; size: number; hash: string }>();
        for (const [path, local] of localFiles) {
            if (!syncItems[path]) {
                newLocally.set(path, local);
            }
        }

        if (newLocally.size === 0) return;

        // Build hash → deleted-path index
        const hashToDeleted = new Map<string, string>();
        for (const [path, item] of deletedLocally) {
            hashToDeleted.set(item.contentHash, path);
        }

        // Match new files to deleted files by hash
        for (const [newPath, newLocal] of newLocally) {
            if (this.cancelRequested) break;

            const oldPath = hashToDeleted.get(newLocal.hash);
            if (!oldPath) continue;

            // Found a rename: oldPath → newPath (same content hash)
            try {
                console.log(`[JSync] Rename detected: ${oldPath} → ${newPath}`);

                // Upload to new remote path
                const remotePath = `${this.settings.remoteFolder}/${newPath}`;
                const oldRemotePath = `${this.settings.remoteFolder}/${oldPath}`;

                // Read content and upload to new location
                const file = this.vault.getAbstractFileByPath(newPath);
                if (!file || !(file instanceof TFile)) continue;

                let content: Buffer;
                if (isBinaryFile(newPath)) {
                    content = Buffer.from(await this.vault.readBinary(file));
                } else {
                    content = Buffer.from(await this.vault.read(file), "utf-8");
                }

                await this.mega.put(remotePath, content);
                await this.mega.delete(oldRemotePath);

                // Update sync state: remove old, add new
                this.syncState.removeItem(oldPath);
                const hash = computeHash(content);
                this.remoteHashMap[newPath] = hash;
                delete this.remoteHashMap[oldPath];

                this.syncState.setItem(newPath, {
                    localMtime: file.stat.mtime,
                    remoteMtime: Date.now(),
                    contentHash: hash,
                    syncedAt: Date.now(),
                    size: content.length,
                });

                // Remove from maps so other steps don't reprocess
                deletedLocally.delete(oldPath);
                hashToDeleted.delete(newLocal.hash);

                result.renames++;
            } catch (e: any) {
                console.warn(`[JSync] Rename handling error ${oldPath} → ${newPath}:`, e);
                // Fall through to normal upload+delete on next steps
            }
        }
    }

    // ────────────────────────────────────────────────────────────
    //  STEP 2: DELETE_REMOTE
    // ────────────────────────────────────────────────────────────

    /**
     * Delete remote items that were deleted locally.
     * A file is "deleted locally" if it exists in sync state but not in localFiles.
     * However, if the remote was also modified → don't delete, download instead.
     */
    private async stepDeleteRemote(
        localFiles: Map<string, { mtime: number; size: number; hash: string }>,
        result: SyncResult
    ): Promise<void> {
        const syncItems = this.syncState.getAllItems();

        for (const [path, syncItem] of Object.entries(syncItems)) {
            if (this.cancelRequested) break;

            // File exists in sync state but not locally → deleted locally
            if (localFiles.has(path)) continue;

            try {
                const remoteHash = this.remoteHashMap[path];
                const remoteChanged = remoteHash
                    ? remoteHash !== syncItem.contentHash
                    : false;

                if (remoteChanged) {
                    // Remote was modified after our last sync — don't delete,
                    // the DELTA step will download it
                    continue;
                }

                // Remote unchanged → safe to delete (Joplin's delete_remote logic)
                const remotePath = `${this.settings.remoteFolder}/${path}`;
                await this.mega.delete(remotePath);
                this.syncState.removeItem(path);
                delete this.remoteHashMap[path];
                result.deletedRemote++;
            } catch (e: any) {
                const errMsg = `Delete remote error ${path}: ${e?.message || e}`;
                console.error(`[JSync] ${errMsg}`);
                result.errors.push(errMsg);
            }
        }
    }

    // ────────────────────────────────────────────────────────────
    //  STEP 3: DELTA (Joplin's "delta" step)
    // ────────────────────────────────────────────────────────────

    /**
     * Pull remote changes and apply locally.
     * At this point, all local changes have been pushed to remote,
     * so NO CONFLICT IS POSSIBLE here (exactly like Joplin).
     *
     * Actions:
     * - Remote exists, local doesn't, never synced → CreateLocal (download)
     * - Remote exists, local exists, remote is newer → UpdateLocal (download)
     * - Remote doesn't exist, local exists, was synced → DeleteLocal
     */
    private async stepDelta(
        localFiles: Map<string, { mtime: number; size: number; hash: string }>,
        remoteFiles: Map<string, RemoteItem>,
        result: SyncResult
    ): Promise<void> {
        const syncItems = this.syncState.getAllItems();

        // Process remote items
        for (const [path, remote] of remoteFiles) {
            if (this.cancelRequested) break;

            const local = localFiles.get(path);
            const syncItem = syncItems[path];
            const remoteHash = this.remoteHashMap[path];

            try {
                if (!local) {
                    // Remote exists but local doesn't
                    if (!syncItem) {
                        // Never synced → CreateLocal (new file from another device)
                        await this.doDownload(path);
                        result.downloaded++;
                    } else {
                        // Was synced before — was it deleted locally?
                        // Check if remote has changed since our last sync
                        const remoteChanged = remoteHash
                            ? remoteHash !== syncItem.contentHash
                            : remote.lastModified > syncItem.remoteMtime + 1000;

                        if (remoteChanged) {
                            // Remote was modified AND deleted locally
                            // → download (remote wins, like Joplin's delta logic)
                            await this.doDownload(path);
                            result.downloaded++;
                        } else {
                            // Already handled in DELETE_REMOTE step above
                            // (or will be on next sync if network error)
                        }
                    }
                } else {
                    // Both exist — check if remote is newer than what we synced
                    if (syncItem) {
                        const remoteChanged = remoteHash
                            ? remoteHash !== syncItem.contentHash
                            : remote.lastModified > syncItem.remoteMtime + 1000;

                        const localChanged = local.hash !== syncItem.contentHash;

                        if (remoteChanged && !localChanged) {
                            // Remote updated, local unchanged → UpdateLocal
                            // (exactly Joplin's "remote is more recent" logic)
                            await this.doDownload(path);
                            result.downloaded++;
                        }
                        // If both changed: already handled in UPLOAD step
                        // If neither changed: nothing to do
                    }
                    // If no syncItem: already handled in UPLOAD step
                }
            } catch (e: any) {
                const errMsg = `Download error ${path}: ${e?.message || e}`;
                console.error(`[JSync] ${errMsg}`);
                result.errors.push(errMsg);
            }
        }

        // Handle items deleted from remote (present in sync state but not in remoteFiles)
        for (const [path, syncItem] of Object.entries(syncItems)) {
            if (this.cancelRequested) break;
            if (remoteFiles.has(path)) continue;
            if (!localFiles.has(path)) {
                // Ghost-file reconciliation: gone from both sides
                // (e.g. both devices deleted while offline)
                console.log(`[JSync] Ghost-file cleanup: ${path} (deleted on both sides)`);
                this.syncState.removeItem(path);
                delete this.remoteHashMap[path];
                continue;
            }

            const local = localFiles.get(path)!;
            const localChanged = local.hash !== syncItem.contentHash;

            if (!localChanged) {
                // Deleted on remote, unchanged locally → DeleteLocal
                // (Joplin's "remote has been deleted" in delta step)
                try {
                    const file = this.vault.getAbstractFileByPath(path);
                    if (file) {
                        await this.vault.delete(file);
                    }
                    this.syncState.removeItem(path);
                    delete this.remoteHashMap[path];
                    result.deletedLocal++;
                } catch (e: any) {
                    result.errors.push(`Delete local error ${path}: ${e?.message || e}`);
                }
            } else {
                // Deleted on remote but modified locally — re-upload
                // (exactly like Joplin: local note was modified but
                //  remote was deleted → note conflict → keep local)
                try {
                    await this.doUpload(path);
                    result.uploaded++;
                } catch (e: any) {
                    result.errors.push(`Re-upload error ${path}: ${e?.message || e}`);
                }
            }
        }
    }

    // ────────────────────────────────────────────────────────────
    //  ACTION EXECUTORS
    // ────────────────────────────────────────────────────────────

    private async doUpload(path: string): Promise<void> {
        const file = this.vault.getAbstractFileByPath(path);
        if (!file || !(file instanceof TFile)) {
            throw new Error(`Local file not found: ${path}`);
        }

        let content: Buffer;
        if (isBinaryFile(path)) {
            const buf = await this.vault.readBinary(file);
            content = Buffer.from(buf);
        } else {
            const text = await this.vault.read(file);
            content = Buffer.from(text, "utf-8");
        }

        const remotePath = `${this.settings.remoteFolder}/${path}`;
        await this.mega.put(remotePath, content);

        const hash = computeHash(content);
        this.remoteHashMap[path] = hash;

        // Like Joplin's saveSyncTime: set sync_time = updated_time
        this.syncState.setItem(path, {
            localMtime: file.stat.mtime,
            remoteMtime: Date.now(),
            contentHash: hash,
            syncedAt: Date.now(),
            size: content.length,
        });
    }

    private async doDownload(path: string): Promise<void> {
        const remotePath = `${this.settings.remoteFolder}/${path}`;
        const content = await this.mega.get(remotePath);

        // Ensure parent folders exist locally (recursive)
        await this.ensureLocalDirs(path);

        const existingFile = this.vault.getAbstractFileByPath(path);
        if (existingFile && existingFile instanceof TFile) {
            if (isBinaryFile(path)) {
                await this.vault.modifyBinary(existingFile,
                    content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer);
            } else {
                await this.vault.modify(existingFile, content.toString("utf-8"));
            }
        } else {
            if (isBinaryFile(path)) {
                await this.vault.createBinary(path,
                    content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer);
            } else {
                await this.vault.create(path, content.toString("utf-8"));
            }
        }

        const hash = computeHash(content);
        this.remoteHashMap[path] = hash;

        const localFile = this.vault.getAbstractFileByPath(path);
        this.syncState.setItem(path, {
            localMtime: (localFile instanceof TFile) ? localFile.stat.mtime : Date.now(),
            remoteMtime: Date.now(),
            contentHash: hash,
            syncedAt: Date.now(),
            size: content.length,
        });
    }

    /**
     * Handle conflict — modeled after Joplin's handleConflictAction:
     * - "copy": Save local version as conflict copy, download remote
     *           (Joplin moves note to Conflict notebook; we create a _conflict file)
     *           Conflict copy is also uploaded to MEGA for all devices to see.
     * - "remote-wins": Download remote, overwrite local
     * - "local-wins": Upload local, overwrite remote
     */
    private async handleConflict(path: string): Promise<void> {
        const strategy = this.settings.conflictStrategy;

        if (strategy === "local-wins") {
            await this.doUpload(path);
            return;
        }

        if (strategy === "remote-wins") {
            await this.doDownload(path);
            return;
        }

        // "copy" strategy (default, like Joplin's Conflict notebook)
        const localFile = this.vault.getAbstractFileByPath(path);
        if (localFile && localFile instanceof TFile) {
            const isBin = isBinaryFile(path);
            let localContent: string | ArrayBuffer;

            if (isBin) {
                localContent = await this.vault.readBinary(localFile);
            } else {
                localContent = await this.vault.read(localFile);
            }

            // Create local conflict copy
            const conflictPath = generateConflictName(path, new Date());
            if (isBin) {
                await this.vault.createBinary(conflictPath, localContent as ArrayBuffer);
            } else {
                await this.vault.create(conflictPath, localContent as string);
            }

            // Upload conflict copy to MEGA so all devices see it
            const conflictBuf = isBin
                ? Buffer.from(localContent as ArrayBuffer)
                : Buffer.from(localContent as string, "utf-8");
            const conflictRemotePath = `${this.settings.remoteFolder}/${conflictPath}`;
            await this.mega.put(conflictRemotePath, conflictBuf);

            const conflictHash = computeHash(conflictBuf);
            this.remoteHashMap[conflictPath] = conflictHash;

            const conflictFile = this.vault.getAbstractFileByPath(conflictPath);
            this.syncState.setItem(conflictPath, {
                localMtime: (conflictFile instanceof TFile) ? conflictFile.stat.mtime : Date.now(),
                remoteMtime: Date.now(),
                contentHash: conflictHash,
                syncedAt: Date.now(),
                size: conflictBuf.length,
            });

            new Notice(`JSync: Conflict — saved copy as ${conflictPath.split("/").pop()}`);
        }

        // Download remote version to original path
        await this.doDownload(path);
    }

    // ────────────────────────────────────────────────────────────
    //  HELPERS
    // ────────────────────────────────────────────────────────────

    private async ensureLocalDirs(filePath: string): Promise<void> {
        const parts = filePath.split("/");
        parts.pop();
        let currentPath = "";
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            const existing = this.vault.getAbstractFileByPath(currentPath);
            if (!existing) {
                await this.vault.createFolder(currentPath);
            }
        }
    }

    private isExcluded(path: string): boolean {
        const normalPath = normalizePath(path);
        // .obsidian/ is already in excludedFolders by default (contains sync state)
        for (const excluded of this.settings.excludedFolders) {
            const normalExcl = normalizePath(excluded);
            if (normalPath === normalExcl || normalPath.startsWith(normalExcl + "/")) {
                return true;
            }
        }
        return false;
    }

    /**
     * Force a full re-sync by resetting sync state.
     * Hash comparison prevents false conflicts.
     */
    async forceFullSync(): Promise<SyncResult> {
        this.syncState.reset();
        await this.syncState.save();
        return this.sync();
    }
}
