import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../db.ts";
// @ts-expect-error archiver v8 ships without type declarations
import { ZipArchive } from "archiver";
import type { WpCustomWidget } from "../../shared/types.ts";

/**
 * The "Studio Connector" plugin installed once per client site:
 *  - REST endpoints (Application Password auth) to upsert Elementor pages and templates
 *  - a secret preview token so the dashboard can screenshot draft pages
 *  - any custom widgets generated when Elementor Pro isn't in scope
 */
function mainPhp(version: number, previewToken: string, widgets: WpCustomWidget[]) {
  const widgetFiles = widgets.map((w) => `'${w.name}'`).join(", ");
  return `<?php
/**
 * Plugin Name: Studio Connector
 * Description: Connects this site to Mockup Studio: Elementor pages, SEO fixes, and monthly maintenance (updates tested on a private staging copy first).
 * Version: 1.0.${version}
 * Requires PHP: 7.4
 * Author: Mockup Studio
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'STUDIO_CONNECTOR_VERSION', '1.0.${version}' );
define( 'STUDIO_PREVIEW_TOKEN', '${previewToken}' );

// Monthly maintenance: updates, staging clone, backups, health (care.php).
require_once __DIR__ . '/care.php';
// WooCommerce store setup and product import (woo.php).
require_once __DIR__ . '/woo.php';

/* ---------- REST API ---------- */

add_action( 'rest_api_init', function () {
	$can = function () {
		return current_user_can( 'edit_pages' );
	};

	register_rest_route( 'studio/v1', '/ping', array(
		'methods'             => 'GET',
		'permission_callback' => $can,
		'callback'            => function () {
			return array(
				'plugin'    => STUDIO_CONNECTOR_VERSION,
				'elementor' => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : '',
				'pro'       => defined( 'ELEMENTOR_PRO_VERSION' ),
				'widgets'   => array( ${widgetFiles} ),
				'seo'       => true,
				'seo_plugin' => studio_seo_plugin(),
				'care'      => STUDIO_CARE_VERSION,
				'woo'       => STUDIO_WOO_VERSION,
				'woocommerce' => class_exists( 'WooCommerce' ) ? WC()->version : '',
			);
		},
	) );

	register_rest_route( 'studio/v1', '/page', array(
		'methods'             => 'POST',
		'permission_callback' => $can,
		'callback'            => 'studio_connector_upsert',
	) );
} );

/**
 * Create or update a draft page (or an Elementor library template) from Elementor data.
 * Body: { page_id?, title, slug, elementor_data (array), template, kind: page|header|footer }
 */
function studio_connector_upsert( WP_REST_Request $req ) {
	$kind  = sanitize_key( $req->get_param( 'kind' ) ?: 'page' );
	$id    = absint( $req->get_param( 'page_id' ) );
	$data  = $req->get_param( 'elementor_data' );
	if ( ! is_array( $data ) ) {
		return new WP_Error( 'studio_bad_data', 'elementor_data must be an array', array( 'status' => 400 ) );
	}
	$type = 'page' === $kind ? 'page' : 'elementor_library';
	$slug = sanitize_title( $req->get_param( 'slug' ) );
	$post = array(
		'post_title' => sanitize_text_field( $req->get_param( 'title' ) ),
		'post_name'  => $slug,
		'post_type'  => $type,
	);
	// Header/footer templates are updated in place, found by slug.
	if ( ! $id && 'page' !== $kind && $slug ) {
		$existing = get_page_by_path( $slug, OBJECT, $type );
		$id       = $existing ? $existing->ID : 0;
	}
	if ( $id && get_post( $id ) ) {
		// Keep the current status so a published page never goes back to draft.
		$post['ID'] = $id;
		$id         = wp_update_post( $post, true );
	} else {
		$post['post_status'] = 'page' === $kind ? 'draft' : 'publish';
		$id                  = wp_insert_post( $post, true );
	}
	if ( is_wp_error( $id ) ) {
		return $id;
	}

	update_post_meta( $id, '_elementor_edit_mode', 'builder' );
	update_post_meta( $id, '_elementor_template_type', 'page' === $kind ? 'wp-page' : $kind );
	update_post_meta( $id, '_elementor_version', defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : '' );
	update_post_meta( $id, '_elementor_data', wp_slash( wp_json_encode( $data ) ) );
	if ( 'page' === $kind ) {
		update_post_meta( $id, '_wp_page_template', sanitize_text_field( $req->get_param( 'template' ) ?: 'elementor_canvas' ) );
	} else {
		// Pro theme-builder header/footer: show on the whole site.
		update_post_meta( $id, '_elementor_conditions', array( 'include/general' ) );
		wp_set_object_terms( $id, $kind, 'elementor_library_type' );
	}

	if ( class_exists( 'Elementor\\Plugin' ) ) {
		\\Elementor\\Plugin::$instance->files_manager->clear_cache();
	}

	return array(
		'id'      => $id,
		'link'    => get_permalink( $id ),
		'preview' => add_query_arg( array( 'page_id' => $id, 'studio_preview' => STUDIO_PREVIEW_TOKEN ), home_url( '/' ) ),
		'edit'    => admin_url( 'post.php?post=' . $id . '&action=elementor' ),
	);
}

/* ---------- Private draft previews for screenshots ---------- */

add_filter( 'posts_results', function ( $posts, $query ) {
	if ( empty( $_GET['studio_preview'] ) || ! hash_equals( STUDIO_PREVIEW_TOKEN, sanitize_text_field( wp_unslash( $_GET['studio_preview'] ) ) ) ) {
		return $posts;
	}
	if ( $query->is_main_query() && 1 === count( $posts ) && in_array( $posts[0]->post_status, array( 'draft', 'pending', 'auto-draft' ), true ) ) {
		$posts[0]->post_status = 'publish';
		add_action( 'wp_head', function () {
			echo '<meta name="robots" content="noindex, nofollow">' . "\\n";
		} );
	}
	return $posts;
}, 10, 2 );

/* ---------- Custom widgets (used when Elementor Pro isn't in scope) ---------- */

add_action( 'elementor/widgets/register', function ( $widgets_manager ) {
	foreach ( glob( __DIR__ . '/widgets/*.php' ) ?: array() as $file ) {
		require_once $file;
	}
	foreach ( get_declared_classes() as $class ) {
		if ( 0 === strpos( $class, 'Studio_Widget_' ) && is_subclass_of( $class, 'Elementor\\Widget_Base' ) ) {
			$widgets_manager->register( new $class() );
		}
	}
} );

add_action( 'elementor/elements/categories_registered', function ( $elements_manager ) {
	$elements_manager->add_category( 'studio', array( 'title' => 'Studio', 'icon' => 'fa fa-plug' ) );
} );

/* ---------- On-page SEO ---------- */

function studio_seo_plugin() {
	if ( defined( 'WPSEO_VERSION' ) ) {
		return 'yoast';
	}
	if ( class_exists( 'RankMath' ) ) {
		return 'rankmath';
	}
	return '';
}

/** Find an attachment by any of its URLs, including resized "-300x200" variants. */
function studio_attachment_from_url( $url ) {
	$id = attachment_url_to_postid( $url );
	if ( ! $id ) {
		$id = attachment_url_to_postid( preg_replace( '/-\\d+x\\d+(?=\\.[a-z0-9]+$)/i', '', $url ) );
	}
	return $id;
}

/** Every URL WordPress serves for an attachment (full size + all generated sizes). */
function studio_attachment_urls( $id ) {
	$urls = array( wp_get_attachment_url( $id ) );
	$meta = wp_get_attachment_metadata( $id );
	if ( ! empty( $meta['sizes'] ) ) {
		$base = trailingslashit( dirname( wp_get_attachment_url( $id ) ) );
		foreach ( $meta['sizes'] as $size ) {
			$urls[] = $base . $size['file'];
		}
	}
	return array_values( array_unique( array_filter( $urls ) ) );
}

add_action( 'rest_api_init', function () {
	$can = function () {
		return current_user_can( 'edit_pages' );
	};

	register_rest_route( 'studio/v1', '/seo/resolve', array(
		'methods'             => 'GET',
		'permission_callback' => $can,
		'callback'            => function ( WP_REST_Request $req ) {
			$url = esc_url_raw( $req->get_param( 'url' ) );
			$post_id = url_to_postid( $url );
			if ( ! $post_id && untrailingslashit( $url ) === untrailingslashit( home_url() ) ) {
				$post_id = (int) get_option( 'page_on_front' );
			}
			return array(
				'post_id'       => $post_id,
				'attachment_id' => studio_attachment_from_url( $url ),
				'seo_plugin'    => studio_seo_plugin(),
			);
		},
	) );

	register_rest_route( 'studio/v1', '/seo/meta', array(
		'methods'             => 'POST',
		'permission_callback' => $can,
		'callback'            => function ( WP_REST_Request $req ) {
			$id    = absint( $req->get_param( 'post_id' ) );
			$title = sanitize_text_field( $req->get_param( 'title' ) );
			$desc  = sanitize_text_field( $req->get_param( 'description' ) );
			if ( ! $id || ! get_post( $id ) ) {
				return new WP_Error( 'studio_no_post', 'Page not found', array( 'status' => 404 ) );
			}
			update_post_meta( $id, '_studio_seo_title', $title );
			update_post_meta( $id, '_studio_seo_desc', $desc );
			$plugin = studio_seo_plugin();
			if ( 'yoast' === $plugin ) {
				update_post_meta( $id, '_yoast_wpseo_title', $title );
				update_post_meta( $id, '_yoast_wpseo_metadesc', $desc );
			} elseif ( 'rankmath' === $plugin ) {
				update_post_meta( $id, 'rank_math_title', $title );
				update_post_meta( $id, 'rank_math_description', $desc );
			}
			return array( 'ok' => true, 'written_to' => $plugin ?: 'studio' );
		},
	) );

	register_rest_route( 'studio/v1', '/seo/schema', array(
		'methods'             => 'POST',
		'permission_callback' => $can,
		'callback'            => function ( WP_REST_Request $req ) {
			$id     = absint( $req->get_param( 'post_id' ) );
			$jsonld = $req->get_param( 'jsonld' );
			if ( ! is_array( $jsonld ) ) {
				return new WP_Error( 'studio_bad_schema', 'jsonld must be an object', array( 'status' => 400 ) );
			}
			if ( $id ) {
				update_post_meta( $id, '_studio_schema', wp_slash( wp_json_encode( $jsonld ) ) );
			} else {
				update_option( 'studio_schema_site', wp_json_encode( $jsonld ), false );
			}
			return array( 'ok' => true );
		},
	) );

	register_rest_route( 'studio/v1', '/seo/alt', array(
		'methods'             => 'POST',
		'permission_callback' => $can,
		'callback'            => function ( WP_REST_Request $req ) {
			$id = absint( $req->get_param( 'attachment_id' ) );
			if ( ! $id || 'attachment' !== get_post_type( $id ) ) {
				return new WP_Error( 'studio_no_media', 'Image not found in the media library', array( 'status' => 404 ) );
			}
			update_post_meta( $id, '_wp_attachment_image_alt', sanitize_text_field( $req->get_param( 'alt' ) ) );
			return array( 'ok' => true );
		},
	) );

	register_rest_route( 'studio/v1', '/seo/webp', array(
		'methods'             => 'POST',
		'permission_callback' => $can,
		'callback'            => 'studio_convert_webp',
	) );
} );

/**
 * Convert an attachment to WebP in place (same attachment ID), then point every
 * reference in Elementor data and post content at the new file. The original stays on disk.
 */
function studio_convert_webp( WP_REST_Request $req ) {
	global $wpdb;
	$id      = absint( $req->get_param( 'attachment_id' ) );
	$quality = min( 95, max( 40, absint( $req->get_param( 'quality' ) ?: 80 ) ) );
	$file    = $id ? get_attached_file( $id ) : '';
	if ( ! $file || ! file_exists( $file ) ) {
		return new WP_Error( 'studio_no_media', 'Image file not found', array( 'status' => 404 ) );
	}
	if ( 'image/webp' === get_post_mime_type( $id ) ) {
		return array( 'ok' => true, 'skipped' => 'already webp', 'before' => filesize( $file ), 'after' => filesize( $file ) );
	}
	if ( ! wp_image_editor_supports( array( 'mime_type' => 'image/webp' ) ) ) {
		return new WP_Error( 'studio_no_webp', 'This server cannot write WebP (needs GD or Imagick with WebP)', array( 'status' => 500 ) );
	}
	$editor = wp_get_image_editor( $file );
	if ( is_wp_error( $editor ) ) {
		return $editor;
	}
	$size = $editor->get_size();
	if ( $size['width'] > 2560 ) {
		$editor->resize( 2560, null );
	}
	$editor->set_quality( $quality );
	$new   = preg_replace( '/\\.[a-z0-9]+$/i', '.webp', $file );
	$saved = $editor->save( $new, 'image/webp' );
	if ( is_wp_error( $saved ) ) {
		return $saved;
	}
	$before   = filesize( $file );
	$after    = filesize( $saved['path'] );
	$old_urls = studio_attachment_urls( $id );

	require_once ABSPATH . 'wp-admin/includes/image.php';
	update_attached_file( $id, $saved['path'] );
	wp_update_post( array( 'ID' => $id, 'post_mime_type' => 'image/webp' ) );
	wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $saved['path'] ) );
	$new_full = wp_get_attachment_url( $id );

	// Old URL (any size) → new full-size URL. Elementor stores URLs JSON-escaped.
	foreach ( $old_urls as $old ) {
		foreach ( array( array( $old, $new_full ), array( str_replace( '/', '\\\\/', $old ), str_replace( '/', '\\\\/', $new_full ) ) ) as $pair ) {
			$wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->postmeta} SET meta_value = REPLACE(meta_value, %s, %s) WHERE meta_key = '_elementor_data' AND meta_value LIKE %s", $pair[0], $pair[1], '%' . $wpdb->esc_like( $pair[0] ) . '%' ) );
			$wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->posts} SET post_content = REPLACE(post_content, %s, %s) WHERE post_content LIKE %s", $pair[0], $pair[1], '%' . $wpdb->esc_like( $pair[0] ) . '%' ) );
		}
	}
	if ( class_exists( 'Elementor\\Plugin' ) ) {
		\\Elementor\\Plugin::$instance->files_manager->clear_cache();
	}
	return array( 'ok' => true, 'before' => $before, 'after' => $after, 'url' => $new_full );
}

/* Output: only when no SEO plugin owns the <head>. */
add_filter( 'pre_get_document_title', function ( $title ) {
	if ( studio_seo_plugin() || ! is_singular() ) {
		return $title;
	}
	$custom = get_post_meta( get_queried_object_id(), '_studio_seo_title', true );
	return $custom ? $custom : $title;
}, 20 );

add_action( 'wp_head', function () {
	if ( is_singular() && ! studio_seo_plugin() ) {
		$desc = get_post_meta( get_queried_object_id(), '_studio_seo_desc', true );
		if ( $desc ) {
			echo '<meta name="description" content="' . esc_attr( $desc ) . '">' . "\\n";
		}
	}
	$blocks = array();
	$site   = get_option( 'studio_schema_site' );
	if ( $site ) {
		$blocks[] = $site;
	}
	if ( is_singular() ) {
		$page = get_post_meta( get_queried_object_id(), '_studio_schema', true );
		if ( $page ) {
			$blocks[] = $page;
		}
	}
	foreach ( $blocks as $json ) {
		// Re-encode so nothing in stored data can break out of the script tag.
		$data = json_decode( $json, true );
		if ( $data ) {
			echo '<script type="application/ld+json">' . wp_json_encode( $data, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG ) . '</script>' . "\\n";
		}
	}
}, 2 );
`;
}

const PHP_DIR = join(ROOT, "server", "wp", "php");

/** Generated widget PHP must declare a Studio_Widget_* class; wrap it with an ABSPATH guard. */
function widgetPhp(w: WpCustomWidget, php: string) {
  const body = php.replace(/^<\?php\s*/, "");
  return `<?php
/**
 * ${w.title}: replaces the Elementor Pro "${w.replaces}" widget.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
${body}
`;
}

export async function buildPluginZip(out: string, opts: { version: number; previewToken: string; widgets: (WpCustomWidget & { php: string })[] }) {
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(out);
    const zip = new ZipArchive({ zlib: { level: 9 } });
    file.on("close", () => resolve());
    zip.on("error", reject);
    zip.pipe(file);
    zip.append(mainPhp(opts.version, opts.previewToken, opts.widgets), { name: "studio-connector/studio-connector.php" });
    zip.append(readFileSync(join(PHP_DIR, "care.php")), { name: "studio-connector/care.php" });
    zip.append(readFileSync(join(PHP_DIR, "woo.php")), { name: "studio-connector/woo.php" });
    zip.append(readFileSync(join(PHP_DIR, "staging-mu.php")), { name: "studio-connector/staging/guard.php" });
    for (const w of opts.widgets) zip.append(widgetPhp(w, w.php), { name: `studio-connector/widgets/${w.name}.php` });
    zip.append(`Studio Connector ${opts.version}\n\nUpload this zip under Plugins → Add New → Upload Plugin, then activate it.\nCreate an Application Password under Users → Profile and paste it into the dashboard.\n`, { name: "studio-connector/readme.txt" });
    void zip.finalize();
  });
}

/** For scripts/lint-php.mjs: the main plugin file with placeholder values. */
export const renderMainPhp = () => mainPhp(1, "0123456789abcdef", []);
