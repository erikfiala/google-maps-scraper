import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * Acquire an exclusive lock file (O_EXCL / wx). Returns false if already held.
 */
export function tryAcquireLock(lockPath: string): boolean {
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  }
}

/** Remove a lock only if this process owns it (PID match). */
export function releaseOwnLock(lockPath: string): void {
  try {
    if (!existsSync(lockPath)) return;
    const owner = readFileSync(lockPath, "utf8").trim();
    if (owner !== String(process.pid)) return;
    rmSync(lockPath);
  } catch {
    // best-effort; stale locks are documented in README
  }
}

export function lockExists(lockPath: string): boolean {
  return existsSync(lockPath);
}
