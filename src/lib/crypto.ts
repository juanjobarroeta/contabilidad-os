import crypto from "crypto";

/**
 * Application-level envelope encryption for secrets at rest (CSD/FIEL private
 * keys + passwords, Facturapi API keys). AES-256-GCM (authenticated).
 *
 * Stored format:  enc:v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 * The master key comes from CREDENTIALS_ENCRYPTION_KEY (32 random bytes,
 * base64). Generate with:  openssl rand -base64 32
 *
 * Backward compatibility: decryptSecret() passes through any value WITHOUT the
 * "enc:v1:" prefix unchanged, so legacy plaintext rows keep working and get
 * re-encrypted the next time they're written. This lets us roll out without a
 * data migration.
 *
 * NOTE: a key in env is a big step up from plaintext-in-DB (a DB dump alone is
 * now useless), but it is not a substitute for a real KMS/HSM — that's the next
 * hardening step. Never log decrypted values.
 */

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";

/** Parse a base64 master key into a 32-byte buffer (validates length). */
export function parseKey(raw: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "La clave debe ser 32 bytes en base64 (genera con: openssl rand -base64 32)"
    );
  }
  return key;
}

function getKey(): Buffer | null {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  return raw ? parseKey(raw) : null;
}

export function encryptionConfigured(): boolean {
  return Boolean(process.env.CREDENTIALS_ENCRYPTION_KEY);
}

/** True if a stored value is in our encrypted envelope format. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypt with an explicit key (used by both the env helper and key rotation). */
export function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":")
  );
}

/** Decrypt with an explicit key. Legacy plaintext (no prefix) is returned as-is. */
export function decryptWithKey(stored: string, key: Buffer): string {
  if (!isEncrypted(stored)) return stored;
  const parts = stored.split(":"); // ["enc","v1",iv,tag,ct]
  const iv = Buffer.from(parts[2], "base64");
  const tag = Buffer.from(parts[3], "base64");
  const ct = Buffer.from(parts[4], "base64");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Encrypt a secret for storage.
 *
 * - Production: CREDENTIALS_ENCRYPTION_KEY is REQUIRED. If it's missing or
 *   invalid we THROW instead of writing plaintext — a secret must never be
 *   stored sin cifrar in production. Callers surface the error as a 500 with
 *   the Spanish message.
 * - Development: without a key we fall back to plaintext (so local dev works)
 *   but warn loudly. An invalid key still throws (config typo — fix it).
 */
export function encryptSecret(plaintext: string): string {
  const isProduction = process.env.NODE_ENV === "production";
  let key: Buffer | null;
  try {
    key = getKey();
  } catch (e) {
    if (isProduction) {
      throw new Error(
        "CREDENTIALS_ENCRYPTION_KEY no es válida (debe ser 32 bytes en base64; genera una con: openssl rand -base64 32). El secreto no fue guardado."
      );
    }
    throw e; // desarrollo: la clave existe pero es inválida — superficie el error de configuración
  }
  if (!key) {
    if (isProduction) {
      throw new Error(
        "CREDENTIALS_ENCRYPTION_KEY es obligatoria en producción: el secreto no fue guardado para no almacenarlo en texto claro. Configura la variable (32 bytes en base64; genera una con: openssl rand -base64 32) y vuelve a intentar."
      );
    }
    console.warn(
      "[crypto] CREDENTIALS_ENCRYPTION_KEY not set — storing secret WITHOUT encryption. Set it in production."
    );
    return plaintext;
  }
  return encryptWithKey(plaintext, key);
}

/** Decrypt a stored secret. Legacy plaintext (no prefix) is returned as-is. */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored; // legacy plaintext — pass through
  const key = getKey();
  if (!key) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY no configurada: no se puede descifrar un secreto cifrado"
    );
  }
  return decryptWithKey(stored, key);
}

/** Encrypt when present; pass null/undefined through (for optional fields). */
export function encryptNullable(value: string | null | undefined): string | undefined {
  return value ? encryptSecret(value) : undefined;
}

/** Decrypt when present; return null otherwise. */
export function decryptNullable(value: string | null | undefined): string | null {
  return value ? decryptSecret(value) : null;
}
