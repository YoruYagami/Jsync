import { App, PluginSettingTab, Setting } from "obsidian";
import type JSyncPlugin from "./main";

/**
 * Plugin settings data model
 */
export interface JSyncSettings {
    /** MEGA account email */
    megaEmail: string;
    /** MEGA account password */
    megaPassword: string;
    /** Root folder on MEGA for synced vault */
    remoteFolder: string;
    /** Minutes between auto-syncs */
    autoSyncInterval: number;
    /** Whether auto-sync is active */
    autoSyncEnabled: boolean;
    /** Whether to sync binary attachments */
    syncAttachments: boolean;
    /** Conflict strategy: "copy", "remote-wins", "local-wins" */
    conflictStrategy: "copy" | "remote-wins" | "local-wins";
    /** Folders to never sync */
    excludedFolders: string[];
    /** Skip files larger than this (MB) */
    maxFileSizeMB: number;
    /** Show notifications for sync events */
    showNotifications: boolean;
}

/**
 * Default settings
 */
export const DEFAULT_SETTINGS: JSyncSettings = {
    megaEmail: "",
    megaPassword: "",
    remoteFolder: "/JSync",
    autoSyncInterval: 5,
    autoSyncEnabled: true,
    syncAttachments: true,
    conflictStrategy: "copy",
    excludedFolders: [".obsidian", ".trash"],
    maxFileSizeMB: 50,
    showNotifications: true,
};

/**
 * Settings tab UI
 */
export class JSyncSettingTab extends PluginSettingTab {
    plugin: JSyncPlugin;

    constructor(app: App, plugin: JSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ─── Header ──────────────────────────────────────────
        containerEl.createEl("h1", { text: "⚡ JSync Settings" });
        containerEl.createEl("p", {
            text: "Joplin-style bidirectional sync for your vault via MEGA cloud storage.",
            cls: "setting-item-description",
        });

        // ─── MEGA Connection ─────────────────────────────────
        containerEl.createEl("h2", { text: "🔐 MEGA Account" });

        new Setting(containerEl)
            .setName("Email")
            .setDesc("Your MEGA account email address")
            .addText((text) =>
                text
                    .setPlaceholder("user@example.com")
                    .setValue(this.plugin.settings.megaEmail)
                    .onChange(async (value) => {
                        this.plugin.settings.megaEmail = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Password")
            .setDesc("Your MEGA account password (stored locally in plugin data)")
            .addText((text) => {
                text
                    .setPlaceholder("••••••••")
                    .setValue(this.plugin.settings.megaPassword)
                    .onChange(async (value) => {
                        this.plugin.settings.megaPassword = value;
                        await this.plugin.saveSettings();
                    });
                // Make it a password field
                text.inputEl.type = "password";
                text.inputEl.autocomplete = "off";
            });

        new Setting(containerEl)
            .setName("Test Connection")
            .setDesc("Verify your MEGA credentials work")
            .addButton((btn) =>
                btn
                    .setButtonText("Test")
                    .setCta()
                    .onClick(async () => {
                        btn.setButtonText("Testing...");
                        btn.setDisabled(true);
                        try {
                            await this.plugin.testConnection();
                            btn.setButtonText("✅ Connected!");
                        } catch (e: any) {
                            btn.setButtonText("❌ Failed");
                            console.error("[JSync] Connection test failed:", e);
                        }
                        setTimeout(() => {
                            btn.setButtonText("Test");
                            btn.setDisabled(false);
                        }, 3000);
                    })
            );

        // ─── Sync Configuration ──────────────────────────────
        containerEl.createEl("h2", { text: "🔄 Sync Configuration" });

        new Setting(containerEl)
            .setName("Remote Folder")
            .setDesc("Root folder path on MEGA where vault files will be synced")
            .addText((text) =>
                text
                    .setPlaceholder("/JSync")
                    .setValue(this.plugin.settings.remoteFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.remoteFolder = value || "/JSync";
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Auto-Sync")
            .setDesc("Automatically sync vault in the background")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoSyncEnabled)
                    .onChange(async (value) => {
                        this.plugin.settings.autoSyncEnabled = value;
                        await this.plugin.saveSettings();
                        this.plugin.scheduleAutoSync();
                    })
            );

        new Setting(containerEl)
            .setName("Sync Interval (minutes)")
            .setDesc("How often to auto-sync (minimum 1 minute)")
            .addSlider((slider) =>
                slider
                    .setLimits(1, 60, 1)
                    .setValue(this.plugin.settings.autoSyncInterval)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.autoSyncInterval = value;
                        await this.plugin.saveSettings();
                        this.plugin.scheduleAutoSync();
                    })
            );

        new Setting(containerEl)
            .setName("Sync Attachments")
            .setDesc("Synchronize binary files (images, PDFs, etc.)")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.syncAttachments)
                    .onChange(async (value) => {
                        this.plugin.settings.syncAttachments = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Max File Size (MB)")
            .setDesc("Skip files larger than this size")
            .addSlider((slider) =>
                slider
                    .setLimits(1, 200, 1)
                    .setValue(this.plugin.settings.maxFileSizeMB)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.maxFileSizeMB = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ─── Conflict Resolution ─────────────────────────────
        containerEl.createEl("h2", { text: "⚠️ Conflict Resolution" });

        new Setting(containerEl)
            .setName("Conflict Strategy")
            .setDesc(
                "How to handle files modified on both sides since last sync"
            )
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("copy", "Create conflict copy (safest)")
                    .addOption("remote-wins", "Remote version wins")
                    .addOption("local-wins", "Local version wins")
                    .setValue(this.plugin.settings.conflictStrategy)
                    .onChange(async (value) => {
                        this.plugin.settings.conflictStrategy = value as any;
                        await this.plugin.saveSettings();
                    })
            );

        // ─── Exclusions ──────────────────────────────────────
        containerEl.createEl("h2", { text: "🚫 Exclusions" });

        new Setting(containerEl)
            .setName("Excluded Folders")
            .setDesc(
                "Folders to exclude from sync (comma-separated). '.jsync' is always excluded."
            )
            .addTextArea((text) =>
                text
                    .setPlaceholder(".obsidian, .trash")
                    .setValue(this.plugin.settings.excludedFolders.join(", "))
                    .onChange(async (value) => {
                        this.plugin.settings.excludedFolders = value
                            .split(",")
                            .map((s) => s.trim())
                            .filter((s) => s.length > 0);
                        await this.plugin.saveSettings();
                    })
            );

        // ─── Notifications ───────────────────────────────────
        containerEl.createEl("h2", { text: "🔔 Notifications" });

        new Setting(containerEl)
            .setName("Show Sync Notifications")
            .setDesc("Display notices when sync starts, completes, or encounters errors")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.showNotifications)
                    .onChange(async (value) => {
                        this.plugin.settings.showNotifications = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ─── Danger Zone ─────────────────────────────────────
        containerEl.createEl("h2", { text: "🗑️ Danger Zone" });

        new Setting(containerEl)
            .setName("Force Full Re-Sync")
            .setDesc(
                "Reset sync state and perform a complete re-sync. Use if sync gets out of alignment."
            )
            .addButton((btn) =>
                btn
                    .setButtonText("Force Full Sync")
                    .setWarning()
                    .onClick(async () => {
                        btn.setButtonText("Syncing...");
                        btn.setDisabled(true);
                        try {
                            await this.plugin.forceFullSync();
                            btn.setButtonText("✅ Done!");
                        } catch (e: any) {
                            btn.setButtonText("❌ Failed");
                        }
                        setTimeout(() => {
                            btn.setButtonText("Force Full Sync");
                            btn.setDisabled(false);
                        }, 3000);
                    })
            );
    }
}
