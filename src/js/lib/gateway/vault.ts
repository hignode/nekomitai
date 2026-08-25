/**
 * Shared at-rest encryption for the two things Nekomitai stores that are
 * genuinely credentials: the Web-Mode cookie jar and Spotify's OAuth tokens.
 *
 * The guarantees, restated because they are the whole point:
 * - Secrets live ONLY on this machine, AES-256-GCM, with a random key kept in
 *   a separate keyfile next to the vault.
 * - They are never sent anywhere except back to the service they belong to.
 *   There is no Nekomitai server and no analytics.
 * - At-rest encryption protects against the state folder being copied or
 *   cloud-synced (%APPDATA% is inside OneDrive's scope on plenty of machines).
 *   It is NOT protection against someone already inside this user account —
 *   they can read the keyfile too. Treat it like a password manager's vault.
 *
 * The on-disk layout is byte-identical to the original cookies-only version —
 * iv(12) | tag(16) | ciphertext — so existing cookies.vault files keep
 * decrypting now that this has been factored out of cookies.ts.
 */
import { fs, path, os, crypto } from "../cep/node";

/** %APPDATA%\Nekomitai (macOS: ~/Library/Application Support/Nekomitai). */
export const dataDir = (): string => {
  const base =
    process.env.APPDATA ||
    (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), ".config"));
  const dir = path.join(base, "Nekomitai");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const getKey = (keyFile: string): Buffer => {
  const p = path.join(dataDir(), keyFile);
  try {
    const b = fs.readFileSync(p);
    if (b.length === 32) return b;
  } catch {
    /* generate below */
  }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(p, key, { mode: 0o600 });
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      /* Windows ignores chmod; ACL hardening is out of scope */
    }
  } catch {
    /* if we can't persist the key, encryption is session-only */
  }
  return key;
};

/** Encrypt `value` as JSON into `vaultFile`. Best-effort: returns false if the
 * write failed rather than throwing into a request handler. */
export const writeVault = (
  vaultFile: string,
  keyFile: string,
  value: unknown
): boolean => {
  try {
    const plain = Buffer.from(JSON.stringify(value), "utf8");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getKey(keyFile), iv);
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(path.join(dataDir(), vaultFile), Buffer.concat([iv, tag, enc]), {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
};

/** Decrypt `vaultFile`, or null when it does not exist / won't authenticate
 * (a wiped keyfile, a truncated write) — callers start empty in that case. */
export const readVault = <T>(vaultFile: string, keyFile: string): T | null => {
  try {
    const buf = fs.readFileSync(path.join(dataDir(), vaultFile));
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(keyFile), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as T;
  } catch {
    return null;
  }
};

/** Forget a vault entirely (Settings' "disconnect" / "clear"). */
export const dropVault = (vaultFile: string): void => {
  try {
    fs.unlinkSync(path.join(dataDir(), vaultFile));
  } catch {
    /* already gone */
  }
};
