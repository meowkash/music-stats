// localStorage throws outright in Safari private mode and in partitioned
// third-party contexts, so every preference read/write goes through these.

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A preference that fails to persist is not worth interrupting anything for.
  }
}
