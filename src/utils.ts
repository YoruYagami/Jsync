import { createHash } from "crypto";

/**
 * Compute MD5 hash of content for change detection
 */
export function computeHash(content: string | Buffer): string {
    const hash = createHash("md5");
    if (typeof content === "string") {
        hash.update(content, "utf-8");
    } else {
        hash.update(content);
    }
    return hash.digest("hex");
}

/**
 * Normalize path separators to forward slashes and remove trailing slash
 */
export function normalizePath(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

/**
 * Generate a conflict filename
 * e.g. "notes/daily.md" → "notes/daily (conflict 2026-02-11 143000).md"
 */
export function generateConflictName(filePath: string, date: Date): string {
    const dotIdx = filePath.lastIndexOf(".");
    const ext = dotIdx !== -1 ? filePath.substring(dotIdx) : "";
    const base = dotIdx !== -1 ? filePath.substring(0, dotIdx) : filePath;
    const ts = date
        .toISOString()
        .replace(/T/, " ")
        .replace(/:/g, "")
        .replace(/\..+/, "");
    return `${base} (conflict ${ts})${ext}`;
}

/**
 * Async delay for rate limiting
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sanitize a remote path segment for MEGA — remove chars that could cause issues
 */
export function sanitizeRemotePath(path: string): string {
    return normalizePath(path).replace(/[<>:"|?*]/g, "_");
}

/**
 * Check if a file is binary by extension
 */
const TEXT_EXTENSIONS = new Set([
    "md", "txt", "json", "yaml", "yml", "css", "js", "ts", "html", "xml",
    "csv", "svg", "ini", "cfg", "conf", "toml", "log", "env", "sh", "bat",
    "ps1", "py", "rb", "java", "c", "cpp", "h", "hpp", "rs", "go",
    "canvas", "excalidraw",
]);

export function isBinaryFile(filePath: string): boolean {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    return !TEXT_EXTENSIONS.has(ext);
}

/**
 * Get the parent path of a file path
 */
export function getParentPath(filePath: string): string {
    const normalized = normalizePath(filePath);
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash <= 0) return "";
    return normalized.substring(0, lastSlash);
}

/**
 * Get all ancestor directories for a given path
 * e.g. "a/b/c/file.md" → ["a", "a/b", "a/b/c"]
 */
export function getAncestorDirs(filePath: string): string[] {
    const parts = normalizePath(filePath).split("/");
    parts.pop(); // remove filename
    const dirs: string[] = [];
    for (let i = 1; i <= parts.length; i++) {
        dirs.push(parts.slice(0, i).join("/"));
    }
    return dirs;
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Format a Date to a human-readable relative time string
 */
export function formatRelativeTime(date: Date): string {
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);

    if (diffSec < 60) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    return date.toLocaleDateString();
}
