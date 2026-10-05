<?php
/**
 * Free-trial heartbeat. Demo (unlicensed) copies of the desktop app POST here on startup and every so often,
 * so the admin page shows who is still using the trial and when they were last active. Paid copies don't use
 * this — their activity is tracked through the normal licence validate call.
 *
 * Best-effort from the app's side (it never blocks on the result), so this just records and answers ok.
 * Only a stable install id and a few profile basics are kept (see record_trial); no personalization is stored.
 */

declare(strict_types=1);
require __DIR__ . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out(int $code, array $body): never {
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, ['ok' => false, 'error' => 'Use POST.']);

$in = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($in)) $in = $_POST;
$f = fn(string $k, int $max = 120) => mb_substr(trim((string)($in[$k] ?? '')), 0, $max);

$installId = $f('installId', 80);
$email = $f('email', 200);
if ($installId === '' && $email === '') out(400, ['ok' => false, 'error' => 'Missing install id.']);

record_trial([
    'install_id' => $installId,
    'name' => $f('name', 120),
    'email' => $email,
    'phone' => $f('phone', 40),
    'company' => $f('company', 120),
    'country' => $f('country', 60),
    'role' => $f('role', 120),
    'version' => $f('version', 40),
    'demo' => true,
]);

out(200, ['ok' => true]);
