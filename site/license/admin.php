<?php
/** License admin: create keys, extend or disable them, and free up activations. */

declare(strict_types=1);
require __DIR__ . '/lib.php';

session_set_cookie_params(['httponly' => true, 'samesite' => 'Strict', 'secure' => !empty($_SERVER['HTTPS']), 'path' => dirname($_SERVER['SCRIPT_NAME'])]);
session_name('wslicense');
session_start();
header('X-Frame-Options: DENY');
header('Cache-Control: no-store');

$self = basename(__FILE__);
$hash = setting('admin_hash');
$error = '';
$flash = $_SESSION['flash'] ?? null;
unset($_SESSION['flash']);
if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(16));

function go(string $to, ?array $flash = null): never {
    if ($flash) $_SESSION['flash'] = $flash;
    header('Location: ' . $to);
    exit;
}
function csrf_ok(): bool { return hash_equals($_SESSION['csrf'] ?? '', (string)($_POST['csrf'] ?? '')); }

$post = $_SERVER['REQUEST_METHOD'] === 'POST';
$do = (string)($_POST['do'] ?? '');

// ---------- First run: choose the admin password ----------
if ($hash === null) {
    if ($post && $do === 'setup' && csrf_ok()) {
        $pw = (string)($_POST['password'] ?? '');
        if (strlen($pw) < 10) $error = 'Use at least 10 characters.';
        elseif ($pw !== (string)($_POST['confirm'] ?? '')) $error = "The two passwords don't match.";
        else {
            set_setting('admin_hash', password_hash($pw, PASSWORD_DEFAULT));
            signing_keys();
            session_regenerate_id(true);
            $_SESSION['admin'] = true;
            go($self, ['ok', 'Password set. Copy the public key below into the app before you build it.']);
        }
    }
    page_head('Set up');
    ?>
    <form class="card narrow" method="post">
      <h1>Set up the license service</h1>
      <p class="muted">Choose the password for this admin page. Do this right after uploading, before anyone else finds the page.</p>
      <?php if ($error) echo '<p class="err">' . h($error) . '</p>'; ?>
      <input type="hidden" name="csrf" value="<?= h($_SESSION['csrf']) ?>"><input type="hidden" name="do" value="setup">
      <label>Password<input type="password" name="password" id="pw" autocomplete="new-password" required minlength="10" autofocus></label>
      <label>Password again<input type="password" name="confirm" id="pw2" autocomplete="new-password" required></label>
      <button class="btn">Save password</button>
    </form>
    <?php
    page_foot();
    exit;
}

// ---------- Login ----------
if ($do === 'logout' && $post && csrf_ok()) { $_SESSION = []; session_destroy(); go($self); }
if (empty($_SESSION['admin'])) {
    if ($post && $do === 'login' && csrf_ok()) {
        if (too_many_failures()) $error = 'Too many wrong passwords. Try again in an hour.';
        elseif (password_verify((string)($_POST['password'] ?? ''), $hash)) {
            session_regenerate_id(true);
            $_SESSION['admin'] = true;
            go($self);
        } else { record_failure(); $error = 'Wrong password.'; }
    }
    page_head('Sign in');
    ?>
    <form class="card narrow" method="post">
      <h1>Licenses</h1>
      <?php if ($error) echo '<p class="err">' . h($error) . '</p>'; ?>
      <input type="hidden" name="csrf" value="<?= h($_SESSION['csrf']) ?>"><input type="hidden" name="do" value="login">
      <label>Password<input type="password" name="password" id="pw" autocomplete="current-password" required autofocus></label>
      <button class="btn">Sign in</button>
    </form>
    <?php
    page_foot();
    exit;
}

// ---------- Actions ----------
$plans = ['monthly' => ['Monthly', '+1 month'], 'yearly' => ['Yearly', '+1 year'], 'lifetime' => ['Lifetime', null], 'trial' => ['Trial (14 days)', '+14 days']];
if ($post && $do !== '') {
    if (!csrf_ok()) go($self, ['err', 'The page expired. Try again.']);
    $id = (int)($_POST['id'] ?? 0);
    $st = db()->prepare('SELECT * FROM licenses WHERE id = ?');
    $st->execute([$id]);
    $l = $st->fetch() ?: null;
    $touch = fn(string $sql, array $args) => db()->prepare($sql)->execute($args);

    if ($do === 'create') {
        $plan = array_key_exists($_POST['plan'] ?? '', $plans) ? $_POST['plan'] : 'monthly';
        $exp = trim((string)($_POST['expires'] ?? ''));
        $expires = $exp !== '' ? gmdate('Y-m-d\T23:59:59\Z', strtotime($exp)) : ($plans[$plan][1] ? gmdate('Y-m-d\T23:59:59\Z', strtotime($plans[$plan][1])) : null);
        $key = new_license_key();
        $touch('INSERT INTO licenses (license_key, name, email, plan, note, activation_limit, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
            $key, trim((string)$_POST['name']), trim((string)$_POST['email']), $plan, trim((string)($_POST['note'] ?? '')),
            max(1, min(50, (int)($_POST['limit'] ?? 1))), $expires, now(), now(),
        ]);
        go($self, ['new', $key]);
    }
    if (!$l) go($self, ['err', "That license doesn't exist."]);
    if ($do === 'extend') {
        $by = in_array($_POST['by'] ?? '', ['+1 month', '+1 year'], true) ? $_POST['by'] : '+1 month';
        $base = !empty($l['expires_at']) && strtotime($l['expires_at']) > time() ? strtotime($l['expires_at']) : time();
        $touch('UPDATE licenses SET expires_at = ?, updated_at = ? WHERE id = ?', [gmdate('Y-m-d\T23:59:59\Z', strtotime($by, $base)), now(), $id]);
        go($self, ['ok', 'Extended ' . $l['license_key'] . ' ' . substr($by, 1) . '.']);
    }
    if ($do === 'toggle') {
        $touch('UPDATE licenses SET disabled = ?, updated_at = ? WHERE id = ?', [(int)$l['disabled'] ? 0 : 1, now(), $id]);
        go($self, ['ok', ((int)$l['disabled'] ? 'Enabled ' : 'Disabled ') . $l['license_key'] . '. The app notices within 12 hours, or at its next start.']);
    }
    if ($do === 'reset') {
        $touch('DELETE FROM instances WHERE license_id = ?', [$id]);
        go($self, ['ok', 'Freed all activations of ' . $l['license_key'] . '. It can be activated again.']);
    }
}

// ---------- Dashboard ----------
$q = trim((string)($_GET['q'] ?? ''));
$sql = 'SELECT l.*, (SELECT COUNT(*) FROM instances i WHERE i.license_id = l.id) AS used,
        (SELECT group_concat(i.name, ", ") FROM instances i WHERE i.license_id = l.id) AS machines,
        (SELECT MAX(i.last_seen_at) FROM instances i WHERE i.license_id = l.id) AS seen
        FROM licenses l';
$args = [];
if ($q !== '') { $sql .= ' WHERE l.license_key LIKE ? OR l.name LIKE ? OR l.email LIKE ? OR l.note LIKE ?'; $args = array_fill(0, 4, "%$q%"); }
$st = db()->prepare($sql . ' ORDER BY l.id DESC LIMIT 500');
$st->execute($args);
$rows = $st->fetchAll();
$counts = db()->query("SELECT COUNT(*) AS total, SUM(disabled = 0 AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now'))) AS active FROM licenses")->fetch();

page_head('Licenses');
?>
<header class="top">
  <h1>Licenses <span class="muted"><?= (int)$counts['active'] ?> active of <?= (int)$counts['total'] ?></span></h1>
  <form method="post"><input type="hidden" name="csrf" value="<?= h($_SESSION['csrf']) ?>"><button class="btn ghost" name="do" value="logout">Sign out</button></form>
</header>

<?php if ($flash && $flash[0] === 'new'):
    $st = db()->prepare('SELECT * FROM licenses WHERE license_key = ?'); $st->execute([$flash[1]]); $n = $st->fetch();
    $first = $n && $n['name'] !== '' ? explode(' ', $n['name'])[0] : '';
    $mail = "Hi" . ($first ? " $first" : '') . ",\n\nThanks for buying Weborite Studio. Here is your license key:\n\n{$n['license_key']}\n\n"
      . "1. Download the app: https://studio.weborite.com/download/Weborite-Studio-Setup.exe\n"
      . "2. Open it and paste the key on the first screen. If you're already using the demo, click \"Enter license key\" at the top.\n\n"
      . "The key works on one computer at a time. To move it, open Settings, deactivate it, and enter it on the other computer.\n"
      . ($n['expires_at'] ? 'It is valid until ' . gmdate('j F Y', strtotime($n['expires_at'])) . ".\n" : '')
      . "\nIf anything doesn't work, reply to this email.\n";
?>
  <section class="card new">
    <h2>License created</h2>
    <div class="keyrow"><code id="newkey"><?= h($n['license_key']) ?></code><button class="btn" type="button" data-copy="newkey">Copy key</button></div>
    <label>Email to send<textarea id="mail" rows="12" readonly><?= h($mail) ?></textarea></label>
    <button class="btn ghost" type="button" data-copy="mail">Copy email</button>
  </section>
<?php elseif ($flash): ?>
  <p class="<?= $flash[0] === 'err' ? 'err' : 'ok' ?>"><?= h($flash[1]) ?></p>
<?php endif; ?>

<section class="card">
  <h2>New license</h2>
  <form method="post" class="grid">
    <input type="hidden" name="csrf" value="<?= h($_SESSION['csrf']) ?>"><input type="hidden" name="do" value="create">
    <label>Customer name<input name="name" id="c-name" required></label>
    <label>Email<input type="email" name="email" id="c-email" required></label>
    <label>Plan<select name="plan" id="c-plan"><?php foreach ($plans as $k => [$label]) echo '<option value="' . h($k) . '">' . h($label) . '</option>'; ?></select></label>
    <label title="Leave empty to use the length of the plan">Custom end date<input type="date" name="expires" id="c-exp"></label>
    <label>Computers<input type="number" name="limit" id="c-limit" value="1" min="1" max="50"></label>
    <label>Note<input name="note" id="c-note" placeholder="Payment reference"></label>
    <button class="btn">Create license</button>
  </form>
</section>

<section class="card">
  <div class="top">
    <h2>All licenses</h2>
    <form method="get"><input type="search" name="q" id="q" value="<?= h($q) ?>" placeholder="Search key, name, email or note"></form>
  </div>
  <div class="scroll">
  <table>
    <thead><tr><th>Customer</th><th>Key</th><th>Status</th><th>Valid until</th><th>Computers</th><th></th></tr></thead>
    <tbody>
    <?php foreach ($rows as $r): $s = license_status($r); ?>
      <tr>
        <td><b><?= h($r['name']) ?></b><br><span class="muted"><?= h($r['email']) ?></span><?php if ($r['note'] !== '') echo '<br><span class="muted">' . h($r['note']) . '</span>'; ?></td>
        <td><code><?= h($r['license_key']) ?></code><br><span class="muted"><?= h($plans[$r['plan']][0] ?? $r['plan']) ?></span></td>
        <td><span class="pill <?= $s ?>"><?= $s ?></span></td>
        <td><?= $r['expires_at'] ? h(gmdate('j M Y', strtotime($r['expires_at']))) : 'Never' ?></td>
        <td><?= (int)$r['used'] ?> / <?= (int)$r['activation_limit'] ?><?php if ($r['machines']) echo '<br><span class="muted">' . h($r['machines']) . '</span>'; ?><?php if ($r['seen']) echo '<br><span class="muted">seen ' . h(gmdate('j M', strtotime($r['seen']))) . '</span>'; ?></td>
        <td>
          <form method="post" class="acts">
            <input type="hidden" name="csrf" value="<?= h($_SESSION['csrf']) ?>"><input type="hidden" name="id" value="<?= (int)$r['id'] ?>">
            <button class="btn sm ghost" name="do" value="extend" onclick="this.form.by.value='+1 month'">+1 month</button>
            <button class="btn sm ghost" name="do" value="extend" onclick="this.form.by.value='+1 year'">+1 year</button>
            <input type="hidden" name="by" value="+1 month">
            <?php if ((int)$r['used'] > 0): ?><button class="btn sm ghost" name="do" value="reset">Free computers</button><?php endif; ?>
            <button class="btn sm <?= (int)$r['disabled'] ? 'ghost' : 'danger' ?>" name="do" value="toggle"><?= (int)$r['disabled'] ? 'Enable' : 'Disable' ?></button>
          </form>
        </td>
      </tr>
    <?php endforeach; if (!$rows) echo '<tr><td colspan="6" class="muted">No licenses yet.</td></tr>'; ?>
    </tbody>
  </table>
  </div>
</section>

<section class="card">
  <h2>App public key</h2>
  <p class="muted">The app only trusts answers signed by this server. Paste this into <code>shared/licenseKey.ts</code> in the app, then build the installer.</p>
  <div class="keyrow"><code id="pk"><?= h(public_key_b64()) ?></code><button class="btn ghost" type="button" data-copy="pk">Copy</button></div>
</section>
<?php
page_foot();

function page_head(string $title): void { ?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title><?= h($title) ?> · Weborite Studio licenses</title>
<style>
  :root { --bg:#f7f5f6; --card:#fff; --line:#e6e1e2; --text:#151213; --muted:#736d6e; --rose:#a36566; --rose-ink:#7a4546; --good:#3f8a5e; --bad:#b94545; --warn:#b7791f; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; padding: 24px 16px 60px; }
  main { max-width: 1180px; margin: 0 auto; display: grid; gap: 18px; }
  h1 { font-size: 24px; margin: 0; } h2 { font-size: 18px; margin: 0 0 14px; }
  .muted { color: var(--muted); font-weight: 400; font-size: 13px; }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  .top h2 { margin: 0; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px; }
  .narrow { max-width: 400px; margin: 10vh auto 0; display: grid; gap: 14px; }
  label { display: grid; gap: 5px; font-size: 13px; font-weight: 600; }
  input, select, textarea { font: inherit; font-weight: 400; padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; background: #fff; color: var(--text); width: 100%; }
  textarea { font: 13px/1.5 Consolas, monospace; }
  input[type=search] { width: 280px; max-width: 100%; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; align-items: end; }
  .btn { font: inherit; font-weight: 600; border: 1px solid transparent; background: var(--rose); color: #fff; border-radius: 9px; padding: 9px 16px; cursor: pointer; white-space: nowrap; }
  .btn:hover { background: var(--rose-ink); }
  .btn.ghost { background: #fff; color: var(--text); border-color: var(--line); } .btn.ghost:hover { border-color: var(--muted); }
  .btn.danger { background: #fff; color: var(--bad); border-color: #efd0d0; }
  .btn.sm { padding: 5px 10px; font-size: 13px; }
  .scroll { overflow-x: auto; margin-top: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; min-width: 860px; }
  th, td { text-align: left; vertical-align: top; padding: 11px 10px 11px 0; border-top: 1px solid var(--line); }
  th { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; border-top: 0; }
  code { font: 13px Consolas, "Cascadia Mono", monospace; }
  .acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 99px; }
  .pill.active { background: #e3f1e8; color: var(--good); } .pill.expired { background: #f7ecd9; color: var(--warn); } .pill.disabled { background: #f6e1e1; color: var(--bad); }
  .err { color: var(--bad); margin: 0; } .ok { color: var(--good); margin: 0; }
  .new { border: 2px solid var(--rose); display: grid; gap: 14px; }
  .new h2 { margin: 0; }
  .keyrow { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .keyrow code { font-size: 17px; background: var(--bg); padding: 8px 12px; border-radius: 8px; word-break: break-all; }
</style>
</head>
<body><main>
<?php }

function page_foot(): void { ?>
</main>
<script>
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  const el = document.getElementById(b.dataset.copy); const text = el.value ?? el.textContent;
  try { await navigator.clipboard.writeText(text); } catch { const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy'); }
  const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => b.textContent = t, 1500);
});
</script>
</body></html>
<?php }
