<?php
/**
 * Plugin Name: Studio staging guard
 * Description: Keeps this staging copy private and harmless: login or the dashboard's token is required,
 *              search engines are told to stay away, email is captured instead of sent, and outgoing
 *              POST requests (CRMs, payment gateways, webhooks) are blocked.
 */

if ( ! defined( 'ABSPATH' ) || ! defined( 'STUDIO_STAGING' ) || ! defined( 'STUDIO_STAGING_TOKEN' ) ) {
	return;
}

function studio_stg_has_token() {
	return isset( $_COOKIE['studio_stg'] ) && hash_equals( STUDIO_STAGING_TOKEN, (string) $_COOKIE['studio_stg'] );
}

function studio_stg_allowed() {
	return studio_stg_has_token() || is_user_logged_in();
}

add_action( 'init', function () {
	if ( isset( $_GET['studio_stg'] ) && hash_equals( STUDIO_STAGING_TOKEN, (string) $_GET['studio_stg'] ) ) {
		setcookie( 'studio_stg', STUDIO_STAGING_TOKEN, 0, '/', '', is_ssl(), true );
		$_COOKIE['studio_stg'] = STUDIO_STAGING_TOKEN;
	}
	$uri     = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
	$is_rest = false !== strpos( $uri, '/wp-json/' ) || isset( $_GET['rest_route'] );
	$is_login = isset( $GLOBALS['pagenow'] ) && 'wp-login.php' === $GLOBALS['pagenow'];
	if ( $is_rest || $is_login || studio_stg_allowed() ) {
		return; // REST requests are checked below, once application passwords have been verified.
	}
	status_header( 403 );
	nocache_headers();
	header( 'X-Robots-Tag: noindex, nofollow' );
	echo '<!doctype html><title>Private</title><p style="font:16px system-ui;margin:40px">This is a private staging copy.</p>';
	exit;
}, 0 );

add_filter( 'rest_authentication_errors', function ( $result ) {
	if ( ! empty( $result ) || studio_stg_allowed() ) {
		return $result;
	}
	return new WP_Error( 'studio_staging_private', 'This is a private staging copy.', array( 'status' => 401 ) );
}, 99 );

add_action( 'send_headers', function () {
	header( 'X-Robots-Tag: noindex, nofollow' );
	header( 'X-LiteSpeed-Cache-Control: no-cache' );
	header( 'Cache-Control: no-store, private' );
} );
add_filter( 'pre_option_blog_public', function () {
	return '0';
} );

// Email is recorded, never sent: form tests can prove a notification was generated without reaching anyone.
add_filter( 'pre_wp_mail', function ( $null, $atts ) {
	$log   = (array) get_option( 'studio_staging_mail', array() );
	$log[] = array(
		'at'      => time(),
		'to'      => is_array( $atts['to'] ) ? implode( ', ', $atts['to'] ) : (string) $atts['to'],
		'subject' => wp_strip_all_tags( (string) $atts['subject'] ),
		'body'    => wp_html_excerpt( wp_strip_all_tags( (string) $atts['message'] ), 400 ),
	);
	update_option( 'studio_staging_mail', array_slice( $log, -50 ), false );
	return true;
}, 1, 2 );

// Outgoing POST/PUT/DELETE requests are blocked except to wordpress.org, to this staging copy, and while updating.
add_filter( 'pre_http_request', function ( $pre, $args, $url ) {
	if ( false !== $pre || defined( 'STUDIO_UPDATING' ) ) {
		return $pre;
	}
	$method = strtoupper( isset( $args['method'] ) ? (string) $args['method'] : 'GET' );
	if ( 'GET' === $method || 'HEAD' === $method ) {
		return $pre;
	}
	$host = (string) wp_parse_url( $url, PHP_URL_HOST );
	if ( preg_match( '/(^|\.)wordpress\.org$/i', $host ) || 0 === strpos( $url, home_url() ) ) {
		return $pre;
	}
	$log   = (array) get_option( 'studio_staging_blocked', array() );
	$log[] = array( 'at' => time(), 'method' => $method, 'host' => $host );
	update_option( 'studio_staging_blocked', array_slice( $log, -50 ), false );
	return new WP_Error( 'studio_staging_blocked', 'Outgoing ' . $method . ' requests are blocked on the staging copy.' );
}, 1, 3 );

// Staging never updates itself; the dashboard does it.
add_filter( 'automatic_updater_disabled', '__return_true' );
