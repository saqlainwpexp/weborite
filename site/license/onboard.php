<?php
/**
 * Onboarding details from the desktop app's first-run screen, emailed to ONBOARDING_EMAIL so Weborite can
 * welcome and support the new customer. The app posts this best-effort (it never blocks setup on the result),
 * so this endpoint just validates lightly, rate-limits, sends the mail and answers ok.
 *
 * Nothing is stored here: the full profile lives on the customer's own computer. We only pass the details on.
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

if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, ['error' => 'Send the onboarding details with POST.']);

// Reuse the order rate limit as a simple per-IP flood guard.
db()->prepare('DELETE FROM failures WHERE at < ?')->execute([time() - 3600]);
$st = db()->prepare('SELECT COUNT(*) FROM failures WHERE ip = ?');
$st->execute(['onb:' . client_ip()]);
if ((int)$st->fetchColumn() >= MAX_ORDERS_PER_HOUR) out(429, ['ok' => false, 'error' => 'Too many submissions. Try again later.']);
db()->prepare('INSERT INTO failures (ip, at) VALUES (?, ?)')->execute(['onb:' . client_ip(), time()]);

$in = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($in)) $in = $_POST;
$f = fn(string $k, int $max = 4000) => mb_substr(trim((string)($in[$k] ?? '')), 0, $max);

$name = trim($f('firstName', 60) . ' ' . $f('lastName', 60));
$email = $f('email', 200);
if ($name === '') out(400, ['ok' => false, 'error' => 'Missing name.']);
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) out(400, ['ok' => false, 'error' => 'Missing or invalid email.']);

$lines = [
    'A customer finished onboarding in Weborite Studio.',
    '',
    'Name: ' . $name,
    'Email: ' . $email,
    'Phone: ' . ($f('phone', 40) ?: '-'),
    'What they do: ' . ($f('role', 120) ?: '-'),
    'Company: ' . ($f('company', 120) ?: '-'),
    'Country: ' . ($f('country', 60) ?: '-'),
    'Started as: ' . (!empty($in['demo']) ? 'demo' : 'activated license'),
    'Product updates opt-in: ' . (!empty($in['marketing']) ? 'yes' : 'no'),
    '',
    'Company description:',
    ($f('companyDescription', 1000) ?: '-'),
    '',
    '--- Personalization ---',
    '',
    'Niche:',
    ($f('niche', 500) ?: '-'),
    '',
    'Writing style / past chat & email references:',
    ($f('writingStyle', 4000) ?: '-'),
    '',
    'Previous work / case studies:',
    ($f('caseStudies', 4000) ?: '-'),
    '',
    'Previous designs, mission & goals:',
    ($f('designContext', 4000) ?: '-'),
    '',
    'Other personalization notes:',
    ($f('personalizationNotes', 4000) ?: '-'),
];

$host = $_SERVER['HTTP_HOST'] ?? 'studio.weborite.com';
$headers = "From: Weborite Studio <no-reply@$host>\r\nContent-Type: text/plain; charset=utf-8\r\nReply-To: $email";
@mail(ONBOARDING_EMAIL, 'New Weborite Studio customer: ' . $name, implode("\n", $lines) . "\n", $headers);

out(200, ['ok' => true]);
