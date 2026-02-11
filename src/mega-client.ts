import { Storage, File as MegaFile, MutableFile, API } from "megajs";
import { normalizePath, sleep } from "./utils";

/**
 * Remote item metadata returned by list/stat operations
 */
export interface RemoteItem {
    name: string;
    path: string;
    isFolder: boolean;
    size: number;
    lastModified: number; // ms since epoch
    nodeId?: string;
}

/**
 * Connection status
 */
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * MEGA client wrapper providing a Joplin-style FileApi interface
 */
export class MegaClient {
    private storage: Storage | null = null;
    private status: ConnectionStatus = "disconnected";
    private nodeCache: Map<string, MutableFile | MegaFile> = new Map();
    private lastError: string = "";
    private email: string = "";
    private password: string = "";

    getStatus(): ConnectionStatus {
        return this.status;
    }

    getLastError(): string {
        return this.lastError;
    }

    /**
     * Authenticate with MEGA and wait for the storage to be ready
     */
    async login(email: string, password: string): Promise<void> {
        this.status = "connecting";
        this.lastError = "";
        this.email = email;
        this.password = password;

        try {
            this.storage = new Storage({
                email,
                password,
                autologin: true,
            });

            await new Promise<void>((resolve, reject) => {
                if (!this.storage) return reject(new Error("Storage is null"));

                const onReady = () => {
                    cleanup();
                    resolve();
                };
                const onError = (err: Error) => {
                    cleanup();
                    reject(err);
                };
                const cleanup = () => {
                    this.storage?.removeListener("ready", onReady);
                    // error listener is removed after resolution
                };

                this.storage.once("ready", onReady);
                (this.storage as any).once("error", onError);
            });

            this.status = "connected";
            this.nodeCache.clear();
            console.log("[JSync] MEGA login successful");
        } catch (e: any) {
            this.status = "error";
            this.lastError = e?.message || String(e);
            this.storage = null;
            throw new Error(`MEGA login failed: ${this.lastError}`);
        }
    }

    /**
     * Close the MEGA connection
     */
    async logout(): Promise<void> {
        if (this.storage) {
            try {
                this.storage.close();
            } catch (e) {
                // ignore close errors
            }
            this.storage = null;
        }
        this.status = "disconnected";
        this.nodeCache.clear();
        console.log("[JSync] MEGA logout");
    }

    /**
     * Reconnect to MEGA (re-login to refresh the internal filesystem tree).
     * MEGA's SDK caches the file tree at login; this forces a full refresh
     * so newly uploaded/deleted files from other devices are visible.
     */
    async reload(): Promise<void> {
        if (!this.email || !this.password) {
            throw new Error("Cannot reload: no credentials stored");
        }
        await this.logout();
        await this.login(this.email, this.password);
    }

    /**
     * Check if connected
     */
    isConnected(): boolean {
        return this.status === "connected" && this.storage !== null;
    }

    /**
     * Ensure we have a valid connection
     */
    private ensureConnected(): Storage {
        if (!this.storage || this.status !== "connected") {
            throw new Error("MEGA client is not connected. Please login first.");
        }
        return this.storage;
    }

    /**
     * Navigate to a node by path, creating directories as needed if create=true
     */
    private async resolveNode(
        remotePath: string,
        createDirs: boolean = false
    ): Promise<MutableFile | MegaFile | null> {
        const storage = this.ensureConnected();
        const normalPath = normalizePath(remotePath);

        // Check cache first
        if (this.nodeCache.has(normalPath)) {
            return this.nodeCache.get(normalPath)!;
        }

        const parts = normalPath.split("/").filter((p) => p.length > 0);
        let current: MutableFile | MegaFile = storage.root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;

            // Find child with matching name
            const children = (current as MutableFile).children;
            if (!children) {
                if (createDirs && !isLast) {
                    // Create missing directory
                    current = await this.createFolder(current as MutableFile, part);
                    continue;
                }
                return null;
            }

            const child = children.find(
                (c: MegaFile) => c.name === part
            );

            if (!child) {
                if (createDirs && !isLast) {
                    current = await this.createFolder(current as MutableFile, part);
                    continue;
                }
                return null;
            }

            current = child as MutableFile;
        }

        // Cache the resolved node
        this.nodeCache.set(normalPath, current);
        return current;
    }

    /**
     * Create a subfolder within a parent folder
     */
    private async createFolder(
        parent: MutableFile,
        name: string
    ): Promise<MutableFile> {
        return new Promise<MutableFile>((resolve, reject) => {
            parent.mkdir(name, (err: Error | null, folder: MutableFile) => {
                if (err) reject(err);
                else resolve(folder);
            });
        });
    }

    /**
     * Create a directory path on MEGA (recursive)
     */
    async mkdir(remotePath: string): Promise<void> {
        const storage = this.ensureConnected();
        const normalPath = normalizePath(remotePath);
        const parts = normalPath.split("/").filter((p) => p.length > 0);

        let current: MutableFile = storage.root;

        for (const part of parts) {
            const children = (current as MutableFile).children;
            let child: MutableFile | undefined;

            if (children) {
                child = children.find(
                    (c: MegaFile) => c.name === part
                ) as MutableFile | undefined;
            }

            if (child && child.directory) {
                current = child;
            } else {
                current = await this.createFolder(current, part);
            }
        }

        this.nodeCache.set(normalPath, current);
    }

    /**
     * Upload/overwrite a file at the given remote path
     */
    async put(remotePath: string, content: Buffer | string): Promise<void> {
        const storage = this.ensureConnected();
        const normalPath = normalizePath(remotePath);

        // Ensure parent directories exist
        const parentPath = normalPath.substring(0, normalPath.lastIndexOf("/"));
        const fileName = normalPath.substring(normalPath.lastIndexOf("/") + 1);

        if (parentPath) {
            await this.mkdir(parentPath);
        }

        // Check if file already exists — delete it first
        const existingNode = await this.resolveNode(normalPath, false);
        if (existingNode && !(existingNode as MutableFile).directory) {
            await this.deleteNode(existingNode as MutableFile);
            this.nodeCache.delete(normalPath);
        }

        // Get parent node
        const parentNode = parentPath
            ? await this.resolveNode(parentPath, true)
            : storage.root;

        if (!parentNode) {
            throw new Error(`Could not resolve parent path: ${parentPath}`);
        }

        const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;

        // Upload the file
        await new Promise<void>((resolve, reject) => {
            const uploadStream = (parentNode as MutableFile).upload(
                { name: fileName, size: buf.length },
                buf,
                (err: Error | null) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
            // Handle stream error
            uploadStream.on("error", (err: Error) => reject(err));
        });

        // Invalidate cache for this file and parent
        this.nodeCache.delete(normalPath);
        this.nodeCache.delete(parentPath);

        // Small delay to avoid rate limiting
        await sleep(200);
    }

    /**
     * Download file content from MEGA
     */
    async get(remotePath: string): Promise<Buffer> {
        const normalPath = normalizePath(remotePath);
        const node = await this.resolveNode(normalPath, false);

        if (!node) {
            throw new Error(`File not found on MEGA: ${normalPath}`);
        }

        if ((node as MutableFile).directory) {
            throw new Error(`Path is a directory, not a file: ${normalPath}`);
        }

        return new Promise<Buffer>((resolve, reject) => {
            const downloadStream = (node as MegaFile).download({});
            const chunks: Buffer[] = [];

            downloadStream.on("data", (chunk: Buffer) => chunks.push(chunk));
            downloadStream.on("end", () => resolve(Buffer.concat(chunks)));
            downloadStream.on("error", (err: Error) => reject(err));
        });
    }

    /**
     * Download file content, returns null if file doesn't exist
     */
    async getOrNull(remotePath: string): Promise<Buffer | null> {
        try {
            return await this.get(remotePath);
        } catch {
            return null;
        }
    }

    /**
     * Delete a file or folder from MEGA
     */
    async delete(remotePath: string): Promise<void> {
        const normalPath = normalizePath(remotePath);
        const node = await this.resolveNode(normalPath, false);

        if (!node) {
            // Already deleted — nothing to do
            return;
        }

        await this.deleteNode(node as MutableFile);
        this.nodeCache.delete(normalPath);

        await sleep(100);
    }

    /**
     * Delete a MEGA node (permanently)
     */
    private async deleteNode(node: MutableFile): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            node.delete(true, (err: Error | null) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * List files and folders in a remote directory
     */
    async list(remotePath: string): Promise<RemoteItem[]> {
        const normalPath = normalizePath(remotePath);
        const node = await this.resolveNode(normalPath, false);

        if (!node) {
            return [];
        }

        if (!(node as MutableFile).directory) {
            throw new Error(`Path is not a directory: ${normalPath}`);
        }

        const children = (node as MutableFile).children || [];
        const result: RemoteItem[] = [];

        for (const child of children) {
            const childPath = normalPath ? `${normalPath}/${child.name}` : child.name!;
            result.push({
                name: child.name || "",
                path: childPath,
                isFolder: !!(child as MutableFile).directory,
                size: child.size || 0,
                lastModified: child.timestamp
                    ? child.timestamp * 1000
                    : Date.now(),
                nodeId: child.nodeId,
            });
        }

        return result;
    }

    /**
     * Recursively list all files under a remote path
     */
    async listRecursive(remotePath: string): Promise<RemoteItem[]> {
        const items = await this.list(remotePath);
        const result: RemoteItem[] = [];

        for (const item of items) {
            if (item.isFolder) {
                const subItems = await this.listRecursive(item.path);
                result.push(...subItems);
            } else {
                result.push(item);
            }
        }

        return result;
    }

    /**
     * Get metadata for a single remote file/folder
     */
    async stat(remotePath: string): Promise<RemoteItem | null> {
        const normalPath = normalizePath(remotePath);
        const node = await this.resolveNode(normalPath, false);

        if (!node) {
            return null;
        }

        return {
            name: node.name || "",
            path: normalPath,
            isFolder: !!(node as MutableFile).directory,
            size: node.size || 0,
            lastModified: node.timestamp
                ? node.timestamp * 1000
                : Date.now(),
            nodeId: node.nodeId,
        };
    }

    /**
     * Check if a remote path exists
     */
    async exists(remotePath: string): Promise<boolean> {
        const node = await this.resolveNode(normalizePath(remotePath), false);
        return node !== null;
    }

    /**
     * Clear the internal node cache (useful after write operations)
     */
    clearCache(): void {
        this.nodeCache.clear();
    }
}
