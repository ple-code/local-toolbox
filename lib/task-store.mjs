import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

function safeJson(value, fallback = {}) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeTaskId(value) {
  const id = String(value || "").trim();
  if (!id) {
    return randomUUID();
  }
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) {
    throw new Error("taskId is invalid.");
  }
  return id;
}

export class TaskStore {
  constructor({ dataDir = ".local-toolbox" } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.dbPath = path.join(this.dataDir, "toolbox.sqlite");
    this.ready = false;
  }

  async init() {
    if (this.ready) {
      return;
    }
    await mkdir(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS export_tasks (
        id TEXT PRIMARY KEY,
        platform_key TEXT NOT NULL,
        platform_name TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        raw_urls_json TEXT NOT NULL,
        normalized_urls_json TEXT NOT NULL,
        config_json TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}',
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS export_task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        time TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        scope TEXT NOT NULL,
        message TEXT NOT NULL,
        meta_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(task_id) REFERENCES export_tasks(id) ON DELETE CASCADE
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_export_tasks_created_at ON export_tasks(created_at DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_export_task_logs_task_id_id ON export_task_logs(task_id, id)");
    this.ready = true;
  }

  createTaskSync({ id, platform, rawUrls = [], normalizedUrls = [], config = {} }) {
    const taskId = normalizeTaskId(id);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO export_tasks (
        id,
        platform_key,
        platform_name,
        auth_mode,
        status,
        raw_urls_json,
        normalized_urls_json,
        config_json,
        created_at,
        started_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      platform.key,
      platform.name,
      platform.authMode,
      safeJson(rawUrls, []),
      safeJson(normalizedUrls, []),
      safeJson(config, {}),
      now,
      now,
      now
    );
    return taskId;
  }

  updateTaskSync(id, { platform, normalizedUrls, config, status } = {}) {
    const current = this.getTaskSync(id);
    if (!current) {
      return;
    }
    const nextPlatform = platform || {
      key: current.platformKey,
      name: current.platformName,
      authMode: current.authMode
    };
    const nextConfig = config ? { ...current.config, ...config } : current.config;
    this.db.prepare(`
      UPDATE export_tasks
      SET platform_key = ?,
        platform_name = ?,
        auth_mode = ?,
        status = ?,
        normalized_urls_json = ?,
        config_json = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      nextPlatform.key,
      nextPlatform.name,
      nextPlatform.authMode,
      status || current.status,
      safeJson(normalizedUrls ?? current.normalizedUrls, []),
      safeJson(nextConfig, {}),
      id
    );
  }

  finishTaskSync(id, result = {}) {
    this.db.prepare(`
      UPDATE export_tasks
      SET status = 'succeeded',
        result_json = ?,
        error_message = NULL,
        finished_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(safeJson(result, {}), id);
  }

  failTaskSync(id, error, result = {}) {
    this.db.prepare(`
      UPDATE export_tasks
      SET status = 'failed',
        result_json = ?,
        error_message = ?,
        finished_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(safeJson(result, {}), error?.message || String(error), id);
  }

  markRunningInterruptedSync(reason = "服务重启，任务已中断。") {
    this.db.prepare(`
      UPDATE export_tasks
      SET status = 'failed',
        error_message = ?,
        finished_at = datetime('now'),
        updated_at = datetime('now')
      WHERE status IN ('queued', 'running', 'waiting_login')
    `).run(reason);
  }

  addLogSync(taskId, { time, scope = "export", message, meta = {}, level = "info" }) {
    if (!taskId) {
      return undefined;
    }
    const result = this.db.prepare(`
      INSERT INTO export_task_logs (task_id, time, level, scope, message, meta_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, time || new Date().toISOString(), level, scope, message, safeJson(meta, {}));
    return Number(result.lastInsertRowid);
  }

  listTasksSync({ limit = 50 } = {}) {
    const rows = this.db.prepare(`
      SELECT *
      FROM export_tasks
      ORDER BY created_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(200, Number(limit) || 50)));
    return rows.map((row) => this.#formatTask(row));
  }

  getTaskSync(id) {
    const row = this.db.prepare("SELECT * FROM export_tasks WHERE id = ?").get(id);
    return row ? this.#formatTask(row) : undefined;
  }

  getLogsSync(taskId, { after = 0, limit = 200 } = {}) {
    const rows = this.db.prepare(`
      SELECT id, task_id, time, level, scope, message, meta_json
      FROM export_task_logs
      WHERE task_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(taskId, Number(after) || 0, Math.max(1, Math.min(500, Number(limit) || 200)));
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      time: row.time,
      level: row.level,
      scope: row.scope,
      message: row.message,
      meta: parseJson(row.meta_json, {})
    }));
  }

  #formatTask(row) {
    return {
      id: row.id,
      platformKey: row.platform_key,
      platformName: row.platform_name,
      authMode: row.auth_mode,
      status: row.status,
      rawUrls: parseJson(row.raw_urls_json, []),
      normalizedUrls: parseJson(row.normalized_urls_json, []),
      config: parseJson(row.config_json, {}),
      result: parseJson(row.result_json, {}),
      errorMessage: row.error_message,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      updatedAt: row.updated_at
    };
  }
}
