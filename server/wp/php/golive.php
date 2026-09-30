<?php
/**
 * Go-live kit for the Studio Connector: everything a site needs before and at launch.
 *
 *  - status: which plugin does each job (SEO, forms, cache, backup, SMTP, security), UpdraftPlus remote
 *    storage and last backup, FluentSMTP, admin and user email, indexing, favicon, WebP rules, mu-plugins,
 *    redirects, staging HTTP auth
 *  - kit: install UpdraftPlus, FluentSMTP and (on LiteSpeed servers) LiteSpeed Cache, schedule backups,
 *    drop in the security and admin mu-plugins, deny xmlrpc/readme/license and directory listings,
 *    pin the admin email, serve WebP to browsers that take it, publish llms.txt
 *  - smtp: authenticated SMTP on the client's own domain through FluentSMTP
 *  - mailtest: send a test email through the site's own mail path (the delivery check reads it)
 *  - form handler: one hardened handler for the forms the studio generates (honeypot, timing, rate limit)
 *  - redirects: old URLs to their new home (301), applied only where WordPress would 404
 *  - live: at cutover, allow indexing and take down staging HTTP auth
 *  - SEO basics when no SEO plugin owns the head: Open Graph and canonical tags on archives too
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'STUDIO_GOLIVE_VERSION', 1 );

/* ---------- plugins by job ("one source per job") ---------- */

function studio_golive_jobs() {
	return array(
		'seo'      => array( 'wordpress-seo' => 'Yoast SEO', 'wordpress-seo-premium' => 'Yoast SEO Premium', 'seo-by-rank-math' => 'Rank Math', 'all-in-one-seo-pack' => 'All in One SEO', 'autodescription' => 'The SEO Framework', 'wp-seopress' => 'SEOPress', 'slim-seo' => 'Slim SEO' ),
		'forms'    => array( 'contact-form-7' => 'Contact Form 7', 'wpforms-lite' => 'WPForms Lite', 'wpforms' => 'WPForms', 'gravityforms' => 'Gravity Forms', 'ninja-forms' => 'Ninja Forms', 'fluentform' => 'Fluent Forms', 'formidable' => 'Formidable Forms', 'forminator' => 'Forminator', 'everest-forms' => 'Everest Forms' ),
		'cache'    => array( 'litespeed-cache' => 'LiteSpeed Cache', 'wp-rocket' => 'WP Rocket', 'w3-total-cache' => 'W3 Total Cache', 'wp-super-cache' => 'WP Super Cache', 'wp-fastest-cache' => 'WP Fastest Cache', 'sg-cachepress' => 'SiteGround Optimizer', 'breeze' => 'Breeze', 'cache-enabler' => 'Cache Enabler', 'hummingbird-performance' => 'Hummingbird', 'wp-optimize' => 'WP-Optimize' ),
		'backup'   => array( 'updraftplus' => 'UpdraftPlus', 'backwpup' => 'BackWPup', 'duplicator' => 'Duplicator', 'duplicator-pro' => 'Duplicator Pro', 'wpvivid-backuprestore' => 'WPvivid', 'all-in-one-wp-migration' => 'All-in-One WP Migration', 'backup-backup' => 'Backup Migration', 'blogvault-real-time-backup' => 'BlogVault' ),
		'smtp'     => array( 'fluent-smtp' => 'FluentSMTP', 'wp-mail-smtp' => 'WP Mail SMTP', 'wp-mail-smtp-pro' => 'WP Mail SMTP Pro', 'post-smtp' => 'Post SMTP', 'easy-wp-smtp' => 'Easy WP SMTP', 'mailgun' => 'Mailgun', 'sendgrid-email-delivery-simplified' => 'SendGrid', 'smtp-mailer' => 'SMTP Mailer' ),
		'security' => array( 'wordfence' => 'Wordfence', 'better-wp-security' => 'Solid Security', 'sucuri-scanner' => 'Sucuri', 'all-in-one-wp-security-and-firewall' => 'All-In-One Security', 'defender-security' => 'Defender', 'wp-cerber' => 'WP Cerber' ),
		'captcha'  => array( 'advanced-google-recaptcha' => 'Advanced Google reCAPTCHA', 'simple-cloudflare-turnstile' => 'Cloudflare Turnstile', 'google-captcha' => 'reCaptcha by BestWebSoft', 'invisible-recaptcha' => 'Invisible reCaptcha' ),
	);
}

function studio_golive_active_by_job() {
	$active = (array) get_option( 'active_plugins', array() );
	$dirs   = array_map( function ( $f ) {
		return strtok( $f, '/' );
	}, $active );
	$out    = array();
	foreach ( studio_golive_jobs() as $job => $known ) {
		$out[ $job ] = array_values( array_intersect_key( $known, array_flip( $dirs ) ) );
	}
	// Elementor Pro brings its own form widget: a second form system if another form plugin is also active.
	if ( defined( 'ELEMENTOR_PRO_VERSION' ) ) {
		$out['forms'][] = 'Elementor Pro forms';
	}
	if ( get_option( 'studio_form_used' ) ) {
		$out['forms'][] = 'Studio form handler';
	}
	return $out;
}

function studio_golive_is_litespeed() {
	$sw = isset( $_SERVER['SERVER_SOFTWARE'] ) ? sanitize_text_field( wp_unslash( $_SERVER['SERVER_SOFTWARE'] ) ) : '';
	return false !== stripos( $sw, 'litespeed' ) || isset( $_SERVER['LSWS_EDITION'] );
}

function studio_golive_is_apache() {
	$sw = isset( $_SERVER['SERVER_SOFTWARE'] ) ? sanitize_text_field( wp_unslash( $_SERVER['SERVER_SOFTWARE'] ) ) : '';
	return studio_golive_is_litespeed() || false !== stripos( $sw, 'apache' );
}

function studio_golive_htaccess() {
	return ABSPATH . '.htaccess';
}

function studio_golive_marker_present( $marker ) {
	$f = studio_golive_htaccess();
	return is_readable( $f ) && false !== strpos( (string) file_get_contents( $f ), '# BEGIN ' . $marker );
}

/** HTTP auth (staging password) in the site root's .htaccess. */
function studio_golive_http_auth_lines() {
	$f = studio_golive_htaccess();
	if ( ! is_readable( $f ) ) {
		return array();
	}
	return array_values( array_filter( explode( "\n", (string) file_get_contents( $f ) ), function ( $l ) {
		return (bool) preg_match( '/^\s*(AuthType|AuthName|AuthUserFile|AuthGroupFile|AuthBasicProvider|Require\s+(valid-user|user\s))/i', $l );
	} ) );
}

/* ---------- status ---------- */

function studio_golive_status() {
	require_once ABSPATH . 'wp-admin/includes/plugin.php';
	$user = wp_get_current_user();

	$updraft = array( 'active' => class_exists( 'UpdraftPlus' ), 'remote' => array(), 'files' => '', 'db' => '', 'last' => null );
	if ( $updraft['active'] ) {
		$service           = get_option( 'updraft_service' );
		$updraft['remote'] = array_values( array_filter( (array) $service, function ( $s ) {
			return $s && 'none' !== $s && '' !== $s;
		} ) );
		$updraft['files']  = (string) get_option( 'updraft_interval', 'manual' );
		$updraft['db']     = (string) get_option( 'updraft_interval_database', 'manual' );
		$last              = get_option( 'updraft_last_backup' );
		if ( is_array( $last ) && ! empty( $last['backup_time'] ) ) {
			$updraft['last'] = array(
				'at'      => gmdate( 'c', (int) $last['backup_time'] ),
				'success' => ! empty( $last['success'] ),
				'errors'  => is_array( $last['errors'] ?? null ) ? count( $last['errors'] ) : 0,
				'parts'   => is_array( $last['backup_array'] ?? null ) ? array_keys( $last['backup_array'] ) : array(),
			);
		}
	}

	$smtp = array( 'active' => defined( 'FLUENTMAIL' ), 'connections' => array() );
	if ( $smtp['active'] ) {
		$settings = function_exists( 'fluentMailGetSettings' ) ? fluentMailGetSettings() : get_option( 'fluentmail-settings', array() );
		foreach ( (array) ( $settings['connections'] ?? array() ) as $key => $c ) {
			$p                     = (array) ( $c['provider_settings'] ?? array() );
			$smtp['connections'][] = array(
				'from'     => (string) ( $p['sender_email'] ?? '' ),
				'provider' => (string) ( $p['provider'] ?? '' ),
				'host'     => (string) ( $p['host'] ?? '' ),
				'default'  => ( $settings['misc']['default_connection'] ?? '' ) === $key,
			);
		}
	}

	$icon_id = (int) get_option( 'site_icon' );
	$icon    = null;
	if ( $icon_id ) {
		$meta = wp_get_attachment_metadata( $icon_id );
		$icon = array( 'url' => (string) get_site_icon_url( 512 ), 'width' => (int) ( $meta['width'] ?? 0 ), 'height' => (int) ( $meta['height'] ?? 0 ) );
	}

	$mu = WPMU_PLUGIN_DIR;
	return array(
		'version'        => STUDIO_GOLIVE_VERSION,
		'server'         => isset( $_SERVER['SERVER_SOFTWARE'] ) ? sanitize_text_field( wp_unslash( $_SERVER['SERVER_SOFTWARE'] ) ) : '',
		'litespeed'      => studio_golive_is_litespeed(),
		'apache'         => studio_golive_is_apache(),
		'is_admin'       => current_user_can( 'manage_options' ),
		'jobs'           => studio_golive_active_by_job(),
		'seo_plugin'     => function_exists( 'studio_seo_plugin' ) ? studio_seo_plugin() : '',
		'updraft'        => $updraft,
		'smtp'           => $smtp,
		'admin_email'    => (string) get_option( 'admin_email' ),
		'user_email'     => (string) $user->user_email,
		'user_login'     => (string) $user->user_login,
		'form_recipient' => (string) get_option( 'studio_form_recipient', '' ),
		'blog_public'    => (bool) get_option( 'blog_public' ),
		'site_icon'      => $icon,
		'webp'           => array( 'rules' => studio_golive_marker_present( 'Studio WebP' ), 'uploads' => (bool) get_option( 'studio_webp_uploads' ), 'server_can' => wp_image_editor_supports( array( 'mime_type' => 'image/webp' ) ) ),
		'security_rules' => studio_golive_marker_present( 'Studio security' ),
		'mu'             => array( 'security' => file_exists( $mu . '/studio-security.php' ), 'admin' => file_exists( $mu . '/studio-wp-admin.php' ) ),
		'llms'           => (bool) get_option( 'studio_llms' ),
		'redirects'      => count( (array) get_option( 'studio_redirects', array() ) ),
		'http_auth'      => count( studio_golive_http_auth_lines() ) > 0,
		'htaccess'       => array( 'exists' => file_exists( studio_golive_htaccess() ), 'writable' => wp_is_writable( file_exists( studio_golive_htaccess() ) ? studio_golive_htaccess() : ABSPATH ) ),
		'theme'          => array( 'name' => wp_get_theme()->get( 'Name' ), 'stylesheet' => get_stylesheet() ),
		'elementor'      => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : '',
		'elementor_pro'  => defined( 'ELEMENTOR_PRO_VERSION' ),
		'home'           => home_url( '/' ),
	);
}

/* ---------- kit ---------- */

function studio_golive_write_mu( $name, $php ) {
	if ( ! is_dir( WPMU_PLUGIN_DIR ) && ! wp_mkdir_p( WPMU_PLUGIN_DIR ) ) {
		return new WP_Error( 'studio_mu', 'Could not create wp-content/mu-plugins' );
	}
	$path = WPMU_PLUGIN_DIR . '/' . $name;
	if ( false === file_put_contents( $path, $php ) ) {
		return new WP_Error( 'studio_mu', "Could not write mu-plugins/$name" );
	}
	return true;
}

function studio_golive_security_mu() {
	return <<<'PHP'
<?php
/**
 * Plugin Name: Studio security
 * Description: Security headers, no username discovery, no version leaks, generic login errors, XML-RPC off. Installed by Weborite Studio.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
if ( ! defined( 'DISALLOW_FILE_EDIT' ) ) {
	define( 'DISALLOW_FILE_EDIT', true );
}
add_action( 'send_headers', function () {
	if ( headers_sent() ) {
		return;
	}
	header( 'X-Content-Type-Options: nosniff' );
	header( 'X-Frame-Options: SAMEORIGIN' );
	header( 'Referrer-Policy: strict-origin-when-cross-origin' );
	header( 'Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()' );
	if ( is_ssl() ) {
		header( 'Strict-Transport-Security: max-age=31536000' );
	}
} );
// No version leaks.
remove_action( 'wp_head', 'wp_generator' );
add_filter( 'the_generator', '__return_empty_string' );
// Usernames stay private: no user list over REST for visitors, no author archives or ?author=N, no user sitemap.
add_filter( 'rest_endpoints', function ( $endpoints ) {
	if ( ! current_user_can( 'list_users' ) ) {
		unset( $endpoints['/wp/v2/users'], $endpoints['/wp/v2/users/(?P<id>[\d]+)'] );
	}
	return $endpoints;
} );
add_action( 'template_redirect', function () {
	if ( ! is_user_logged_in() && ( isset( $_GET['author'] ) || is_author() ) ) { // phpcs:ignore WordPress.Security.NonceVerification
		wp_safe_redirect( home_url( '/' ), 301 );
		exit;
	}
}, 1 );
add_filter( 'wp_sitemaps_add_provider', function ( $provider, $name ) {
	return 'users' === $name ? false : $provider;
}, 10, 2 );
add_filter( 'oembed_response_data', function ( $data ) {
	unset( $data['author_name'], $data['author_url'] );
	return $data;
} );
// The studio signs in with an Application Password: keep them available even if a security plugin switches them off.
add_action( 'plugins_loaded', function () {
	remove_filter( 'wp_is_application_passwords_available', '__return_false' );
}, 100 );
// Login errors don't say whether the username exists.
add_filter( 'login_errors', function () {
	return 'The username or password is incorrect.';
} );
// XML-RPC off, pingbacks included. Blocked outright: core still answers system.* calls when "disabled".
if ( defined( 'XMLRPC_REQUEST' ) && XMLRPC_REQUEST ) {
	status_header( 403 );
	exit;
}
add_filter( 'xmlrpc_enabled', '__return_false' );
add_filter( 'xmlrpc_methods', '__return_empty_array' );
add_filter( 'wp_headers', function ( $headers ) {
	unset( $headers['X-Pingback'] );
	return $headers;
} );
PHP;
}

function studio_golive_admin_mu( $email ) {
	$email = sanitize_email( $email );
	return <<<PHP
<?php
/**
 * Plugin Name: Studio admin email
 * Description: Pins the site's admin email to the agency address, mutes success notices and keeps failures. Installed by Weborite Studio.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
if ( ! defined( 'STUDIO_ADMIN_EMAIL' ) ) {
	define( 'STUDIO_ADMIN_EMAIL', '$email' );
}
add_filter( 'pre_option_admin_email', function () {
	return STUDIO_ADMIN_EMAIL;
} );
add_filter( 'admin_email_check_interval', '__return_false' );
add_filter( 'send_site_admin_email_change_email', '__return_false' );
// Updates: tell us when something failed, stay quiet when it worked.
add_filter( 'auto_core_update_send_email', function ( \$send, \$type ) {
	return 'success' !== \$type;
}, 10, 2 );
add_filter( 'send_core_update_notification_email', '__return_false' );
\$studio_only_failures = function ( \$enabled, \$results ) {
	foreach ( (array) \$results as \$r ) {
		if ( empty( \$r->result ) ) {
			return true;
		}
	}
	return false;
};
add_filter( 'auto_plugin_update_send_email', \$studio_only_failures, 10, 2 );
add_filter( 'auto_theme_update_send_email', \$studio_only_failures, 10, 2 );
PHP;
}

function studio_golive_security_rules() {
	return array(
		'<FilesMatch "^(xmlrpc\.php|readme\.html|license\.txt|wp-config-sample\.php)$">',
		'	<IfModule mod_authz_core.c>',
		'		Require all denied',
		'	</IfModule>',
		'	<IfModule !mod_authz_core.c>',
		'		Order allow,deny',
		'		Deny from all',
		'	</IfModule>',
		'</FilesMatch>',
		'Options -Indexes',
	);
}

function studio_golive_webp_rules() {
	return array(
		'<IfModule mod_rewrite.c>',
		'	RewriteEngine On',
		'	RewriteCond %{HTTP_ACCEPT} image/webp',
		'	RewriteCond %{REQUEST_FILENAME} \.(jpe?g|png)$ [NC]',
		'	RewriteCond %{REQUEST_FILENAME}.webp -f',
		'	RewriteRule ^(.+)\.(jpe?g|png)$ $1.$2.webp [NC,T=image/webp,L]',
		'</IfModule>',
		'<IfModule mod_headers.c>',
		'	<FilesMatch "\.(jpe?g|png)$">',
		'		Header append Vary Accept',
		'	</FilesMatch>',
		'</IfModule>',
		'AddType image/webp .webp',
	);
}

function studio_golive_write_rules( $marker, $lines ) {
	if ( ! studio_golive_is_apache() ) {
		return new WP_Error( 'studio_not_apache', 'This server is not Apache or LiteSpeed, so .htaccess rules have no effect. Add the equivalent rules to the server config.' );
	}
	require_once ABSPATH . 'wp-admin/includes/misc.php';
	$file = studio_golive_htaccess();
	if ( ! wp_is_writable( file_exists( $file ) ? $file : ABSPATH ) ) {
		return new WP_Error( 'studio_htaccess', '.htaccess in the site root is not writable' );
	}
	$before = file_exists( $file ) ? (string) file_get_contents( $file ) : null;
	if ( ! insert_with_markers( $file, $marker, $lines ) ) {
		return new WP_Error( 'studio_htaccess', "Could not write the $marker rules to .htaccess" );
	}
	// Some hosts don't allow every directive in .htaccess and answer 500 for the whole site: check, and undo if so.
	$probe = wp_remote_get( home_url( '/?studio_probe=' . time() ), array( 'timeout' => 15, 'sslverify' => false, 'redirection' => 0 ) );
	if ( ! is_wp_error( $probe ) && 500 === (int) wp_remote_retrieve_response_code( $probe ) ) {
		if ( null === $before ) {
			wp_delete_file( $file );
		} else {
			file_put_contents( $file, $before );
		}
		return new WP_Error( 'studio_htaccess', "The server rejected the $marker rules (the site returned 500), so they were removed again. Ask the host to allow them, or add them to the server config." );
	}
	return true;
}

function studio_golive_kit( WP_REST_Request $req ) {
	if ( ! current_user_can( 'manage_options' ) ) {
		return new WP_Error( 'studio_not_admin', 'The connected WordPress user must be an administrator to set up the go-live kit.', array( 'status' => 403 ) );
	}
	@set_time_limit( 300 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors
	$want  = (array) $req->get_param( 'steps' );
	$steps = array();
	$add   = function ( $id, $ok, $note ) use ( &$steps ) {
		$steps[] = array( 'id' => $id, 'ok' => $ok, 'note' => $note );
	};
	$err = function ( $r ) {
		return is_wp_error( $r ) ? $r->get_error_message() : '';
	};

	if ( in_array( 'plugins', $want, true ) ) {
		foreach ( array( array( 'updraftplus', 'updraftplus/updraftplus.php', 'UpdraftPlus' ), array( 'fluent-smtp', 'fluent-smtp/fluent-smtp.php', 'FluentSMTP' ) ) as $p ) {
			$r = studio_woo_ensure_plugin( $p[0], $p[1] );
			$add( 'plugin-' . $p[0], ! is_wp_error( $r ), is_wp_error( $r ) ? $err( $r ) : "{$p[2]} $r" );
		}
		$security = studio_golive_active_by_job()['security'];
		if ( $security && ! in_array( 'Wordfence', $security, true ) ) {
			$add( 'plugin-wordfence', true, 'Skipped Wordfence: ' . implode( ', ', $security ) . ' already does this job' );
		} else {
			// Care's hardening installs Wordfence with the studio's settings, and keeps Application Passwords on:
			// Wordfence switches them off by default, which would lock the studio out of this site.
			$r = studio_care_harden();
			$add( 'plugin-wordfence', ! is_wp_error( $r ), is_wp_error( $r ) ? $err( $r ) : 'Wordfence ' . ( $r['installed'] ? 'installed' : 'active' ) . ': brute-force protection, scans, Application Passwords kept on' );
		}
		if ( studio_golive_is_litespeed() ) {
			$r = studio_woo_ensure_plugin( 'litespeed-cache', 'litespeed-cache/litespeed-cache.php' );
			$add( 'plugin-litespeed-cache', ! is_wp_error( $r ), is_wp_error( $r ) ? $err( $r ) : "LiteSpeed Cache $r" );
		} else {
			$add( 'plugin-litespeed-cache', true, 'Skipped: this server is not LiteSpeed, so LiteSpeed Cache would do nothing. Use the host\'s own cache, or one cache plugin.' );
		}
	}

	if ( in_array( 'backups', $want, true ) ) {
		if ( ! class_exists( 'UpdraftPlus' ) ) {
			$add( 'backups', false, 'UpdraftPlus is not active' );
		} else {
			global $updraftplus;
			$files = (string) get_option( 'updraft_interval', 'manual' );
			$db    = (string) get_option( 'updraft_interval_database', 'manual' );
			if ( 'manual' === $files || '' === $files ) {
				update_option( 'updraft_interval', 'weekly' );
				update_option( 'updraft_retain', 4 );
				if ( is_object( $updraftplus ) && method_exists( $updraftplus, 'schedule_backup' ) ) {
					$updraftplus->schedule_backup( 'weekly' );
				}
			}
			if ( 'manual' === $db || '' === $db ) {
				update_option( 'updraft_interval_database', 'daily' );
				update_option( 'updraft_retain_db', 14 );
				if ( is_object( $updraftplus ) && method_exists( $updraftplus, 'schedule_backup_database' ) ) {
					$updraftplus->schedule_backup_database( 'daily' );
				}
			}
			$remote = array_filter( (array) get_option( 'updraft_service' ), function ( $s ) {
				return $s && 'none' !== $s;
			} );
			$add( 'backups', true, 'Files weekly (keep 4), database daily (keep 14).' . ( $remote ? '' : ' Remote storage is not set yet: connect Google Drive, Dropbox or S3 under Settings → UpdraftPlus Backups → Settings.' ) );
		}
	}

	if ( in_array( 'security', $want, true ) ) {
		$r = studio_golive_write_mu( 'studio-security.php', studio_golive_security_mu() );
		$add( 'security-mu', ! is_wp_error( $r ), is_wp_error( $r ) ? $err( $r ) : 'Security mu-plugin in place: headers, private usernames, no generator tag, generic login errors, XML-RPC off' );
		$r = studio_golive_write_rules( 'Studio security', studio_golive_security_rules() );
		$add( 'security-rules', ! is_wp_error( $r ), is_wp_error( $r ) ? $err( $r ) : 'xmlrpc.php, readme.html, license.txt denied; directory listings off' );
	}

	$admin = sanitize_email( (string) $req->get_param( 'admin_email' ) );
	if ( in_array( 'admin', $want, true ) ) {
		if ( ! is_email( $admin ) ) {
			$add( 'admin-email', false, 'Set the agency admin email in Settings → Integrations first' );
		} else {
			update_option( 'admin_email', $admin );
			delete_option( 'new_admin_email' );
			delete_option( 'adminhash' );
			$r = studio_golive_write_mu( 'studio-wp-admin.php', studio_golive_admin_mu( $admin ) );
			$add( 'admin-email', ! is_wp_error( $r ), is_wp_error( $r ) ? $err( $r ) : "Admin email pinned to $admin; only failure notices are sent" );
			if ( $req->get_param( 'user_email' ) ) {
				$u = wp_get_current_user();
				if ( strtolower( $u->user_email ) === strtolower( $admin ) ) {
					$add( 'user-email', true, "Your account ({$u->user_login}) already uses $admin" );
				} else {
					$r = wp_update_user( array( 'ID' => $u->ID, 'user_email' => $admin ) );
					$add( 'user-email', ! is_wp_error( $r ), is_wp_error( $r ) ? $err( $r ) : "Your account ({$u->user_login}) now uses $admin" );
				}
			}
		}
	}

	$recipient = sanitize_email( (string) $req->get_param( 'form_recipient' ) );
	if ( in_array( 'forms', $want, true ) ) {
		if ( is_email( $recipient ) ) {
			update_option( 'studio_form_recipient', $recipient, false );
			$add( 'form-recipient', true, "Studio forms send to $recipient" );
		} else {
			$add( 'form-recipient', false, 'Enter the address form messages should go to' );
		}
	}

	if ( in_array( 'webp', $want, true ) ) {
		update_option( 'studio_webp_uploads', 1 );
		$r    = studio_golive_write_rules( 'Studio WebP', studio_golive_webp_rules() );
		$made = studio_golive_webp_backfill( 400 );
		$add( 'webp', ! is_wp_error( $r ), "New uploads get a WebP copy; $made existing images converted. " . ( is_wp_error( $r ) ? 'Serving them needs server rules: ' . $err( $r ) : 'Browsers that take WebP are served it.' ) );
	}

	if ( in_array( 'llms', $want, true ) ) {
		update_option( 'studio_llms', 1 );
		$add( 'llms', true, 'llms.txt published at ' . home_url( '/llms.txt' ) );
	}

	return array( 'steps' => $steps, 'status' => studio_golive_status() );
}

/* ---------- WebP copies next to JPEG/PNG uploads ---------- */

function studio_golive_webp_copy( $path ) {
	if ( ! preg_match( '/\.(jpe?g|png)$/i', $path ) || ! file_exists( $path ) || file_exists( $path . '.webp' ) ) {
		return false;
	}
	$editor = wp_get_image_editor( $path );
	if ( is_wp_error( $editor ) ) {
		return false;
	}
	$saved = $editor->save( $path . '.webp', 'image/webp' );
	if ( is_wp_error( $saved ) || empty( $saved['path'] ) ) {
		return false;
	}
	// Some editors append their own extension; make sure the copy sits at file.jpg.webp.
	if ( $saved['path'] !== $path . '.webp' && file_exists( $saved['path'] ) ) {
		rename( $saved['path'], $path . '.webp' );
	}
	// Keep the copy only when it's actually smaller.
	if ( filesize( $path . '.webp' ) >= filesize( $path ) ) {
		wp_delete_file( $path . '.webp' );
		return false;
	}
	return true;
}

function studio_golive_webp_attachment( $id, $meta = null ) {
	$file = get_attached_file( $id );
	if ( ! $file ) {
		return 0;
	}
	$meta  = $meta ?: wp_get_attachment_metadata( $id );
	$paths = array( $file );
	foreach ( (array) ( $meta['sizes'] ?? array() ) as $size ) {
		if ( ! empty( $size['file'] ) ) {
			$paths[] = path_join( dirname( $file ), $size['file'] );
		}
	}
	if ( ! empty( $meta['original_image'] ) ) {
		$paths[] = path_join( dirname( $file ), $meta['original_image'] );
	}
	$n = 0;
	foreach ( array_unique( $paths ) as $p ) {
		$n += studio_golive_webp_copy( $p ) ? 1 : 0;
	}
	return $n;
}

function studio_golive_webp_backfill( $limit ) {
	if ( ! wp_image_editor_supports( array( 'mime_type' => 'image/webp' ) ) ) {
		return 0;
	}
	$ids = get_posts( array( 'post_type' => 'attachment', 'post_mime_type' => array( 'image/jpeg', 'image/png' ), 'posts_per_page' => $limit, 'fields' => 'ids', 'post_status' => 'inherit' ) );
	$n   = 0;
	foreach ( $ids as $id ) {
		$n += studio_golive_webp_attachment( $id ) ? 1 : 0;
	}
	return $n;
}

add_filter( 'wp_generate_attachment_metadata', function ( $meta, $id ) {
	if ( get_option( 'studio_webp_uploads' ) && wp_image_editor_supports( array( 'mime_type' => 'image/webp' ) ) ) {
		studio_golive_webp_attachment( $id, $meta );
	}
	return $meta;
}, 20, 2 );

add_action( 'delete_attachment', function ( $id ) {
	$file = get_attached_file( $id );
	if ( ! $file ) {
		return;
	}
	$meta  = wp_get_attachment_metadata( $id );
	$paths = array( $file );
	foreach ( (array) ( $meta['sizes'] ?? array() ) as $size ) {
		if ( ! empty( $size['file'] ) ) {
			$paths[] = path_join( dirname( $file ), $size['file'] );
		}
	}
	foreach ( $paths as $p ) {
		if ( file_exists( $p . '.webp' ) ) {
			wp_delete_file( $p . '.webp' );
		}
	}
} );

/* ---------- FluentSMTP: authenticated SMTP on the client's own domain ---------- */

function studio_golive_smtp( WP_REST_Request $req ) {
	if ( ! current_user_can( 'manage_options' ) ) {
		return new WP_Error( 'studio_not_admin', 'The connected WordPress user must be an administrator.', array( 'status' => 403 ) );
	}
	$installed = studio_woo_ensure_plugin( 'fluent-smtp', 'fluent-smtp/fluent-smtp.php' );
	if ( is_wp_error( $installed ) ) {
		return $installed;
	}
	$p    = $req->get_json_params();
	$from = sanitize_email( (string) ( $p['sender_email'] ?? '' ) );
	$host = sanitize_text_field( (string) ( $p['host'] ?? '' ) );
	$port = (int) ( $p['port'] ?? 0 );
	$enc  = in_array( $p['encryption'] ?? '', array( 'ssl', 'tls', 'none' ), true ) ? $p['encryption'] : 'tls';
	if ( ! is_email( $from ) || ! $host || ! $port ) {
		return new WP_Error( 'studio_smtp_input', 'Sender email, SMTP host and port are required', array( 'status' => 400 ) );
	}
	$site_host = wp_parse_url( home_url(), PHP_URL_HOST );
	$registrable = implode( '.', array_slice( explode( '.', (string) $site_host ), -2 ) );
	$connection = array(
		'provider'         => 'smtp',
		'sender_name'      => sanitize_text_field( (string) ( $p['sender_name'] ?? get_bloginfo( 'name' ) ) ),
		'sender_email'     => $from,
		'force_from_name'  => 'no',
		'force_from_email' => 'yes',
		'return_path'      => 'yes',
		'host'             => $host,
		'port'             => (string) $port,
		'auth'             => 'yes',
		'username'         => sanitize_text_field( (string) ( $p['username'] ?? $from ) ),
		'password'         => (string) ( $p['password'] ?? '' ),
		'auto_tls'         => 'yes',
		'encryption'       => $enc,
		'key_store'        => 'db',
	);
	if ( ! class_exists( '\FluentMail\App\Models\Settings' ) ) {
		// Activated in this request: its classes load on the next one.
		return new WP_Error( 'studio_smtp_retry', 'FluentSMTP was just installed. Save the SMTP settings again to finish.', array( 'status' => 409 ) );
	}
	$model = new \FluentMail\App\Models\Settings();
	$model->store( array( 'connection' => $connection, 'connection_key' => '', 'valid_senders' => array() ) );
	return array(
		'ok'          => true,
		'from'        => $from,
		'own_domain'  => $registrable && substr( strtolower( $from ), -strlen( $registrable ) ) === strtolower( $registrable ),
		'status'      => studio_golive_status(),
	);
}

/* ---------- test email through the site's own mail path ---------- */

function studio_golive_mailtest( WP_REST_Request $req ) {
	$to    = sanitize_email( (string) $req->get_param( 'to' ) );
	$token = preg_replace( '/[^a-zA-Z0-9-]/', '', (string) $req->get_param( 'token' ) );
	if ( ! is_email( $to ) || ! $token ) {
		return new WP_Error( 'studio_mailtest_input', 'An address and a token are required', array( 'status' => 400 ) );
	}
	$failed = '';
	$catch  = function ( $e ) use ( &$failed ) {
		$failed = $e->get_error_message();
	};
	add_action( 'wp_mail_failed', $catch );
	$sent = wp_mail( $to, 'Delivery test ' . $token, "This is an automated delivery test from Weborite Studio for " . home_url( '/' ) . ".\n\nToken: $token\n\nIt checks that mail from this website reaches outside inboxes and passes SPF. You can delete it." );
	remove_action( 'wp_mail_failed', $catch );
	return array( 'sent' => (bool) $sent, 'error' => $failed, 'mailer' => defined( 'FLUENTMAIL' ) ? 'FluentSMTP' : 'PHP mail()' );
}

/* ---------- the studio's hardened form handler ---------- */

/** Hidden fields for a studio form: action, form name, nonce, honeypot and a signed timestamp. */
function studio_form_fields( $form ) {
	update_option( 'studio_form_used', 1, false );
	$form = sanitize_key( $form );
	$ts   = time();
	echo '<input type="hidden" name="action" value="studio_form">';
	echo '<input type="hidden" name="studio_form" value="' . esc_attr( $form ) . '">';
	echo '<input type="hidden" name="studio_ts" value="' . esc_attr( $ts . '.' . wp_hash( $ts . $form ) ) . '">';
	echo '<input type="hidden" name="studio_back" value="' . esc_attr( ( is_ssl() ? 'https://' : 'http://' ) . ( isset( $_SERVER['HTTP_HOST'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_HOST'] ) ) : '' ) . ( isset( $_SERVER['REQUEST_URI'] ) ? esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '/' ) ) . '">';
	wp_nonce_field( 'studio_form_' . $form, 'studio_nonce' );
	// Honeypot: hidden from people, filled by bots.
	echo '<div aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden"><label>Leave this empty<input type="text" name="studio_website" value="" tabindex="-1" autocomplete="off"></label></div>';
}

/** 'sent', 'error' or '' for the form that was just submitted. */
function studio_form_status( $form ) {
	$f = isset( $_GET['studio_form_done'] ) ? sanitize_key( wp_unslash( $_GET['studio_form_done'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification
	$s = isset( $_GET['studio_form'] ) ? sanitize_key( wp_unslash( $_GET['studio_form'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification
	return $f === sanitize_key( $form ) && in_array( $s, array( 'sent', 'error' ), true ) ? $s : '';
}

function studio_form_handle() {
	// phpcs:disable WordPress.Security.NonceVerification.Missing
	$form = isset( $_POST['studio_form'] ) ? sanitize_key( wp_unslash( $_POST['studio_form'] ) ) : 'form';
	$back = isset( $_POST['studio_back'] ) ? esc_url_raw( wp_unslash( $_POST['studio_back'] ) ) : home_url( '/' );
	$back = wp_validate_redirect( remove_query_arg( array( 'studio_form', 'studio_form_done' ), $back ), home_url( '/' ) );
	$done = function ( $status ) use ( $back, $form ) {
		wp_safe_redirect( add_query_arg( array( 'studio_form' => $status, 'studio_form_done' => $form ), $back ) . '#' . rawurlencode( $form ) );
		exit;
	};
	// Bots fill the honeypot; pretend it worked so they don't adapt.
	if ( ! empty( $_POST['studio_website'] ) ) {
		$done( 'sent' );
	}
	if ( ! isset( $_POST['studio_nonce'] ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['studio_nonce'] ) ), 'studio_form_' . $form ) ) {
		$done( 'error' );
	}
	// Timing: a real person takes at least 3 seconds; a page older than a day is stale.
	$ts = isset( $_POST['studio_ts'] ) ? sanitize_text_field( wp_unslash( $_POST['studio_ts'] ) ) : '';
	list( $t, $sig ) = array_pad( explode( '.', $ts, 2 ), 2, '' );
	$age = time() - (int) $t;
	if ( ! hash_equals( wp_hash( $t . $form ), $sig ) || $age < 3 || $age > DAY_IN_SECONDS ) {
		$done( $age < 3 && hash_equals( wp_hash( $t . $form ), $sig ) ? 'sent' : 'error' );
	}
	// Rate limit: 5 messages per visitor per hour.
	$ip  = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
	$key = 'studio_form_rl_' . md5( $ip );
	$n   = (int) get_transient( $key );
	if ( $n >= 5 ) {
		$done( 'error' );
	}
	set_transient( $key, $n + 1, HOUR_IN_SECONDS );

	$skip   = array( 'action', 'studio_form', 'studio_ts', 'studio_back', 'studio_nonce', 'studio_website', '_wp_http_referer' );
	$fields = array();
	foreach ( $_POST as $k => $v ) {
		if ( in_array( $k, $skip, true ) || is_array( $v ) ) {
			continue;
		}
		$fields[ sanitize_key( $k ) ] = sanitize_textarea_field( wp_unslash( $v ) );
	}
	// phpcs:enable
	$to    = get_option( 'studio_form_recipient' ) ?: get_option( 'admin_email' );
	$email = isset( $fields['email'] ) && is_email( $fields['email'] ) ? $fields['email'] : '';
	$body  = '';
	foreach ( $fields as $k => $v ) {
		$body .= ucfirst( str_replace( '_', ' ', $k ) ) . ': ' . $v . "\n";
	}
	$body   .= "\n— Sent from " . home_url( '/' ) . ' (' . $form . ')';
	$headers = $email ? array( 'Reply-To: ' . ( isset( $fields['name'] ) ? str_replace( array( "\r", "\n", '<', '>' ), '', $fields['name'] ) . ' ' : '' ) . '<' . $email . '>' ) : array();
	$subject = sprintf( 'New message from %s', get_bloginfo( 'name' ) ) . ( isset( $fields['name'] ) ? ': ' . $fields['name'] : '' );
	$done( wp_mail( $to, $subject, $body, $headers ) ? 'sent' : 'error' );
}
add_action( 'admin_post_nopriv_studio_form', 'studio_form_handle' );
add_action( 'admin_post_studio_form', 'studio_form_handle' );

/* ---------- redirects: old URLs to their new home ---------- */

function studio_golive_norm_path( $p ) {
	$p = (string) wp_parse_url( $p, PHP_URL_PATH );
	$p = '/' . trim( strtolower( rawurldecode( $p ) ), '/' );
	return '/' === $p ? '/' : $p . '/';
}

add_action( 'template_redirect', function () {
	if ( ! is_404() ) {
		return;
	}
	$map = (array) get_option( 'studio_redirects', array() );
	if ( ! $map ) {
		return;
	}
	$path = studio_golive_norm_path( isset( $_SERVER['REQUEST_URI'] ) ? esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '/' );
	if ( isset( $map[ $path ] ) ) {
		$to = $map[ $path ];
		wp_redirect( 0 === strpos( $to, 'http' ) ? $to : home_url( $to ), 301, 'Weborite Studio' ); // phpcs:ignore WordPress.Security.SafeRedirect
		exit;
	}
}, 0 );

function studio_golive_redirects_put( WP_REST_Request $req ) {
	$map = array();
	foreach ( (array) $req->get_param( 'map' ) as $row ) {
		$from = studio_golive_norm_path( (string) ( $row['from'] ?? '' ) );
		$to   = trim( (string) ( $row['to'] ?? '' ) );
		if ( '/' === $from || '' === $to ) {
			continue;
		}
		$map[ $from ] = 0 === strpos( $to, 'http' ) ? esc_url_raw( $to ) : '/' . ltrim( $to, '/' );
	}
	update_option( 'studio_redirects', $map, false );
	return array( 'ok' => true, 'count' => count( $map ) );
}

/* ---------- go live: allow indexing, take down staging HTTP auth ---------- */

function studio_golive_live( WP_REST_Request $req ) {
	if ( ! current_user_can( 'manage_options' ) ) {
		return new WP_Error( 'studio_not_admin', 'The connected WordPress user must be an administrator.', array( 'status' => 403 ) );
	}
	$out = array( 'indexing' => false, 'auth_removed' => false, 'backup' => '' );
	if ( $req->get_param( 'index' ) ) {
		update_option( 'blog_public', 1 );
		$out['indexing'] = true;
	}
	if ( $req->get_param( 'remove_auth' ) && studio_golive_http_auth_lines() ) {
		$file   = studio_golive_htaccess();
		$before = (string) file_get_contents( $file );
		$backup = $file . '.studio-' . gmdate( 'Ymd-His' );
		copy( $file, $backup );
		$after  = implode( "\n", array_filter( explode( "\n", $before ), function ( $l ) {
			return ! preg_match( '/^\s*(AuthType|AuthName|AuthUserFile|AuthGroupFile|AuthBasicProvider|Require\s+(valid-user|user\s))/i', $l );
		} ) );
		$out['auth_removed'] = false !== file_put_contents( $file, $after );
		$out['backup']       = basename( $backup );
	}
	$out['status'] = studio_golive_status();
	return $out;
}

/* ---------- llms.txt ---------- */

add_action( 'init', function () {
	if ( ! get_option( 'studio_llms' ) || empty( $_SERVER['REQUEST_URI'] ) ) {
		return;
	}
	$path = (string) wp_parse_url( esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) ), PHP_URL_PATH );
	if ( $path !== (string) wp_parse_url( home_url( '/llms.txt' ), PHP_URL_PATH ) ) {
		return;
	}
	$lines = array( '# ' . get_bloginfo( 'name' ) );
	if ( get_bloginfo( 'description' ) ) {
		$lines[] = '';
		$lines[] = '> ' . get_bloginfo( 'description' );
	}
	$site = json_decode( (string) get_option( 'studio_schema_site' ), true );
	if ( is_array( $site ) ) {
		$facts = array();
		foreach ( array( 'telephone' => 'Phone', 'email' => 'Email', 'priceRange' => 'Price range' ) as $k => $label ) {
			if ( ! empty( $site[ $k ] ) && is_string( $site[ $k ] ) ) {
				$facts[] = "- $label: {$site[$k]}";
			}
		}
		if ( ! empty( $site['address'] ) && is_array( $site['address'] ) ) {
			$facts[] = '- Address: ' . implode( ', ', array_filter( array_map( 'strval', array_intersect_key( $site['address'], array_flip( array( 'streetAddress', 'addressLocality', 'postalCode', 'addressCountry' ) ) ) ) ) );
		}
		if ( $facts ) {
			array_push( $lines, '', '## Contact', ...$facts );
		}
	}
	$skip  = array_filter( array_map( 'intval', array( get_option( 'woocommerce_cart_page_id' ), get_option( 'woocommerce_checkout_page_id' ), get_option( 'woocommerce_myaccount_page_id' ), get_option( 'wp_page_for_privacy_policy' ) ) ) );
	$pages = get_pages( array( 'sort_column' => 'menu_order,post_title', 'post_status' => 'publish', 'exclude' => $skip ) );
	if ( $pages ) {
		$lines[] = '';
		$lines[] = '## Pages';
		foreach ( $pages as $p ) {
			$desc    = get_post_meta( $p->ID, '_studio_seo_desc', true );
			$lines[] = '- [' . get_the_title( $p ) . '](' . get_permalink( $p ) . ')' . ( $desc ? ': ' . $desc : '' );
		}
	}
	nocache_headers();
	header( 'Content-Type: text/plain; charset=utf-8' );
	echo implode( "\n", $lines ) . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput
	exit;
}, 0 );

/* ---------- SEO basics when no SEO plugin owns the head ---------- */

function studio_golive_canonical() {
	if ( is_singular() ) {
		return ''; // WordPress core prints these.
	}
	$paged = max( 1, (int) get_query_var( 'paged' ) );
	$url   = '';
	if ( is_front_page() ) {
		$url = home_url( '/' );
	} elseif ( is_home() ) {
		$url = get_option( 'page_for_posts' ) ? get_permalink( (int) get_option( 'page_for_posts' ) ) : home_url( '/' );
	} elseif ( is_category() || is_tag() || is_tax() ) {
		$term = get_queried_object();
		$link = $term ? get_term_link( $term ) : '';
		$url  = is_wp_error( $link ) ? '' : $link;
	} elseif ( is_post_type_archive() ) {
		$url = get_post_type_archive_link( get_query_var( 'post_type' ) ?: get_post_type() );
	}
	if ( $url && $paged > 1 ) {
		$url = get_pagenum_link( $paged );
	}
	return $url ? (string) $url : '';
}

add_action( 'wp_head', function () {
	if ( function_exists( 'studio_seo_plugin' ) && studio_seo_plugin() ) {
		return;
	}
	$canonical = studio_golive_canonical();
	if ( $canonical ) {
		echo '<link rel="canonical" href="' . esc_url( $canonical ) . '">' . "\n";
	}
	// Open Graph.
	$id    = is_singular() ? get_queried_object_id() : 0;
	$title = wp_get_document_title();
	$desc  = $id ? (string) get_post_meta( $id, '_studio_seo_desc', true ) : '';
	if ( ! $desc && $id ) {
		$desc = wp_trim_words( wp_strip_all_tags( (string) get_the_excerpt( $id ) ), 30, '…' );
	}
	if ( ! $desc ) {
		$desc = (string) get_bloginfo( 'description' );
	}
	$image = $id && has_post_thumbnail( $id ) ? (string) get_the_post_thumbnail_url( $id, 'large' ) : '';
	if ( ! $image && get_theme_mod( 'custom_logo' ) ) {
		$image = (string) wp_get_attachment_image_url( (int) get_theme_mod( 'custom_logo' ), 'full' );
	}
	if ( ! $image ) {
		$image = (string) get_site_icon_url( 512 );
	}
	$url  = $canonical ? $canonical : ( $id ? get_permalink( $id ) : home_url( '/' ) );
	$tags = array(
		'og:type'      => is_singular( 'post' ) ? 'article' : 'website',
		'og:site_name' => get_bloginfo( 'name' ),
		'og:title'     => $title,
		'og:description' => $desc,
		'og:url'       => $url,
		'og:image'     => $image,
	);
	foreach ( $tags as $k => $v ) {
		if ( $v ) {
			echo '<meta property="' . esc_attr( $k ) . '" content="' . esc_attr( $v ) . '">' . "\n";
		}
	}
	echo '<meta name="twitter:card" content="' . ( $image ? 'summary_large_image' : 'summary' ) . '">' . "\n";
}, 3 );

/* ---------- REST ---------- */

add_action( 'rest_api_init', function () {
	$admin = function () {
		return current_user_can( 'edit_pages' );
	};
	register_rest_route( 'studio/v1', '/golive/status', array( 'methods' => 'GET', 'permission_callback' => $admin, 'callback' => 'studio_golive_status' ) );
	register_rest_route( 'studio/v1', '/golive/kit', array( 'methods' => 'POST', 'permission_callback' => $admin, 'callback' => 'studio_golive_kit' ) );
	register_rest_route( 'studio/v1', '/golive/smtp', array( 'methods' => 'POST', 'permission_callback' => $admin, 'callback' => 'studio_golive_smtp' ) );
	register_rest_route( 'studio/v1', '/golive/mailtest', array( 'methods' => 'POST', 'permission_callback' => $admin, 'callback' => 'studio_golive_mailtest' ) );
	register_rest_route( 'studio/v1', '/golive/redirects', array(
		array( 'methods' => 'GET', 'permission_callback' => $admin, 'callback' => function () {
			$out = array();
			foreach ( (array) get_option( 'studio_redirects', array() ) as $from => $to ) {
				$out[] = array( 'from' => $from, 'to' => $to );
			}
			return $out;
		} ),
		array( 'methods' => 'PUT', 'permission_callback' => $admin, 'callback' => 'studio_golive_redirects_put' ),
	) );
	register_rest_route( 'studio/v1', '/golive/live', array( 'methods' => 'POST', 'permission_callback' => $admin, 'callback' => 'studio_golive_live' ) );
} );
