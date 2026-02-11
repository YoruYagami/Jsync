import { Vault } from "obsidian";
import { normalizePath } from "./utils";

/**
 * Represents the sync state of a single file
 */
export interface SyncItemState {
    /** Local file modification time (ms since epoch) */
    localMtime: number;
    /** Remote file modification time (ms since epoch) */
    remoteMtime: number;
    /** MD5 hash of the content at last sync */
    contentHash: string;
    /** Timestamp of the last successful sync for this item */
    syncedAt: number;
    /** File size in bytes at last sync */
    size: number;
}

/**
 * Full sync state stored in .jsync/sync-state.json
 */
export interface SyncStateData {
    /** Version of the sync state format */
    version: number;
    /** Map of vault-relative file path → sync item state */
    items: Record<string, SyncItemState>;
    /** Timestamp of the last completed full sync */
    lastSyncTime: number;
    /** Unique device ID to identify this sync client */
    deviceId: string;
}

const SYNC_STATE_DIR = ".obsidian/jsync";
const SYNC_STATE_PATH = `${SYNC_STATE_DIR}/sync-state.json`;
const LEGACY_DIR = ".jsync";
const LEGACY_PATH = `${LEGACY_DIR}/sync-state.json`;
const CURRENT_VERSION = 1;

/**
 * Manages the local sync state tracking file
 */
export class SyncState {
    private data: SyncStateData;
    private vault: Vault;
    private dirty = false;

    constructor(vault: Vault) {
        this.vault = vault;
        this.data = {
            version: CURRENT_VERSION,
            items: {},
            lastSyncTime: 0,
            deviceId: this.generateDeviceId(),
        };
    }

    /**
     * Load sync state from disk
     */
    async load(): Promise<void> {
        try {
            let exists = await this.vault.adapter.exists(SYNC_STATE_PATH);

            // Auto-migrate from legacy .jsync/ location
            if (!exists) {
                const legacyExists = await this.vault.adapter.exists(LEGACY_PATH);
                if (legacyExists) {
                    console.log("[JSync] Migrating sync state from .jsync/ to .obsidian/jsync/");
                    const raw = await this.vault.adapter.read(LEGACY_PATH);
                    const dirExists = await this.vault.adapter.exists(SYNC_STATE_DIR);
                    if (!dirExists) await this.vault.adapter.mkdir(SYNC_STATE_DIR);
                    await this.vault.adapter.write(SYNC_STATE_PATH, raw);
                    // Clean up legacy
                    await this.vault.adapter.remove(LEGACY_PATH);
                    try { await this.vault.adapter.rmdir(LEGACY_DIR, false); } catch { /* not empty */ }
                    exists = true;
                }
            }

            if (exists) {
                const raw = await this.vault.adapter.read(SYNC_STATE_PATH);
                const parsed = JSON.parse(raw) as SyncStateData;
                if (parsed.version === CURRENT_VERSION) {
                    this.data = parsed;
                } else {
                    console.log("[JSync] Sync state version mismatch, resetting");
                    this.data.items = {};
                    this.data.lastSyncTime = 0;
                    this.dirty = true;
                }
            }
        } catch (e) {
            console.warn("[JSync] Could not load sync state, starting fresh:", e);
        }
    }

    /**
     * Save sync state to disk
     */
    async save(): Promise<void> {
        try {
            const dirExists = await this.vault.adapter.exists(SYNC_STATE_DIR);
            if (!dirExists) {
                await this.vault.adapter.mkdir(SYNC_STATE_DIR);
            }
            const json = JSON.stringify(this.data, null, 2);
            await this.vault.adapter.write(SYNC_STATE_PATH, json);
            this.dirty = false;
        } catch (e) {
            console.error("[JSync] Failed to save sync state:", e);
        }
    }

    /**
     * Get the sync state for a specific file
     */
    getItem(path: string): SyncItemState | undefined {
        return this.data.items[normalizePath(path)];
    }

    /**
     * Set or update the sync state for a file
     */
    setItem(path: string, state: SyncItemState): void {
        this.data.items[normalizePath(path)] = state;
        this.dirty = true;
    }

    /**
     * Remove a file from sync state tracking
     */
    removeItem(path: string): void {
        delete this.data.items[normalizePath(path)];
        this.dirty = true;
    }

    /**
     * Get all tracked items
     */
    getAllItems(): Record<string, SyncItemState> {
        return { ...this.data.items };
    }

    /**
     * Get all tracked file paths
     */
    getAllPaths(): string[] {
        return Object.keys(this.data.items);
    }

    /**
     * Update the last sync timestamp
     */
    setLastSyncTime(time: number): void {
        this.data.lastSyncTime = time;
        this.dirty = true;
    }

    /**
     * Get the last sync timestamp
     */
    getLastSyncTime(): number {
        return this.data.lastSyncTime;
    }

    /**
     * Get this device's unique ID
     */
    getDeviceId(): string {
        return this.data.deviceId;
    }

    /**
     * Clear all sync state (for force full re-sync)
     */
    reset(): void {
        this.data.items = {};
        this.data.lastSyncTime = 0;
        this.dirty = true;
    }

    /**
     * Check if state has unsaved changes
     */
    isDirty(): boolean {
        return this.dirty;
    }

    /**
     * Generate a random device identifier
     */
    private generateDeviceId(): string {
        const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        let result = "";
        for (let i = 0; i < 12; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return `device-${result}`;
    }
}
