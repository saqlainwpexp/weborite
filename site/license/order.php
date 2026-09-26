<?php
/**
 * Purchase requests from studio.weborite.com/buy: saved for the admin page and emailed to NOTIFY_EMAIL.
 * The customer gets a short confirmation email; the invoice and the key are sent by hand.
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

if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, ['error' => 'Send the order form with POST.']);
$in = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($in)) $in = $_POST;
$f = fn(string $k, int $max = 120) => mb_substr(trim((string)($in[$k] ?? '')), 0, $max);

// Bots fill every field; people never see this one.
if ($f('website') !== '') out(200, ['ok' => true, 'order' => 0]);

$st = db()->prepare('SELECT COUNT(*) FROM orders WHERE ip = ? AND created_at > ?');
$st->execute([client_ip(), gmdate('Y-m-d\TH:i:s\Z', time() - 3600)]);
if ((int)$st->fetchColumn() >= MAX_ORDERS_PER_HOUR) out(429, ['error' => 'Too many orders from this connection. Email hello@weborite.com instead.']);

$name = $f('name', 80);
$email = $f('email', 120);
$plan = $f('plan', 20);
$payment = $f('payment', 20);
if ($name === '') out(400, ['error' => 'Enter your name.', 'field' => 'name']);
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) out(400, ['error' => 'Enter a valid email address. Your invoice and license key are sent there.', 'field' => 'email']);
if (!isset(PLAN_PRICES[$plan])) out(400, ['error' => 'Choose monthly or yearly.', 'field' => 'plan']);
if (!isset(PAYMENT_METHODS[$payment])) out(400, ['error' => 'Choose how you want to pay.', 'field' => 'payment']);
if (empty($in['terms'])) out(400, ['error' => 'Accept the Terms of Service and Refund Policy to continue.', 'field' => 'terms']);

$row = [$name, $email, $f('company', 120), $f('country', 60), $plan, $payment, $f('note', 1000), client_ip(), now()];
db()->prepare('INSERT INTO orders (name, email, company, country, plan, payment, note, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')->execute($row);
$id = (int)db()->lastInsertId();

$lines = [
    "Order #$id",
    "Name: $name",
    "Email: $email",
    'Company: ' . ($row[2] ?: '-'),
    'Country: ' . ($row[3] ?: '-'),
    'Plan: ' . ucfirst($plan) . ' (' . PLAN_PRICES[$plan] . ')',
    'Pays by: ' . PAYMENT_METHODS[$payment],
    'Note: ' . ($row[6] ?: '-'),
];
$host = $_SERVER['HTTP_HOST'] ?? 'studio.weborite.com';
$headers = "From: Weborite Studio <no-reply@$host>\r\nContent-Type: text/plain; charset=utf-8";
@mail(NOTIFY_EMAIL, "New Weborite Studio order #$id: $name", implode("\n", $lines) . "\n\nCreate the license: https://$host/license/admin.php?order=$id\n", $headers . "\r\nReply-To: $email");
@mail($email, "Your Weborite Studio order #$id", "Hi $name,\n\nThanks for ordering Weborite Studio (" . ucfirst($plan) . ', ' . PLAN_PRICES[$plan] . ").\n\n"
    . 'We will email you an invoice to pay by ' . PAYMENT_METHODS[$payment] . " within one working day. Your license key follows as soon as the payment arrives.\n\n"
    . "Questions? Just reply to this email.\n\nWeborite Solutions\nhttps://studio.weborite.com\n", $headers . "\r\nReply-To: " . NOTIFY_EMAIL);

out(200, ['ok' => true, 'order' => $id]);
