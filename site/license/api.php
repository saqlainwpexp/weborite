<?php
/**
 * License API used by the desktop app: POST v1/licenses/{activate|validate|deactivate}, form-encoded.
 * Same response shape as Lemon Squeezy's license API, plus `signed` + `signature`: an Ed25519 signature over
 * the fields the app acts on, including the nonce it sent, so a replayed or forged answer is rejected.
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function reply(int $code, array $body, array $core): never {
    [$sk] = signing_keys();
    $core['nonce'] = substr((string)($_POST['nonce'] ?? ''), 0, 100);
    $core['time'] = time();
    $signed = json_encode($core, JSON_UNESCAPED_SLASHES);
    $body['signed'] = base64_encode($signed);
    $body['signature'] = base64_encode(sodium_crypto_sign_detached($signed, $sk));
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

function license_json(array $l): array {
    return [
        'status' => license_status($l),
        'activation_limit' => (int)$l['activation_limit'],
        'activation_usage' => activation_count((int)$l['id']),
        'expires_at' => $l['expires_at'],
    ];
}
function meta_json(array $l): array {
    return ['product_name' => PRODUCT_NAME, 'customer_name' => $l['name'], 'customer_email' => $l['email']];
}

$action = (string)($_GET['action'] ?? '');
if ($_SERVER['REQUEST_METHOD'] !== 'POST' || !in_array($action, ['activate', 'validate', 'deactivate'], true)) {
    reply(405, ['error' => 'Use POST to /v1/licenses/activate, /validate or /deactivate.'], ['action' => $action, 'ok' => false]);
}
if (too_many_failures()) {
    reply(429, ['activated' => false, 'valid' => false, 'error' => 'Too many attempts with invalid keys. Try again in an hour.'], ['action' => $action, 'ok' => false]);
}

$key = (string)($_POST['license_key'] ?? '');
$license = $key !== '' ? find_license($key) : null;
if (!$license) {
    record_failure();
    reply(404, ['activated' => false, 'valid' => false, 'error' => "That license key doesn't exist. Check it for typos, or contact support."], ['action' => $action, 'ok' => false, 'status' => 'invalid']);
}
$status = license_status($license);
$lid = (int)$license['id'];

if ($action === 'activate') {
    if ($status !== 'active') {
        $msg = $status === 'expired' ? 'This license has expired. Renew your subscription to keep using it.' : 'This license has been disabled. Contact support if you think this is a mistake.';
        reply(400, ['activated' => false, 'error' => $msg, 'license_key' => license_json($license), 'meta' => meta_json($license)], ['action' => $action, 'ok' => false, 'status' => $status]);
    }
    $db = db();
    $db->beginTransaction();
    $used = activation_count($lid);
    if ($used >= (int)$license['activation_limit']) {
        $db->rollBack();
        $n = (int)$license['activation_limit'];
        reply(400, ['activated' => false, 'error' => "This license is already active on $n " . ($n === 1 ? 'computer' : 'computers') . '. Deactivate it in Settings on the other computer first, or contact support.', 'license_key' => license_json($license), 'meta' => meta_json($license)], ['action' => $action, 'ok' => false, 'status' => $status]);
    }
    $id = new_instance_id();
    $name = mb_substr(trim((string)($_POST['instance_name'] ?? '')), 0, 80);
    $db->prepare('INSERT INTO instances (id, license_id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')->execute([$id, $lid, $name, now(), now()]);
    $db->commit();
    reply(200, [
        'activated' => true, 'error' => null,
        'license_key' => license_json($license),
        'instance' => ['id' => $id, 'name' => $name, 'created_at' => now()],
        'meta' => meta_json($license),
    ], ['action' => $action, 'ok' => true, 'status' => $status, 'instance_id' => $id, 'expires_at' => $license['expires_at']]);
}

$iid = (string)($_POST['instance_id'] ?? '');
$st = db()->prepare('SELECT * FROM instances WHERE id = ? AND license_id = ?');
$st->execute([$iid, $lid]);
$instance = $st->fetch() ?: null;

if ($action === 'validate') {
    if ($instance) db()->prepare('UPDATE instances SET last_seen_at = ? WHERE id = ?')->execute([now(), $iid]);
    $valid = $instance !== null && $status === 'active';
    // A computer removed from the admin page reads as "inactive" even while the key itself is fine.
    $appStatus = $instance === null ? 'inactive' : $status;
    reply(200, [
        'valid' => $valid,
        'error' => $valid ? null : ($instance === null ? 'This computer is no longer activated for this license.' : "This license is $status."),
        'license_key' => array_merge(license_json($license), ['status' => $appStatus]),
        'instance' => $instance ? ['id' => $instance['id'], 'name' => $instance['name'], 'created_at' => $instance['created_at']] : null,
        'meta' => meta_json($license),
    ], ['action' => $action, 'ok' => $valid, 'status' => $appStatus, 'instance_id' => $iid, 'expires_at' => $license['expires_at']]);
}

// deactivate
if ($instance) db()->prepare('DELETE FROM instances WHERE id = ?')->execute([$iid]);
reply(200, ['deactivated' => $instance !== null, 'error' => $instance ? null : 'This computer was not activated.'], ['action' => $action, 'ok' => $instance !== null, 'instance_id' => $iid]);
