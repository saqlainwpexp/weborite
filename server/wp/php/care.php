<?php
/**
 * Studio Care: monthly maintenance endpoints for Mockup Studio.
 *
 * - status:    versions, available updates, environment fingerprint, security and database health
 * - staging:   step-by-step clone of this site into a private folder on the same server
 *              (same PHP, MySQL, extensions and server config), new table prefix, mail blocked
 * - update:    core / plugin / theme / translation updates, with a rollback copy of each item
 * - backup:    trigger UpdraftPlus and report when it finishes
 * - integrity: core and wordpress.org plugin checksums, PHP files in uploads
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'STUDIO_CARE_VERSION', 1 );

function studio_care_can() {
	return current_user_can( 'update_plugins' ) && current_user_can( 'manage_options' );
}

add_action( 'rest_api_init', function () {
	$routes = array(
		array( '/care/status', 'GET', 'studio_care_status' ),
		array( '/care/errors', 'GET', 'studio_care_errors' ),
		array( '/care/integrity', 'GET', 'studio_care_integrity' ),
		array( '/care/update', 'POST', 'studio_care_update' ),
		array( '/care/db-upgrade', 'POST', 'studio_care_db_upgrade' ),
		array( '/care/rollback', 'POST', 'studio_care_rollback' ),
		array( '/care/backup', 'POST', 'studio_care_backup' ),
		array( '/care/staging', 'POST', 'studio_care_staging' ),
		array( '/care/mail', 'GET', 'studio_care_mail' ),
		array( '/care/tidy', 'POST', 'studio_care_tidy' ),
	);
	foreach ( $routes as $r ) {
		register_rest_route( 'studio/v1', $r[0], array(
			'methods'             => $r[1],
			'permission_callback' => 'studio_care_can',
			'callback'            => $r[2],
		) );
	}
} );

function studio_care_admin_includes() {
	require_once ABSPATH . 'wp-admin/includes/admin.php';
	require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
	require_once ABSPATH . 'wp-admin/includes/update.php';
}

/* ---------- status ---------- */

function studio_care_status( WP_REST_Request $req ) {
	global $wpdb, $wp_version;
	studio_care_admin_includes();
	@set_time_limit( 120 );

	if ( $req->get_param( 'refresh' ) ) {
		if ( ! defined( 'STUDIO_UPDATING' ) ) {
			define( 'STUDIO_UPDATING', true );
		}
		delete_site_transient( 'update_plugins' );
		delete_site_transient( 'update_themes' );
		wp_version_check( array(), true );
		wp_update_plugins();
		wp_update_themes();
	}

	$pl_updates = get_site_transient( 'update_plugins' );
	$auto       = (array) get_site_option( 'auto_update_plugins', array() );
	$plugins    = array();
	foreach ( get_plugins() as $file => $p ) {
		$u    = isset( $pl_updates->response[ $file ] ) ? $pl_updates->response[ $file ] : null;
		$info = $u ? $u : ( isset( $pl_updates->no_update[ $file ] ) ? $pl_updates->no_update[ $file ] : null );
		$plugins[] = array(
			'file'        => $file,
			'slug'        => '.' === dirname( $file ) ? basename( $file, '.php' ) : dirname( $file ),
			'name'        => wp_strip_all_tags( $p['Name'] ),
			'version'     => $p['Version'],
			'active'      => is_plugin_active( $file ),
			'update'      => $u && isset( $u->new_version ) ? $u->new_version : '',
			'package'     => $u && ! empty( $u->package ),
			'requires_php' => $u && isset( $u->requires_php ) ? (string) $u->requires_php : '',
			'tested'      => $u && isset( $u->tested ) ? (string) $u->tested : '',
			'wporg'       => $info && isset( $info->id ) && 0 === strpos( (string) $info->id, 'w.org/plugins/' ),
			'auto_update' => in_array( $file, $auto, true ),
		);
	}

	$th_updates = get_site_transient( 'update_themes' );
	$themes     = array();
	foreach ( wp_get_themes() as $slug => $t ) {
		$themes[] = array(
			'stylesheet' => $slug,
			'name'       => wp_strip_all_tags( $t->get( 'Name' ) ),
			'version'    => $t->get( 'Version' ),
			'active'     => get_stylesheet() === $slug,
			'parent'     => get_template() === $slug && get_stylesheet() !== $slug,
			'update'     => isset( $th_updates->response[ $slug ]['new_version'] ) ? $th_updates->response[ $slug ]['new_version'] : '',
		);
	}

	$core        = get_preferred_from_update_core();
	$core_update = ( $core && isset( $core->response ) && 'upgrade' === $core->response ) ? $core->current : '';

	return array(
		'at'           => time(),
		'staging'      => defined( 'STUDIO_STAGING' ),
		'home'         => home_url(),
		'env'          => studio_care_env(),
		'core'         => array( 'version' => $wp_version, 'update' => $core_update, 'locale' => get_locale() ),
		'plugins'      => $plugins,
		'themes'       => $themes,
		'translations' => count( wp_get_translation_updates() ),
		'security'     => studio_care_security(),
		'db'           => studio_care_db_stats(),
		'backup'       => studio_care_backup_info(),
		'staging_site' => defined( 'STUDIO_STAGING' ) ? null : studio_stg_public( studio_stg_state() ),
		'rollbacks'    => get_option( 'studio_rollbacks', array() ),
		'paths'        => array( 'abspath' => ABSPATH, 'plugins' => WP_PLUGIN_DIR, 'themes' => get_theme_root(), 'content' => WP_CONTENT_DIR ),
		'paths_ok'     => studio_care_staging_paths_ok(),
	);
}

/** On the staging copy, refuse to touch files unless every path really is inside the staging folder. */
function studio_care_staging_paths_ok() {
	if ( ! defined( 'STUDIO_STAGING' ) ) {
		return true;
	}
	$root = wp_normalize_path( untrailingslashit( ABSPATH ) );
	if ( ! preg_match( '#/studio-staging-[a-z0-9]{6}$#', $root ) ) {
		return false;
	}
	foreach ( array( WP_PLUGIN_DIR, get_theme_root(), WP_CONTENT_DIR ) as $p ) {
		if ( 0 !== strpos( wp_normalize_path( $p ), $root . '/' ) ) {
			return false;
		}
	}
	return true;
}

function studio_care_env() {
	global $wpdb;
	$ext = get_loaded_extensions();
	sort( $ext );
	return array(
		'wp'           => get_bloginfo( 'version' ),
		'php'          => PHP_VERSION,
		'db'           => method_exists( $wpdb, 'db_server_info' ) ? $wpdb->db_server_info() : $wpdb->db_version(),
		'server'       => isset( $_SERVER['SERVER_SOFTWARE'] ) ? sanitize_text_field( wp_unslash( $_SERVER['SERVER_SOFTWARE'] ) ) : '',
		'sapi'         => php_sapi_name(),
		'extensions'   => $ext,
		'memory_limit' => ini_get( 'memory_limit' ),
		'wp_memory'    => defined( 'WP_MEMORY_LIMIT' ) ? WP_MEMORY_LIMIT : '',
		'max_exec'     => ini_get( 'max_execution_time' ),
		'upload_max'   => ini_get( 'upload_max_filesize' ),
		'locale'       => get_locale(),
		'multisite'    => is_multisite(),
		'https'        => 0 === strpos( home_url(), 'https://' ),
		'fs_method'    => function_exists( 'get_filesystem_method' ) ? get_filesystem_method() : '',
		'disk_free'    => function_exists( 'disk_free_space' ) ? @disk_free_space( ABSPATH ) : null,
		'object_cache' => wp_using_ext_object_cache(),
		'debug'        => defined( 'WP_DEBUG' ) && WP_DEBUG,
		'cron'         => ! ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ),
	);
}

function studio_care_security() {
	global $wpdb;
	$out = array();
	$add = function ( $id, $label, $status, $detail = '' ) use ( &$out ) {
		$out[] = array( 'id' => $id, 'label' => $label, 'status' => $status, 'detail' => $detail );
	};

	$display = defined( 'WP_DEBUG' ) && WP_DEBUG && ( ! defined( 'WP_DEBUG_DISPLAY' ) || WP_DEBUG_DISPLAY );
	$add( 'debug-display', 'PHP errors are hidden from visitors', $display ? 'fail' : 'ok', $display ? 'WP_DEBUG is on and errors display on the page' : '' );
	$add( 'file-edit', 'Theme and plugin file editor disabled', defined( 'DISALLOW_FILE_EDIT' ) && DISALLOW_FILE_EDIT ? 'ok' : 'warn', 'Add define( \'DISALLOW_FILE_EDIT\', true ) to wp-config.php' );

	$admins = get_users( array( 'role' => 'administrator', 'fields' => array( 'user_login', 'user_registered' ) ) );
	$logins = array_map( function ( $u ) {
		return $u->user_login . ' (since ' . substr( $u->user_registered, 0, 10 ) . ')';
	}, $admins );
	$add( 'admins', 'Administrator accounts reviewed', count( $admins ) > 3 ? 'warn' : 'info', count( $admins ) . ': ' . implode( ', ', array_slice( $logins, 0, 8 ) ) );
	$add( 'admin-user', 'No account called "admin"', username_exists( 'admin' ) ? 'warn' : 'ok', username_exists( 'admin' ) ? 'An account named "admin" exists, the first name bots try' : '' );

	$register = get_option( 'users_can_register' );
	$role     = get_option( 'default_role' );
	$add( 'registration', 'Open registration can\'t create admins', $register && in_array( $role, array( 'administrator', 'editor' ), true ) ? 'fail' : 'ok', $register ? 'Anyone can register, as ' . $role : 'Registration is closed' );

	$xmlrpc = apply_filters( 'xmlrpc_enabled', true );
	$add( 'xmlrpc', 'XML-RPC switched off', $xmlrpc ? 'warn' : 'ok', $xmlrpc ? 'xmlrpc.php accepts logins, a common brute-force target' : '' );

	$exposed = array_values( array_filter( array( 'readme.html', 'license.txt', 'wp-config-sample.php' ), function ( $f ) {
		return file_exists( ABSPATH . $f );
	} ) );
	$add( 'exposed-files', 'No version-revealing files in the site root', $exposed ? 'info' : 'ok', implode( ', ', $exposed ) );

	$uploads = wp_get_upload_dir();
	$php     = studio_care_find_php( $uploads['basedir'], 20 );
	$add( 'uploads-php', 'No PHP files in the uploads folder', $php ? 'fail' : 'ok', $php ? implode( ', ', $php ) : '' );

	$inactive = array();
	foreach ( get_plugins() as $file => $p ) {
		if ( ! is_plugin_active( $file ) ) {
			$inactive[] = wp_strip_all_tags( $p['Name'] );
		}
	}
	$add( 'inactive-plugins', 'No inactive plugins left installed', $inactive ? 'warn' : 'ok', implode( ', ', array_slice( $inactive, 0, 12 ) ) );

	$themes   = wp_get_themes();
	$unused   = array();
	$defaults = array();
	foreach ( $themes as $slug => $t ) {
		if ( get_stylesheet() === $slug || get_template() === $slug ) {
			continue;
		}
		if ( 0 === strpos( $slug, 'twenty' ) ) {
			$defaults[] = $slug;
		} else {
			$unused[] = wp_strip_all_tags( $t->get( 'Name' ) );
		}
	}
	// Keep one default theme as a fallback; flag anything else.
	$extra = array_merge( $unused, array_slice( $defaults, 1 ) );
	$add( 'inactive-themes', 'No unused themes besides one default', $extra ? 'warn' : 'ok', implode( ', ', $extra ) );

	$add( 'https', 'Site address uses HTTPS', 0 === strpos( home_url(), 'https://' ) ? 'ok' : 'fail', home_url() );
	$add( 'db-prefix', 'Database prefix changed from wp_', 'wp_' === $wpdb->prefix ? 'info' : 'ok', $wpdb->prefix );
	$core_auto = ! ( defined( 'AUTOMATIC_UPDATER_DISABLED' ) && AUTOMATIC_UPDATER_DISABLED ) && ( ! defined( 'WP_AUTO_UPDATE_CORE' ) || false !== WP_AUTO_UPDATE_CORE );
	$add( 'core-auto', 'Security releases of WordPress install automatically', $core_auto ? 'ok' : 'info', $core_auto ? '' : 'Automatic minor updates are switched off' );
	return $out;
}

function studio_care_find_php( $dir, $limit ) {
	$found = array();
	if ( ! is_dir( $dir ) ) {
		return $found;
	}
	try {
		$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ) );
		$n  = 0;
		foreach ( $it as $f ) {
			if ( ++$n > 60000 ) {
				break;
			}
			if ( $f->isFile() && preg_match( '/\.(php\d?|phtml|phar)$/i', $f->getFilename() ) && 'index.php' !== $f->getFilename() ) {
				$found[] = str_replace( '\\', '/', substr( $f->getPathname(), strlen( $dir ) + 1 ) );
				if ( count( $found ) >= $limit ) {
					break;
				}
			}
		}
	} catch ( Exception $e ) {
		// Unreadable folder: report what we have.
	}
	return $found;
}

function studio_care_db_stats() {
	global $wpdb;
	$like = $wpdb->esc_like( $wpdb->prefix ) . '%';
	$size = $wpdb->get_var( $wpdb->prepare( 'SELECT SUM(data_length + index_length) FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name LIKE %s', $like ) );
	return array(
		'size'           => (int) $size,
		'revisions'      => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'revision'" ),
		'auto_drafts'    => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_status = 'auto-draft'" ),
		'trash'          => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_status = 'trash'" ),
		'spam_comments'  => (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->comments} WHERE comment_approved IN ('spam','trash')" ),
		'transients'     => (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE %s AND option_value < %d", $wpdb->esc_like( '_transient_timeout_' ) . '%', time() ) ),
		'autoload'       => (int) $wpdb->get_var( "SELECT SUM(LENGTH(option_value)) FROM {$wpdb->options} WHERE autoload IN ('yes','on','auto-on','auto')" ),
	);
}

/* ---------- PHP error log ---------- */

function studio_care_log_files() {
	$files = array();
	if ( defined( 'WP_DEBUG_LOG' ) && is_string( WP_DEBUG_LOG ) ) {
		$files[] = WP_DEBUG_LOG;
	}
	$files[] = WP_CONTENT_DIR . '/debug.log';
	$ini     = ini_get( 'error_log' );
	if ( $ini ) {
		$files[] = $ini;
	}
	$files[] = ABSPATH . 'error_log';
	$files[] = ABSPATH . 'wp-admin/error_log';
	return array_values( array_unique( array_filter( $files, function ( $f ) {
		return @is_file( $f ) && @is_readable( $f );
	} ) ) );
}

/** Fatal errors and warnings logged since ?since= (unix time), from the last 512 KB of each log. */
function studio_care_errors( WP_REST_Request $req ) {
	$since  = (int) $req->get_param( 'since' );
	$fatal  = array();
	$counts = array( 'fatal' => 0, 'warning' => 0 );
	foreach ( studio_care_log_files() as $file ) {
		$size = filesize( $file );
		$fh   = fopen( $file, 'r' );
		if ( ! $fh ) {
			continue;
		}
		fseek( $fh, max( 0, $size - 524288 ) );
		$chunk = stream_get_contents( $fh );
		fclose( $fh );
		foreach ( explode( "\n", $chunk ) as $line ) {
			if ( ! preg_match( '/^\[([^\]]+)\]\s*(PHP )?(Fatal error|Parse error|Warning|Uncaught)/i', $line, $m ) ) {
				continue;
			}
			$t = strtotime( $m[1] );
			if ( $since && $t && $t < $since ) {
				continue;
			}
			if ( stripos( $m[3], 'warning' ) !== false ) {
				++$counts['warning'];
			} else {
				++$counts['fatal'];
				$fatal[] = substr( $line, 0, 400 );
			}
		}
	}
	return array( 'counts' => $counts, 'fatal' => array_slice( $fatal, -15 ), 'files' => count( studio_care_log_files() ) );
}

/* ---------- updates ---------- */

function studio_care_update( WP_REST_Request $req ) {
	if ( ! defined( 'STUDIO_UPDATING' ) ) {
		define( 'STUDIO_UPDATING', true );
	}
	studio_care_admin_includes();
	@set_time_limit( 600 );
	if ( ! studio_care_staging_paths_ok() ) {
		return new WP_Error( 'studio_paths', 'Refusing to update: this staging copy points at folders outside itself.', array( 'status' => 409 ) );
	}
	$method = get_filesystem_method();
	if ( 'direct' !== $method ) {
		return new WP_Error( 'studio_fs', 'WordPress can\'t write files directly on this server (method: ' . $method . '). Add define( \'FS_METHOD\', \'direct\' ) to wp-config.php if the host allows it.', array( 'status' => 409 ) );
	}
	WP_Filesystem();
	$type = (string) $req->get_param( 'type' );
	$id   = (string) $req->get_param( 'id' );
	$skin = new WP_Ajax_Upgrader_Skin();

	if ( 'plugin' === $type ) {
		wp_update_plugins();
		$all = get_plugins();
		if ( ! isset( $all[ $id ] ) ) {
			return new WP_Error( 'studio_missing', 'Plugin not installed: ' . $id, array( 'status' => 404 ) );
		}
		$from = $all[ $id ]['Version'];
		$dir  = '.' === dirname( $id ) ? $id : dirname( $id );
		studio_care_snapshot( 'plugins', $dir, $from );
		$up  = new Plugin_Upgrader( $skin );
		$res = $up->bulk_upgrade( array( $id ) );
		wp_clean_plugins_cache();
		$now = get_plugins();
		$to  = isset( $now[ $id ] ) ? $now[ $id ]['Version'] : '';
		$r   = is_array( $res ) && isset( $res[ $id ] ) ? $res[ $id ] : $res;
	} elseif ( 'theme' === $type ) {
		wp_update_themes();
		$theme = wp_get_theme( $id );
		if ( ! $theme->exists() ) {
			return new WP_Error( 'studio_missing', 'Theme not installed: ' . $id, array( 'status' => 404 ) );
		}
		$from = $theme->get( 'Version' );
		studio_care_snapshot( 'themes', $id, $from );
		$up  = new Theme_Upgrader( $skin );
		$res = $up->bulk_upgrade( array( $id ) );
		wp_clean_themes_cache();
		$to = wp_get_theme( $id )->get( 'Version' );
		$r  = is_array( $res ) && isset( $res[ $id ] ) ? $res[ $id ] : $res;
	} elseif ( 'core' === $type ) {
		global $wp_version;
		$from = $wp_version;
		wp_version_check( array(), true );
		$update = get_preferred_from_update_core();
		if ( ! $update || 'upgrade' !== $update->response ) {
			return array( 'ok' => true, 'from' => $from, 'to' => $from, 'messages' => array( 'Already up to date' ), 'errors' => array() );
		}
		$up = new Core_Upgrader( $skin );
		$r  = $up->upgrade( $update, array( 'attempt_rollback' => true ) );
		$to = is_string( $r ) ? $r : $from;
	} elseif ( 'translations' === $type ) {
		$from = (string) count( wp_get_translation_updates() );
		$up   = new Language_Pack_Upgrader( $skin );
		$r    = $up->bulk_upgrade( wp_get_translation_updates() );
		$to   = (string) count( wp_get_translation_updates() );
	} else {
		return new WP_Error( 'studio_type', 'Unknown update type', array( 'status' => 400 ) );
	}

	$errors = array();
	if ( is_wp_error( $r ) ) {
		$errors = $r->get_error_messages();
	}
	if ( $skin->get_errors()->has_errors() ) {
		$errors = array_merge( $errors, $skin->get_errors()->get_error_messages() );
	}
	$changed = 'translations' === $type ? ! $errors : version_compare( (string) $to, (string) $from, '!=' );
	return array(
		'ok'       => ! $errors && false !== $r && null !== $r && $changed,
		'from'     => $from,
		'to'       => $to,
		'messages' => array_slice( array_map( 'wp_strip_all_tags', (array) $skin->get_upgrade_messages() ), -12 ),
		'errors'   => array_values( array_unique( array_map( 'wp_strip_all_tags', $errors ) ) ),
	);
}

/** Runs in a fresh request after a core update, so the new $wp_db_version is loaded. */
function studio_care_db_upgrade() {
	global $wp_db_version;
	require_once ABSPATH . 'wp-admin/includes/upgrade.php';
	$before = (int) get_option( 'db_version' );
	if ( $before !== (int) $wp_db_version ) {
		wp_upgrade();
	}
	return array( 'ok' => true, 'from' => $before, 'to' => (int) get_option( 'db_version' ) );
}

/* ---------- rollback copies (one per plugin/theme, taken right before its update) ---------- */

function studio_care_rollback_root() {
	$root = WP_CONTENT_DIR . '/studio-rollback';
	if ( ! is_dir( $root ) ) {
		wp_mkdir_p( $root );
	}
	if ( ! file_exists( $root . '/.htaccess' ) ) {
		file_put_contents( $root . '/.htaccess', "Require all denied\nDeny from all\n" );
		file_put_contents( $root . '/index.php', "<?php\n// Silence.\n" );
	}
	return $root;
}

function studio_care_safe_name( $name ) {
	return is_string( $name ) && '' !== $name && preg_match( '/^[A-Za-z0-9._-]+$/', $name ) && false === strpos( $name, '..' );
}

function studio_care_snapshot( $kind, $name, $version ) {
	if ( ! studio_care_safe_name( $name ) ) {
		return false;
	}
	$src = ( 'plugins' === $kind ? WP_PLUGIN_DIR : get_theme_root() ) . '/' . $name;
	if ( ! file_exists( $src ) ) {
		return false;
	}
	$dest = studio_care_rollback_root() . '/' . $kind . '/' . $name;
	studio_care_rrmdir( $dest );
	wp_mkdir_p( dirname( $dest ) );
	studio_care_copy( $src, $dest );
	$all                        = get_option( 'studio_rollbacks', array() );
	$all[ $kind . '/' . $name ] = array( 'version' => $version, 'at' => time() );
	update_option( 'studio_rollbacks', $all, false );
	return true;
}

function studio_care_rollback( WP_REST_Request $req ) {
	if ( ! studio_care_staging_paths_ok() ) {
		return new WP_Error( 'studio_paths', 'Refusing to roll back: this staging copy points at folders outside itself.', array( 'status' => 409 ) );
	}
	$kind = 'theme' === $req->get_param( 'type' ) ? 'themes' : 'plugins';
	$name = (string) $req->get_param( 'id' );
	if ( 'plugins' === $kind && false !== strpos( $name, '/' ) ) {
		$name = dirname( $name );
	}
	if ( ! studio_care_safe_name( $name ) ) {
		return new WP_Error( 'studio_name', 'Invalid name', array( 'status' => 400 ) );
	}
	$snap = studio_care_rollback_root() . '/' . $kind . '/' . $name;
	if ( ! file_exists( $snap ) ) {
		return new WP_Error( 'studio_no_snapshot', 'No rollback copy for ' . $name, array( 'status' => 404 ) );
	}
	$target = ( 'plugins' === $kind ? WP_PLUGIN_DIR : get_theme_root() ) . '/' . $name;
	$old    = $target . '.studio-old';
	studio_care_rrmdir( $old );
	if ( file_exists( $target ) && ! @rename( $target, $old ) ) {
		return new WP_Error( 'studio_rename', 'Could not move the updated version aside', array( 'status' => 500 ) );
	}
	studio_care_copy( $snap, $target );
	studio_care_rrmdir( $old );
	if ( 'plugins' === $kind ) {
		wp_clean_plugins_cache();
	} else {
		wp_clean_themes_cache();
	}
	$all = get_option( 'studio_rollbacks', array() );
	return array( 'ok' => true, 'version' => isset( $all[ $kind . '/' . $name ] ) ? $all[ $kind . '/' . $name ]['version'] : '' );
}

/* ---------- backups (UpdraftPlus) ---------- */

function studio_care_backup_info() {
	$known = array(
		'UpdraftPlus'          => class_exists( 'UpdraftPlus' ),
		'WPvivid'              => class_exists( 'WPvivid' ),
		'BackWPup'             => class_exists( 'BackWPup' ),
		'Duplicator'           => defined( 'DUPLICATOR_VERSION' ) || defined( 'DUPLICATOR_PRO_VERSION' ),
		'All-in-One WP Migration' => defined( 'AI1WM_VERSION' ),
		'Jetpack VaultPress Backup' => class_exists( 'Automattic\\Jetpack\\Backup\\Jetpack_Backup' ) || defined( 'JETPACK_BACKUP_PLUGIN_VERSION' ),
		'BlogVault'            => defined( 'BVVERSION' ),
		'Solid Backups'        => class_exists( 'backupbuddy_core' ) || class_exists( 'pb_backupbuddy' ),
	);
	$plugins = array_keys( array_filter( $known ) );
	$last    = get_option( 'updraft_last_backup' );
	return array(
		'plugins' => $plugins,
		'updraft' => class_exists( 'UpdraftPlus' ),
		'last'    => is_array( $last ) && ! empty( $last['backup_time'] ) ? (int) $last['backup_time'] : 0,
		'last_ok' => is_array( $last ) && ! empty( $last['success'] ),
	);
}

function studio_care_backup( WP_REST_Request $req ) {
	if ( ! class_exists( 'UpdraftPlus' ) ) {
		return new WP_Error( 'studio_no_updraft', 'UpdraftPlus is not active on this site.', array( 'status' => 409 ) );
	}
	if ( 'start' === $req->get_param( 'action' ) ) {
		$at = time();
		update_option( 'studio_backup_started', $at, false );
		wp_schedule_single_event( $at, 'updraft_backupnow_backup_all', array( array( 'nocloud' => 0, 'label' => 'Before Studio maintenance' ) ) );
		spawn_cron();
		return array( 'started' => $at );
	}
	$started = (int) get_option( 'studio_backup_started' );
	$last    = get_option( 'updraft_last_backup' );
	$done    = $started && is_array( $last ) && ! empty( $last['backup_time'] ) && (int) $last['backup_time'] >= $started - 5;
	$errors  = $done && ! empty( $last['errors'] ) ? array_slice( array_map( 'wp_strip_all_tags', (array) $last['errors'] ), 0, 5 ) : array();
	return array(
		'started' => $started,
		'done'    => $done,
		'success' => $done && ! empty( $last['success'] ),
		'time'    => $done ? (int) $last['backup_time'] : 0,
		'errors'  => $errors,
		'queued'  => (bool) wp_next_scheduled( 'updraft_backupnow_backup_all', array( array( 'nocloud' => 0, 'label' => 'Before Studio maintenance' ) ) ),
	);
}

/* ---------- integrity ---------- */

function studio_care_integrity() {
	global $wp_version, $wp_local_package;
	studio_care_admin_includes();
	@set_time_limit( 300 );
	$locale = isset( $wp_local_package ) ? $wp_local_package : 'en_US';
	$sums   = get_core_checksums( $wp_version, $locale );
	if ( ! $sums && 'en_US' !== $locale ) {
		$sums = get_core_checksums( $wp_version, 'en_US' );
	}
	$core = array( 'checked' => (bool) $sums, 'modified' => array(), 'missing' => array(), 'unknown' => array() );
	if ( $sums ) {
		foreach ( $sums as $file => $md5 ) {
			if ( 0 === strpos( $file, 'wp-content/' ) ) {
				continue;
			}
			$path = ABSPATH . $file;
			if ( ! file_exists( $path ) ) {
				$core['missing'][] = $file;
			} elseif ( md5_file( $path ) !== $md5 ) {
				$core['modified'][] = $file;
			}
		}
		foreach ( array( 'wp-admin', 'wp-includes' ) as $dir ) {
			$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( ABSPATH . $dir, FilesystemIterator::SKIP_DOTS ) );
			foreach ( $it as $f ) {
				$rel = $dir . '/' . str_replace( '\\', '/', substr( $f->getPathname(), strlen( ABSPATH . $dir ) + 1 ) );
				if ( $f->isFile() && ! isset( $sums[ $rel ] ) && preg_match( '/\.php$/i', $rel ) ) {
					$core['unknown'][] = $rel;
					if ( count( $core['unknown'] ) >= 30 ) {
						break 2;
					}
				}
			}
		}
		foreach ( glob( ABSPATH . '*.php' ) as $f ) {
			$rel = basename( $f );
			if ( ! isset( $sums[ $rel ] ) && 'wp-config.php' !== $rel ) {
				$core['unknown'][] = $rel;
			}
		}
	}

	$plugins = array();
	foreach ( get_plugins() as $file => $p ) {
		$slug = dirname( $file );
		if ( '.' === $slug ) {
			continue;
		}
		$r = wp_remote_get( 'https://downloads.wordpress.org/plugin-checksums/' . rawurlencode( $slug ) . '/' . rawurlencode( $p['Version'] ) . '.json', array( 'timeout' => 15 ) );
		if ( 200 !== (int) wp_remote_retrieve_response_code( $r ) ) {
			continue; // Not a wordpress.org plugin, or that version isn't listed.
		}
		$json = json_decode( wp_remote_retrieve_body( $r ), true );
		if ( empty( $json['files'] ) ) {
			continue;
		}
		$modified = array();
		foreach ( $json['files'] as $rel => $h ) {
			if ( ! preg_match( '/\.(php|js)$/i', $rel ) ) {
				continue;
			}
			$path = WP_PLUGIN_DIR . '/' . $slug . '/' . $rel;
			if ( ! file_exists( $path ) ) {
				continue;
			}
			$md5 = is_array( $h['md5'] ) ? $h['md5'] : array( $h['md5'] );
			if ( ! in_array( md5_file( $path ), $md5, true ) ) {
				$modified[] = $rel;
			}
		}
		$added = array();
		$it    = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( WP_PLUGIN_DIR . '/' . $slug, FilesystemIterator::SKIP_DOTS ) );
		foreach ( $it as $f ) {
			$rel = str_replace( '\\', '/', substr( $f->getPathname(), strlen( WP_PLUGIN_DIR . '/' . $slug ) + 1 ) );
			if ( $f->isFile() && preg_match( '/\.php$/i', $rel ) && ! isset( $json['files'][ $rel ] ) ) {
				$added[] = $rel;
				if ( count( $added ) >= 20 ) {
					break;
				}
			}
		}
		$plugins[] = array( 'slug' => $slug, 'name' => wp_strip_all_tags( $p['Name'] ), 'modified' => array_slice( $modified, 0, 20 ), 'added' => $added );
	}
	$uploads = wp_get_upload_dir();
	return array( 'core' => $core, 'plugins' => $plugins, 'uploads_php' => studio_care_find_php( $uploads['basedir'], 50 ) );
}

/* ---------- database tidy ---------- */

function studio_care_tidy() {
	global $wpdb;
	@set_time_limit( 300 );
	$out = array( 'transients' => 0, 'comments' => 0, 'auto_drafts' => 0, 'revisions' => 0 );

	$out['transients'] = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE %s AND option_value < %d", $wpdb->esc_like( '_transient_timeout_' ) . '%', time() ) );
	delete_expired_transients( true );

	$ids = $wpdb->get_col( "SELECT comment_ID FROM {$wpdb->comments} WHERE comment_approved IN ('spam','trash') AND comment_date_gmt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY) LIMIT 2000" );
	foreach ( $ids as $id ) {
		wp_delete_comment( (int) $id, true );
	}
	$out['comments'] = count( $ids );

	$ids = $wpdb->get_col( "SELECT ID FROM {$wpdb->posts} WHERE post_status = 'auto-draft' AND post_date_gmt < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) LIMIT 1000" );
	foreach ( $ids as $id ) {
		wp_delete_post( (int) $id, true );
	}
	$out['auto_drafts'] = count( $ids );

	// Keep the 10 newest revisions of every post.
	$rows = $wpdb->get_results( "SELECT ID, post_parent FROM {$wpdb->posts} WHERE post_type = 'revision' ORDER BY post_parent, post_date DESC" );
	$seen = array();
	$n    = 0;
	foreach ( $rows as $row ) {
		$seen[ $row->post_parent ] = isset( $seen[ $row->post_parent ] ) ? $seen[ $row->post_parent ] + 1 : 1;
		if ( $seen[ $row->post_parent ] > 10 && $n < 3000 ) {
			wp_delete_post_revision( (int) $row->ID );
			++$n;
		}
	}
	$out['revisions'] = $n;
	return $out;
}

/* ---------- staging mail log (read on the staging copy) ---------- */

function studio_care_mail( WP_REST_Request $req ) {
	$since = (int) $req->get_param( 'since' );
	$mail  = array_values( array_filter( (array) get_option( 'studio_staging_mail', array() ), function ( $m ) use ( $since ) {
		return (int) $m['at'] >= $since;
	} ) );
	$blocked = array_values( array_filter( (array) get_option( 'studio_staging_blocked', array() ), function ( $m ) use ( $since ) {
		return (int) $m['at'] >= $since;
	} ) );
	return array( 'mail' => $mail, 'blocked' => $blocked );
}

/* ---------- file helpers ---------- */

function studio_care_rrmdir( $path ) {
	if ( is_link( $path ) || is_file( $path ) ) {
		return @unlink( $path );
	}
	if ( ! is_dir( $path ) ) {
		return true;
	}
	$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $path, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::CHILD_FIRST );
	foreach ( $it as $f ) {
		if ( $f->isDir() && ! $f->isLink() ) {
			@rmdir( $f->getPathname() );
		} else {
			@unlink( $f->getPathname() );
		}
	}
	return @rmdir( $path );
}

function studio_care_copy( $src, $dest ) {
	if ( is_file( $src ) ) {
		return @copy( $src, $dest );
	}
	wp_mkdir_p( $dest );
	$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $src, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::SELF_FIRST );
	foreach ( $it as $f ) {
		$target = $dest . '/' . substr( $f->getPathname(), strlen( $src ) + 1 );
		if ( $f->isDir() ) {
			wp_mkdir_p( $target );
		} else {
			@copy( $f->getPathname(), $target );
		}
	}
	return true;
}

/* ================================================================
 * Staging: a private copy in ABSPATH/studio-staging-xxxxxx on the same server.
 * Cloned in short steps (each REST call works for ~20 s) so no host timeout is hit.
 * ================================================================ */

function studio_stg_state() {
	return get_option( 'studio_staging', array() );
}

function studio_stg_save( $s ) {
	$s['updated_at'] = time();
	update_option( 'studio_staging', $s, false );
}

function studio_stg_public( $s ) {
	if ( ! $s ) {
		return array( 'status' => 'none' );
	}
	return array(
		'status'     => $s['phase'],
		'url'        => $s['url'],
		'token'      => $s['token'],
		'dir'        => $s['dir'],
		'files'      => array( 'done' => (int) $s['cursor'], 'total' => (int) $s['total'] ),
		'tables'     => array( 'done' => (int) $s['table_i'], 'total' => count( (array) $s['tables'] ) ),
		'skip_media' => ! empty( $s['skip_media'] ),
		'created_at' => (int) $s['created_at'],
		'ready_at'   => isset( $s['ready_at'] ) ? (int) $s['ready_at'] : 0,
		'error'      => isset( $s['error'] ) ? $s['error'] : '',
	);
}

function studio_care_staging( WP_REST_Request $req ) {
	global $wpdb;
	if ( defined( 'STUDIO_STAGING' ) ) {
		return new WP_Error( 'studio_is_staging', 'This is already the staging copy.', array( 'status' => 409 ) );
	}
	if ( is_multisite() ) {
		return new WP_Error( 'studio_multisite', 'Staging isn\'t supported on multisite networks yet.', array( 'status' => 409 ) );
	}
	if ( untrailingslashit( WP_CONTENT_DIR ) !== untrailingslashit( ABSPATH . 'wp-content' ) ) {
		return new WP_Error( 'studio_layout', 'This site keeps wp-content outside the WordPress folder, which staging doesn\'t support yet.', array( 'status' => 409 ) );
	}
	@set_time_limit( 300 );
	$action = (string) $req->get_param( 'action' );

	if ( 'status' === $action ) {
		return studio_stg_public( studio_stg_state() );
	}
	if ( 'delete' === $action ) {
		studio_stg_delete( studio_stg_state() );
		delete_option( 'studio_staging' );
		return array( 'status' => 'none' );
	}
	if ( 'start' === $action ) {
		studio_stg_delete( studio_stg_state() ); // every clone starts fresh from live
		$server = isset( $_SERVER['SERVER_SOFTWARE'] ) ? strtolower( (string) $_SERVER['SERVER_SOFTWARE'] ) : '';
		$dir    = 'studio-staging-' . strtolower( wp_generate_password( 6, false ) );
		do {
			$prefix = 'zs' . strtolower( wp_generate_password( 4, false ) ) . '_';
		} while ( 0 === strpos( $prefix, $wpdb->prefix ) );
		$s = array(
			'phase'      => 'scan',
			'dir'        => $dir,
			'prefix'     => $prefix,
			'token'      => wp_generate_password( 32, false ),
			'url'        => untrailingslashit( site_url() ) . '/' . $dir,
			'skip_media' => false !== strpos( $server, 'apache' ) || false !== strpos( $server, 'litespeed' ),
			'cursor'     => 0,
			'total'      => 0,
			'tables'     => array(),
			'table_i'    => 0,
			'created_at' => time(),
		);
		studio_stg_save( $s );
	}

	$s = studio_stg_state();
	if ( ! $s ) {
		return new WP_Error( 'studio_no_staging', 'Start a staging clone first.', array( 'status' => 409 ) );
	}
	if ( in_array( $s['phase'], array( 'ready', 'failed' ), true ) ) {
		return studio_stg_public( $s );
	}
	$deadline = microtime( true ) + 20;
	try {
		while ( microtime( true ) < $deadline && ! in_array( $s['phase'], array( 'ready', 'failed' ), true ) ) {
			$s = studio_stg_step( $s, $deadline );
			studio_stg_save( $s );
		}
	} catch ( Exception $e ) {
		$s['phase'] = 'failed';
		$s['error'] = $e->getMessage();
		studio_stg_save( $s );
	}
	return studio_stg_public( $s );
}

function studio_stg_root( $s ) {
	return untrailingslashit( ABSPATH ) . '/' . $s['dir'];
}

function studio_stg_list_file( $s ) {
	return studio_stg_root( $s ) . '/.studio-files.php';
}

function studio_stg_step( $s, $deadline ) {
	global $wpdb;
	$root = studio_stg_root( $s );

	if ( 'scan' === $s['phase'] ) {
		wp_mkdir_p( $root );
		$media = '/\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|heic|ico|mp4|webm|mov|m4v|mp3|wav|ogg|pdf|zip|psd|docx?|xlsx?|pptx?)$/i';
		$skip  = '#^wp-content/(studio-rollback|cache|litespeed|upgrade|upgrade-temp-backup|updraft|ai1wm-backups|backups-dup-lite|backups-dup-pro|wpvividbackups|backup-db|backups|et-cache|wflogs|w3tc-config|uploads/backwpup[^/]*)(/|$)#';
		$list  = array();
		$bytes = 0;
		// Only WordPress itself: root files plus wp-admin, wp-includes and wp-content. Other folders
		// in the web root are often separate sites (addon domains) and are left alone.
		foreach ( scandir( ABSPATH ) as $f ) {
			if ( '.' === $f || '..' === $f || ! is_file( ABSPATH . $f ) || is_link( ABSPATH . $f ) ) {
				continue;
			}
			if ( in_array( $f, array( 'wp-config.php', '.htaccess', 'error_log', '.user.ini', '.maintenance' ), true ) || preg_match( '/\.(zip|gz|tar|sql|log|wpress)$/i', $f ) ) {
				continue;
			}
			$list[] = $f;
			$bytes += filesize( ABSPATH . $f );
		}
		foreach ( array( 'wp-admin', 'wp-includes', 'wp-content' ) as $top ) {
			$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( ABSPATH . $top, FilesystemIterator::SKIP_DOTS ) );
			foreach ( $it as $f ) {
				if ( ! $f->isFile() || $f->isLink() ) {
					continue;
				}
				$rel = $top . '/' . str_replace( '\\', '/', substr( $f->getPathname(), strlen( ABSPATH . $top ) + 1 ) );
				if ( preg_match( $skip, $rel ) || preg_match( '#(^|/)(\.git|node_modules)/#', $rel ) || preg_match( '#(^|/)(error_log|debug\.log)$#', $rel ) ) {
					continue;
				}
				if ( 'wp-content/object-cache.php' === $rel || 'wp-content/advanced-cache.php' === $rel ) {
					continue; // Drop-ins would share the live object/page cache.
				}
				if ( $s['skip_media'] && 0 === strpos( $rel, 'wp-content/uploads/' ) && preg_match( $media, $rel ) ) {
					continue; // Served from live through the staging .htaccess.
				}
				$size = $f->getSize();
				if ( $size > 64 * 1048576 ) {
					continue;
				}
				$list[] = $rel;
				$bytes += $size;
			}
		}
		$db    = studio_care_db_stats();
		$free  = function_exists( 'disk_free_space' ) ? @disk_free_space( ABSPATH ) : false;
		$needs = (int) ( ( $bytes + $db['size'] ) * 1.15 );
		if ( $free && $free < $needs ) {
			throw new Exception( sprintf( 'Not enough disk space for a staging copy: needs about %s, %s free.', size_format( $needs ), size_format( $free ) ) );
		}
		file_put_contents( studio_stg_list_file( $s ), "<?php exit; ?>\n" . implode( "\n", $list ) );
		$s['total']  = count( $list );
		$s['bytes']  = $bytes;
		$s['cursor'] = 0;
		$s['phase']  = 'files';
		return $s;
	}

	if ( 'files' === $s['phase'] ) {
		$lines = file( studio_stg_list_file( $s ), FILE_IGNORE_NEW_LINES );
		array_shift( $lines );
		$n = count( $lines );
		$i = (int) $s['cursor'];
		for ( ; $i < $n && microtime( true ) < $deadline; $i++ ) {
			$rel = $lines[ $i ];
			if ( '' === $rel ) {
				continue;
			}
			$dst = $root . '/' . $rel;
			$dir = dirname( $dst );
			if ( ! is_dir( $dir ) ) {
				wp_mkdir_p( $dir );
			}
			@copy( ABSPATH . $rel, $dst );
		}
		$s['cursor'] = $i;
		if ( $i >= $n ) {
			$s['phase'] = 'tables';
		}
		return $s;
	}

	if ( 'tables' === $s['phase'] ) {
		if ( empty( $s['tables'] ) ) {
			$rows        = $wpdb->get_results( $wpdb->prepare( 'SHOW FULL TABLES LIKE %s', $wpdb->esc_like( $wpdb->prefix ) . '%' ), ARRAY_N );
			$s['tables'] = array_values( array_map( function ( $r ) {
				return $r[0];
			}, array_filter( $rows, function ( $r ) {
				return 'BASE TABLE' === strtoupper( $r[1] );
			} ) ) );
			$s['table_i'] = 0;
			if ( ! $s['tables'] ) {
				throw new Exception( 'No tables found with the prefix ' . $wpdb->prefix );
			}
			return $s;
		}
		while ( $s['table_i'] < count( $s['tables'] ) && microtime( true ) < $deadline ) {
			$t   = $s['tables'][ $s['table_i'] ];
			$new = $s['prefix'] . substr( $t, strlen( $wpdb->prefix ) );
			$wpdb->query( "DROP TABLE IF EXISTS `$new`" );
			if ( false === $wpdb->query( "CREATE TABLE `$new` LIKE `$t`" ) ) {
				throw new Exception( "Couldn't create $new: " . $wpdb->last_error );
			}
			if ( false === $wpdb->query( "INSERT INTO `$new` SELECT * FROM `$t`" ) ) {
				throw new Exception( "Couldn't copy $t: " . $wpdb->last_error );
			}
			++$s['table_i'];
		}
		if ( $s['table_i'] >= count( $s['tables'] ) ) {
			$s['phase'] = 'config';
		}
		return $s;
	}

	if ( 'config' === $s['phase'] ) {
		$cfg = file_exists( ABSPATH . 'wp-config.php' ) ? ABSPATH . 'wp-config.php' : dirname( ABSPATH ) . '/wp-config.php';
		$src = file_get_contents( $cfg );
		if ( ! $src ) {
			throw new Exception( 'Could not read wp-config.php' );
		}
		$src = preg_replace( '/\$table_prefix\s*=\s*[\'"][^\'"]*[\'"]\s*;/', '$table_prefix = \'' . $s['prefix'] . '\';', $src, 1, $count );
		if ( ! $count ) {
			throw new Exception( 'Could not find $table_prefix in wp-config.php' );
		}
		// Path constants are dropped too: a hard-coded WP_CONTENT_DIR would point staging at the LIVE plugins.
		$names = 'WP_HOME|WP_SITEURL|WP_CACHE|DISABLE_WP_CRON|WP_ENVIRONMENT_TYPE|WP_CACHE_KEY_SALT|COOKIE_DOMAIN|WP_REDIS_DISABLED|LITESPEED_DISABLE_ALL|STUDIO_STAGING|STUDIO_STAGING_TOKEN|STUDIO_LIVE_URL|WP_CONTENT_DIR|WP_CONTENT_URL|WP_PLUGIN_DIR|WP_PLUGIN_URL|PLUGINDIR|WPMU_PLUGIN_DIR|WPMU_PLUGIN_URL|UPLOADS|WP_LANG_DIR|WP_TEMP_DIR';
		$src   = preg_replace( '/^(\s*)(define\s*\(\s*[\'"](?:' . $names . ')[\'"])/mi', '$1// Studio staging: $2', $src );
		$head  = "<?php\n/* Studio staging copy of " . home_url() . ' (' . gmdate( 'Y-m-d H:i' ) . " UTC). Private, not indexed, mail and outgoing POST requests blocked. */\n"
			. "define( 'STUDIO_STAGING', true );\n"
			. "define( 'STUDIO_STAGING_TOKEN', '" . $s['token'] . "' );\n"
			. "define( 'STUDIO_LIVE_URL', " . var_export( untrailingslashit( home_url() ), true ) . " );\n"
			. "define( 'WP_HOME', " . var_export( $s['url'], true ) . " );\n"
			. "define( 'WP_SITEURL', " . var_export( $s['url'], true ) . " );\n"
			. "define( 'WP_CACHE', false );\n"
			. "define( 'DISABLE_WP_CRON', true );\n"
			. "define( 'WP_ENVIRONMENT_TYPE', 'staging' );\n"
			. "define( 'WP_CACHE_KEY_SALT', 'studio-staging-" . $s['prefix'] . "' );\n"
			. "define( 'WP_REDIS_DISABLED', true );\n"
			. "define( 'LITESPEED_DISABLE_ALL', true );\n";
		$src = preg_replace( '/^\s*<\?php\s*/', $head, $src, 1 );
		file_put_contents( $root . '/wp-config.php', $src );

		// Guard plugin: private, noindex, mail captured, outgoing POSTs blocked.
		wp_mkdir_p( $root . '/wp-content/mu-plugins' );
		copy( __DIR__ . '/staging/guard.php', $root . '/wp-content/mu-plugins/studio-staging.php' );

		$path = wp_parse_url( $s['url'], PHP_URL_PATH );
		$live = untrailingslashit( (string) wp_parse_url( site_url(), PHP_URL_PATH ) );
		$ht   = "# Studio staging\n<IfModule mod_headers.c>\nHeader set X-Robots-Tag \"noindex, nofollow\"\n</IfModule>\n"
			. "<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteBase {$path}/\n"
			. ( $s['skip_media'] ? "RewriteCond %{REQUEST_FILENAME} !-f\nRewriteRule ^wp-content/uploads/(.*)$ {$live}/wp-content/uploads/\$1 [L,R=302]\n" : '' )
			. "RewriteRule ^index\\.php$ - [L]\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule . {$path}/index.php [L]\n</IfModule>\n"
			. '';
		file_put_contents( $root . '/.htaccess', $ht );
		$s['phase'] = 'db';
		return $s;
	}

	if ( 'db' === $s['phase'] ) {
		$p  = $s['prefix'];
		$lp = $wpdb->prefix;
		$wpdb->query( $wpdb->prepare( "UPDATE `{$p}options` SET option_value = %s WHERE option_name IN ('siteurl','home')", $s['url'] ) );
		$wpdb->query( $wpdb->prepare( "UPDATE `{$p}options` SET option_name = %s WHERE option_name = %s", $p . 'user_roles', $lp . 'user_roles' ) );
		$wpdb->query( $wpdb->prepare( "UPDATE `{$p}usermeta` SET meta_key = CONCAT(%s, SUBSTRING(meta_key, %d)) WHERE meta_key LIKE %s", $p, strlen( $lp ) + 1, $wpdb->esc_like( $lp ) . '%' ) );
		$wpdb->query( "UPDATE `{$p}options` SET option_value = '0' WHERE option_name = 'blog_public'" );
		$wpdb->query( "DELETE FROM `{$p}options` WHERE option_name IN ('studio_staging','studio_backup_started','cron','doing_cron','studio_staging_mail','studio_staging_blocked')" );
		@unlink( studio_stg_list_file( $s ) );
		$s['phase']    = 'ready';
		$s['ready_at'] = time();
		return $s;
	}

	return $s;
}

function studio_stg_delete( $s ) {
	global $wpdb;
	if ( ! $s ) {
		return;
	}
	if ( ! empty( $s['dir'] ) && preg_match( '/^studio-staging-[a-z0-9]{6}$/', $s['dir'] ) ) {
		studio_care_rrmdir( studio_stg_root( $s ) );
	}
	if ( ! empty( $s['prefix'] ) && preg_match( '/^zs[a-z0-9]{4}_$/', $s['prefix'] ) && 0 !== strpos( $s['prefix'], $wpdb->prefix ) ) {
		$tables = $wpdb->get_col( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $s['prefix'] ) . '%' ) );
		foreach ( $tables as $t ) {
			$wpdb->query( "DROP TABLE IF EXISTS `$t`" );
		}
	}
}
