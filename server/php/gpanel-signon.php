<?php
/**
 * G-Panel → phpMyAdmin single sign-on bridge.
 *
 * Flow: the panel issues a one-time token and opens
 *   https://<pma-host>/gpanel-signon.php?t=<token>
 * This script validates the token against the panel database, drops it
 * (single use), seeds a phpMyAdmin "signon" session with the MySQL
 * credentials (PMA_single_signon_* keys — the format phpMyAdmin's
 * AuthenticationSignon reads), and redirects into phpMyAdmin.
 * The password is never in the URL, never typed, and the token dies in
 * 90 seconds or on first use.
 *
 * Installed by G-Panel's install.sh into the phpMyAdmin web root.
 * Requires: php-sqlite3 / pdo_sqlite (enabled by default on Debian/Ubuntu),
 * read access to /var/lib/gpanel/panel.db (root:www-data 0640).
 */

$token = $_GET['t'] ?? '';
if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
    http_response_code(400);
    die('Invalid sign-on token.');
}

$panelDb = '/var/lib/gpanel/panel.db';
if (!is_file($panelDb)) {
    http_response_code(500);
    die('G-Panel database not found at ' . htmlspecialchars($panelDb));
}

try {
    $pdo = new PDO('sqlite:' . $panelDb, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
} catch (PDOException $e) {
    http_response_code(500);
    die('Cannot open G-Panel database (check file permissions for www-data).');
}

$stmt = $pdo->prepare('SELECT mysql_user, mysql_pass, expires FROM pma_tokens WHERE token = ?');
$stmt->execute([$token]);
$row = $stmt->fetch(PDO::FETCH_ASSOC);

// one-time use: burn the token whether or not it is still valid
$pdo->prepare('DELETE FROM pma_tokens WHERE token = ?')->execute([$token]);

if (!$row || (int)$row['expires'] < time()) {
    http_response_code(403);
    die('Sign-on token expired or already used. Go back to G-Panel and click phpMyAdmin again.');
}

// Seed the session phpMyAdmin's signon auth reads (see
// libraries/classes/Plugins/Auth/AuthenticationSignon.php).
session_name('GPanelSignon');
session_start();
session_regenerate_id(true);
$_SESSION['PMA_single_signon_user'] = $row['mysql_user'];
$_SESSION['PMA_single_signon_password'] = $row['mysql_pass'];
$_SESSION['PMA_single_signon_host'] = 'localhost';
$_SESSION['PMA_single_signon_port'] = '';
$_SESSION['PMA_single_signon_token'] = bin2hex(random_bytes(16));

header('Location: index.php');
exit;
