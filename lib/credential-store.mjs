import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;

async function ensureSecret(secretPath) {
  if (process.env.LOCAL_TOOLBOX_SECRET) {
    return process.env.LOCAL_TOOLBOX_SECRET;
  }
  if (existsSync(secretPath)) {
    return readFile(secretPath, "utf8");
  }
  await mkdir(path.dirname(secretPath), { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  await writeFile(secretPath, secret, { mode: 0o600 });
  await chmod(secretPath, 0o600).catch(() => undefined);
  return secret;
}

function encryptJson(value, secret) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = scryptSync(secret, salt, KEY_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString("base64");
}

function decryptJson(payload, secret) {
  const raw = Buffer.from(payload, "base64");
  const salt = raw.subarray(0, SALT_BYTES);
  const iv = raw.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const tag = raw.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + 16);
  const encrypted = raw.subarray(SALT_BYTES + IV_BYTES + 16);
  const key = scryptSync(secret, salt, KEY_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

export class CredentialStore {
  constructor({ dataDir = ".local-toolbox" } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.dbPath = path.join(this.dataDir, "toolbox.sqlite");
    this.secretPath = path.join(this.dataDir, "secret.key");
    this.ready = false;
  }

  async init() {
    if (this.ready) {
      return;
    }
    await mkdir(this.dataDir, { recursive: true });
    this.secret = await ensureSecret(this.secretPath);
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        service TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.ready = true;
  }

  async save(service, { username, password }) {
    await this.init();
    const cleanService = String(service || "").trim();
    const cleanUsername = String(username || "").trim();
    if (!cleanService) {
      throw new Error("service is required.");
    }
    if (!cleanUsername || !password) {
      throw new Error("username and password are required.");
    }
    const encrypted = encryptJson({ password: String(password) }, this.secret);
    this.db.prepare(`
      INSERT INTO credentials (service, username, encrypted_payload, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(service) DO UPDATE SET
        username = excluded.username,
        encrypted_payload = excluded.encrypted_payload,
        updated_at = excluded.updated_at
    `).run(cleanService, cleanUsername, encrypted);
  }

  async get(service) {
    await this.init();
    const row = this.db.prepare(`
      SELECT service, username, encrypted_payload, updated_at
      FROM credentials
      WHERE service = ?
    `).get(String(service || "").trim());
    if (!row) {
      return undefined;
    }
    const payload = decryptJson(row.encrypted_payload, this.secret);
    return {
      service: row.service,
      username: row.username,
      password: payload.password,
      updatedAt: row.updated_at
    };
  }

  async getMeta(service) {
    await this.init();
    const row = this.db.prepare(`
      SELECT service, username, updated_at
      FROM credentials
      WHERE service = ?
    `).get(String(service || "").trim());
    if (!row) {
      return { configured: false };
    }
    return {
      configured: true,
      service: row.service,
      username: row.username,
      updatedAt: row.updated_at
    };
  }
}
