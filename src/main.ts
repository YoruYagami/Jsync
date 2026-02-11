import {
    Plugin,
    Notice,
    addIcon,
    setIcon,
} from "obsidian";
import { MegaClient } from "./mega-client";
import { SyncEngine, SyncResult } from "./sync-engine";
import { SyncState } from "./sync-state";
import { JSyncSettings, DEFAULT_SETTINGS, JSyncSettingTab } from "./settings";
import { formatRelativeTime } from "./utils";

// Custom SVG icon for JSync
const JSYNC_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M50 15 L50 85"/><path d="M30 35 L50 15 L70 35"/><path d="M30 65 L50 85 L70 65"/><circle cx="50" cy="50" r="40"/></svg>`;

export default class JSyncPlugin extends Plugin {
    settings: JSyncSettings = DEFAULT_SETTINGS;
    private megaClient: MegaClient = new MegaClient();
    private syncEngine!: SyncEngine;
    private syncState!: SyncState;
    private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
    private statusBarItem: HTMLElement | null = null;
    private ribbonIconEl: HTMLElement | null = null;
    private isSyncingFlag = false;
    private lastVaultChange = 0;

    async onload(): Promise<void> {
        console.log("[JSync] Loading plugin...");

        // Load settings
        await this.loadSettings();

        // Register custom icon
        addIcon("jsync-sync", JSYNC_ICON);

        // Initialize sync state & engine
        this.syncState = new SyncState(this.app.vault);
        this.syncEngine = new SyncEngine(
            this.app.vault,
            this.megaClient,
            this.syncState,
            this.settings
        );

        // Set up progress reporting
        this.syncEngine.onProgress((msg, current, total) => {
            this.updateStatusBar(`⚡ ${msg}`);
        });

        // ─── Ribbon Icon ─────────────────────────────────────
        this.ribbonIconEl = this.addRibbonIcon(
            "jsync-sync",
            "JSync: Sync Now",
            async () => {
                await this.triggerSync();
            }
        );

        // ─── Status Bar ──────────────────────────────────────
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar("JSync: Ready");

        // ─── Commands ────────────────────────────────────────
        this.addCommand({
            id: "jsync-sync-now",
            name: "Sync Now",
            callback: async () => {
                await this.triggerSync();
            },
        });

        this.addCommand({
            id: "jsync-force-full-sync",
            name: "Force Full Re-Sync",
            callback: async () => {
                await this.forceFullSync();
            },
        });

        this.addCommand({
            id: "jsync-pause-sync",
            name: "Toggle Auto-Sync",
            callback: async () => {
                this.settings.autoSyncEnabled = !this.settings.autoSyncEnabled;
                await this.saveSettings();
                this.scheduleAutoSync();
                const state = this.settings.autoSyncEnabled ? "enabled" : "paused";
                new Notice(`JSync: Auto-sync ${state}`);
                this.updateStatusBar(`JSync: Auto-sync ${state}`);
            },
        });

        this.addCommand({
            id: "jsync-connect",
            name: "Connect to MEGA",
            callback: async () => {
                await this.connectToMega();
            },
        });

        this.addCommand({
            id: "jsync-disconnect",
            name: "Disconnect from MEGA",
            callback: async () => {
                await this.megaClient.logout();
                new Notice("JSync: Disconnected from MEGA");
                this.updateStatusBar("JSync: Disconnected");
            },
        });

        // ─── Settings Tab ────────────────────────────────────
        this.addSettingTab(new JSyncSettingTab(this.app, this));

        // ─── Auto-Connect & Auto-Sync ────────────────────────
        // Delay startup to let Obsidian finish loading
        this.app.workspace.onLayoutReady(async () => {
            if (this.settings.megaEmail && this.settings.megaPassword) {
                try {
                    await this.connectToMega();
                    if (this.settings.autoSyncEnabled) {
                        // Initial sync after short delay
                        setTimeout(() => this.triggerSync(), 5000);
                    }
                } catch (e: any) {
                    console.warn("[JSync] Auto-connect failed:", e.message);
                }
            }
            this.scheduleAutoSync();
        });

        // ─── Vault change tracking for debounce ─────────────
        const trackChange = () => { this.lastVaultChange = Date.now(); };
        this.registerEvent(this.app.vault.on("modify", trackChange));
        this.registerEvent(this.app.vault.on("create", trackChange));
        this.registerEvent(this.app.vault.on("delete", trackChange));
        this.registerEvent(this.app.vault.on("rename", trackChange));

        console.log("[JSync] Plugin loaded successfully");
    }

    async onunload(): Promise<void> {
        console.log("[JSync] Unloading plugin...");

        // Cancel auto-sync
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }

        // Cancel any running sync
        if (this.syncEngine?.isBusy()) {
            this.syncEngine.cancel();
        }

        // Logout from MEGA
        await this.megaClient.logout();

        console.log("[JSync] Plugin unloaded");
    }

    // ────────────────────────────────────────────────────────────
    //  SETTINGS
    // ────────────────────────────────────────────────────────────

    async loadSettings(): Promise<void> {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);

        // Update sync engine settings reference
        if (this.syncEngine) {
            this.syncEngine = new SyncEngine(
                this.app.vault,
                this.megaClient,
                this.syncState,
                this.settings
            );
            this.syncEngine.onProgress((msg) => {
                this.updateStatusBar(`⚡ ${msg}`);
            });
        }
    }

    // ────────────────────────────────────────────────────────────
    //  MEGA CONNECTION
    // ────────────────────────────────────────────────────────────

    /**
     * Connect to MEGA with current credentials
     */
    async connectToMega(): Promise<void> {
        if (!this.settings.megaEmail || !this.settings.megaPassword) {
            new Notice("JSync: Please configure your MEGA credentials in settings");
            return;
        }

        this.updateStatusBar("JSync: Connecting...");

        try {
            await this.megaClient.login(
                this.settings.megaEmail,
                this.settings.megaPassword
            );
            this.updateStatusBar("JSync: Connected ✓");
            if (this.settings.showNotifications) {
                new Notice("JSync: Connected to MEGA ✓");
            }
        } catch (e: any) {
            this.updateStatusBar("JSync: Connection failed ✗");
            new Notice(`JSync: ${e.message}`);
            throw e;
        }
    }

    /**
     * Test MEGA connection (used by settings tab)
     */
    async testConnection(): Promise<void> {
        const tempClient = new MegaClient();
        try {
            await tempClient.login(
                this.settings.megaEmail,
                this.settings.megaPassword
            );
            new Notice("JSync: Connection successful! ✓");
            await tempClient.logout();
        } catch (e: any) {
            new Notice(`JSync: Connection failed — ${e.message}`);
            throw e;
        }
    }

    // ────────────────────────────────────────────────────────────
    //  SYNC OPERATIONS
    // ────────────────────────────────────────────────────────────

    /**
     * Trigger a sync operation
     */
    async triggerSync(): Promise<void> {
        if (this.isSyncingFlag) {
            new Notice("JSync: Sync already in progress");
            return;
        }

        if (!this.megaClient.isConnected()) {
            try {
                await this.connectToMega();
            } catch {
                return;
            }
        }

        this.isSyncingFlag = true;
        this.setRibbonSyncing(true);

        if (this.settings.showNotifications) {
            new Notice("JSync: Syncing...");
        }

        try {
            const result = await this.syncEngine.sync();
            this.handleSyncResult(result);
        } catch (e: any) {
            new Notice(`JSync: Sync failed — ${e.message}`);
            this.updateStatusBar("JSync: Sync failed ✗");
        } finally {
            this.isSyncingFlag = false;
            this.setRibbonSyncing(false);
        }
    }

    /**
     * Force a complete re-sync
     */
    async forceFullSync(): Promise<void> {
        if (this.isSyncingFlag) {
            new Notice("JSync: Sync already in progress");
            return;
        }

        if (!this.megaClient.isConnected()) {
            try {
                await this.connectToMega();
            } catch {
                return;
            }
        }

        this.isSyncingFlag = true;
        this.setRibbonSyncing(true);
        new Notice("JSync: Starting full re-sync...");

        try {
            const result = await this.syncEngine.forceFullSync();
            this.handleSyncResult(result);
        } catch (e: any) {
            new Notice(`JSync: Full sync failed — ${e.message}`);
            this.updateStatusBar("JSync: Sync failed ✗");
        } finally {
            this.isSyncingFlag = false;
            this.setRibbonSyncing(false);
        }
    }

    /**
     * Process and display sync results
     */
    private handleSyncResult(result: SyncResult): void {
        const parts: string[] = [];

        if (result.uploaded > 0) parts.push(`↑${result.uploaded}`);
        if (result.downloaded > 0) parts.push(`↓${result.downloaded}`);
        if (result.renames > 0) parts.push(`↔${result.renames}`);
        if (result.deletedLocal > 0) parts.push(`🗑L${result.deletedLocal}`);
        if (result.deletedRemote > 0) parts.push(`🗑R${result.deletedRemote}`);
        if (result.conflicts > 0) parts.push(`⚠${result.conflicts}`);
        const summary =
            parts.length > 0
                ? parts.join(" | ")
                : "no changes";

        const timeStr = `${(result.duration / 1000).toFixed(1)}s`;

        if (result.success) {
            const statusMsg = `JSync: ✓ ${summary} (${timeStr})`;
            this.updateStatusBar(statusMsg);

            if (this.settings.showNotifications) {
                new Notice(`JSync: Sync complete — ${summary}`);
            }
        } else {
            const errCount = result.errors.length;
            const statusMsg = `JSync: ✗ ${errCount} error(s)`;
            this.updateStatusBar(statusMsg);

            for (const err of result.errors) {
                new Notice(`JSync Error: ${err}`, 10000);
            }
        }
    }

    // ────────────────────────────────────────────────────────────
    //  AUTO-SYNC
    // ────────────────────────────────────────────────────────────

    /**
     * Schedule or cancel the auto-sync interval
     */
    scheduleAutoSync(): void {
        // Clear existing timer
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = null;
        }

        if (this.settings.autoSyncEnabled && this.settings.autoSyncInterval > 0) {
            const intervalMs = this.settings.autoSyncInterval * 60 * 1000;
            const debounceMs = (this.settings.syncDebounceSeconds ?? 10) * 1000;

            this.autoSyncTimer = setInterval(async () => {
                if (!this.isSyncingFlag && this.megaClient.isConnected()) {
                    // Debounce: skip if vault was changed recently
                    const elapsed = Date.now() - this.lastVaultChange;
                    if (this.lastVaultChange > 0 && elapsed < debounceMs) {
                        console.log(`[JSync] Auto-sync debounced (${Math.round(elapsed / 1000)}s < ${debounceMs / 1000}s)`);
                        return;
                    }
                    console.log("[JSync] Auto-sync triggered");
                    await this.triggerSync();
                }
            }, intervalMs);

            console.log(
                `[JSync] Auto-sync scheduled every ${this.settings.autoSyncInterval} minutes`
            );
        }
    }

    // ────────────────────────────────────────────────────────────
    //  UI HELPERS
    // ────────────────────────────────────────────────────────────

    /**
     * Update the status bar text
     */
    private updateStatusBar(message: string): void {
        if (this.statusBarItem) {
            this.statusBarItem.setText(message);
        }
    }

    /**
     * Set the ribbon icon to spinning/animating state
     */
    private setRibbonSyncing(syncing: boolean): void {
        if (this.ribbonIconEl) {
            if (syncing) {
                this.ribbonIconEl.addClass("jsync-syncing");
            } else {
                this.ribbonIconEl.removeClass("jsync-syncing");
            }
        }
    }
}
