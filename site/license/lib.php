<?php
/**
 * Weborite Studio license service: shared helpers.
 *
 * Storage is one SQLite file in ./data (blocked from the web by data/.htaccess). The signing key pair is made on
 * first use: the private half stays in the database, the public half goes into the app (shared/licenseKey.ts),
 * which rejects any answer this server didn't sign. That stops a fake server from unlocking the app.
 */

declare(strict_types=1);

const PRODUCT_NAME = 'Weborite Studio';
const MAX_FAILURES_PER_HOUR = 20;

function db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    $dir = __DIR__ . '/data';
    if (!is_dir($dir)) mkdir($dir, 0700, true);
    $pdo = new PDO('sqlite:' . $dir . '/licenses.sqlite', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS licenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            license_key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            plan TEXT NOT NULL DEFAULT "monthly",
            note TEXT NOT NULL DEFAULT '',
            disabled INTEGER NOT NULL DEFAULT 0,
            activation_limit INTEGER NOT NULL DEFAULT 1,
            expires_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS instances (
            id TEXT PRIMARY KEY,
            license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
            name TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS failures (ip TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS failures_ip ON failures (ip, at);
    SQL);
    return $pdo;
}

function now(): string { return gmdate('Y-m-d\TH:i:s\Z'); }

function setting(string $k): ?string {
    $st = db()->prepare('SELECT v FROM settings WHERE k = ?');
    $st->execute([$k]);
    $v = $st->fetchColumn();
    return $v === false ? null : (string)$v;
}
function set_setting(string $k, string $v): void {
    db()->prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')->execute([$k, $v]);
}

/** Ed25519 key pair, created once. Returns [secretKey, publicKey] as raw bytes. */
function signing_keys(): array {
    $sk = setting('sign_sk');
    if ($sk === null) {
        $pair = sodium_crypto_sign_keypair();
        set_setting('sign_sk', base64_encode(sodium_crypto_sign_secretkey($pair)));
        set_setting('sign_pk', base64_encode(sodium_crypto_sign_publickey($pair)));
        $sk = setting('sign_sk');
    }
    return [base64_decode($sk), base64_decode((string)setting('sign_pk'))];
}
function public_key_b64(): string { return base64_encode(signing_keys()[1]); }

/** XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX, uppercase hex. */
function new_license_key(): string {
    $h = strtoupper(bin2hex(random_bytes(16)));
    return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-' . substr($h, 16, 4) . '-' . substr($h, 20);
}
function new_instance_id(): string {
    $b = random_bytes(16);
    $b[6] = chr(ord($b[6]) & 0x0f | 0x40);
    $b[8] = chr(ord($b[8]) & 0x3f | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

/** active | expired | disabled */
function license_status(array $l): string {
    if ((int)$l['disabled'] === 1) return 'disabled';
    if (!empty($l['expires_at']) && strtotime($l['expires_at']) < time()) return 'expired';
    return 'active';
}

function find_license(string $key): ?array {
    $st = db()->prepare('SELECT * FROM licenses WHERE license_key = ?');
    $st->execute([strtoupper(trim($key))]);
    $l = $st->fetch();
    return $l ?: null;
}
function activation_count(int $licenseId): int {
    $st = db()->prepare('SELECT COUNT(*) FROM instances WHERE license_id = ?');
    $st->execute([$licenseId]);
    return (int)$st->fetchColumn();
}

function client_ip(): string { return (string)($_SERVER['REMOTE_ADDR'] ?? ''); }
function too_many_failures(): bool {
    db()->prepare('DELETE FROM failures WHERE at < ?')->execute([time() - 3600]);
    $st = db()->prepare('SELECT COUNT(*) FROM failures WHERE ip = ?');
    $st->execute([client_ip()]);
    return (int)$st->fetchColumn() >= MAX_FAILURES_PER_HOUR;
}
function record_failure(): void {
    db()->prepare('INSERT INTO failures (ip, at) VALUES (?, ?)')->execute([client_ip(), time()]);
}

function h(?string $s): string { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
