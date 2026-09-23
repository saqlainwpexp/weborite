import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Passwords, API keys and tokens are stored encrypted (AES-256-GCM). The key that encrypts them
 * lives in data/secret.key, itself encrypted with Windows DPAPI for the current Windows user, so a
 * copy of the data folder (backup, cloud sync, another PC or account) can't read them.
 * One DPAPI call at startup unlocks the key; everything after that is in-process.
 */

const PREFIX = "enc:v1:";
let key: Buffer | null = null;
let keyError: Error | null = null; // unlocking failed: don't block every request retrying PowerShell
let warned = false;
let keyFile = "";

/** Called once from db.ts with the data folder. */
export function initVault(dataDir: string) {
  keyFile = join(dataDir, "secret.key");
}

const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** DPAPI through PowerShell: base64 in on stdin (never on the command line), base64 out. */
function dpapi(op: "Protect" | "Unprotect", data: Buffer) {
  const script = `Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b, $null, 'CurrentUser'))`;
  const out = execFileSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { input: data.toString("base64"), encoding: "utf8", windowsHide: true, timeout: 30000, stdio: "pipe" });
  return Buffer.from(out.trim(), "base64");
}

function loadKey(): Buffer {
  if (key) return key;
  if (keyError) throw keyError;
  if (!keyFile) throw new Error("Vault used before initVault()");
  const win = process.platform === "win32";
  if (existsSync(keyFile)) {
    try {
      const f = JSON.parse(readFileSync(keyFile, "utf8")) as { v: number; dpapi?: string; raw?: string };
      key = f.dpapi ? dpapi("Unprotect", Buffer.from(f.dpapi, "base64")) : Buffer.from(f.raw ?? "", "base64");
      if (key.length !== 32) throw new Error("wrong key length");
    } catch (e) {
      // PowerShell failing to run says nothing about the key: stop rather than set a good key aside.
      const detail = `${(e as Error).message} ${String((e as { stderr?: unknown }).stderr ?? "")}`;
      if (!/Cryptographic|not valid for use|data is invalid|wrong key length|JSON/i.test(detail)) {
        keyError = new Error(`Couldn't unlock saved passwords (restart the app to retry): ${detail.slice(0, 300)}`);
        console.error(keyError.message);
        throw keyError;
      }
      // Copied from another Windows account or PC: those passwords are gone either way. Keep the old
      // key file aside and start a new one so passwords entered again can be saved.
      const aside = `${keyFile}.unreadable-${Date.now()}`;
      renameSync(keyFile, aside);
      const why = String((e as { stderr?: unknown }).stderr ?? "").match(/argument\(s\): "([^"]+)/)?.[1]?.trim() || (e as Error).message.split("\n")[0];
      console.warn(`Saved passwords can't be unlocked on this Windows account (${why}). Kept the old key as ${aside}; enter the passwords again.`);
      key = null;
      return loadKey();
    }
  } else {
    key = randomBytes(32);
    // Outside Windows there's no DPAPI: the key is only as safe as the folder (the app ships for Windows).
    const f = win ? { v: 1, dpapi: dpapi("Protect", key).toString("base64") } : { v: 1, raw: key.toString("base64") };
    writeFileSync(keyFile, JSON.stringify(f), { mode: 0o600 });
  }
  return key;
}

export const isSealed = (v: string) => v.startsWith(PREFIX);

/** Encrypt a secret for storage. Empty stays empty so "is it set?" checks keep working. */
export function seal(plain: string): string {
  if (!plain || isSealed(plain)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", loadKey(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

/** Decrypt a stored secret. Values saved before encryption existed pass through unchanged. */
export function open(stored: string): string {
  if (!stored || !isSealed(stored)) return stored ?? "";
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
    const d = createDecipheriv("aes-256-gcm", loadKey(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  } catch (e) {
    // Another Windows user or PC, or a replaced secret.key: treat as not set so it can be re-entered.
    if (!warned) console.warn(`Some saved passwords couldn't be decrypted (${(e as Error).message}). They show as not set: enter them again in the app.`);
    warned = true;
    return "";
  }
}
