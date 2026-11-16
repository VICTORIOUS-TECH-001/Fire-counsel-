// A resettable browser-installation marker, not a hardware fingerprint or an
// IP-derived identity. Never remove it on sign-out or mix it with study data.
export const INSTALLATION_KEY = "fire-counsel-installation-v1";
export const INSTALLATION_HEADER = "X-Fire-Counsel-Installation";
export const INSTALLATION_POLICY = "browser-installation-v1";

export async function browserInstallation(options = {}) {
  try {
    function persist() {
      const storage = options.storage ?? globalThis.localStorage;
      const random = options.random ?? globalThis.crypto;
      const saved = storage.getItem(INSTALLATION_KEY);
      if (saved !== null) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(saved)) throw new Error("invalid saved identifier");
        return saved;
      }
      const bytes = random.getRandomValues(new Uint8Array(32));
      const value = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      storage.setItem(INSTALLATION_KEY, value);
      if (storage.getItem(INSTALLATION_KEY) !== value) throw new Error("identifier was not saved");
      return value;
    }
    // Serialize creation across tabs where Web Locks are supported. The marker
    // already persists before any explicit profile-registration request.
    const locks = options.locks ?? globalThis.navigator?.locks;
    return locks ? await locks.request(INSTALLATION_KEY, persist) : persist();
  } catch {
    // Never silently fall back to a temporary token or replace a damaged token:
    // that would make an existing, bound account inaccessible on the next load.
    throw new Error("Persistent browser storage is required for your account installation. Saved data could not be read or written. Do not clear browser data; local study is still available.");
  }
}

export function needsStudentInstallation(pathname) {
  return /^\/api\/v1\/(?:profile|materials|research)(?:\/|$)/.test(pathname);
}
