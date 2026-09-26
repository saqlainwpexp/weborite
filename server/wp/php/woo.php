<?php
/**
 * Studio Woo: turns the client site into a WooCommerce store for Mockup Studio.
 *
 * - status:   WooCommerce version, store pages, product count, enabled gateways, studio shipping zones
 * - setup:    install + activate WooCommerce (and the chosen gateway plugins) from wordpress.org, store
 *             address/currency, the shop/cart/checkout/account pages, payment methods, flat-rate zones
 * - products: create or update products (simple, variable + variations) by SKU, with categories and images
 *
 * Everything is native WooCommerce: real products, real pages, real gateways. Re-running any step updates
 * what the studio created before instead of adding duplicates.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'STUDIO_WOO_VERSION', 1 );

function studio_woo_can() {
	return current_user_can( 'install_plugins' ) && current_user_can( 'manage_options' );
}

add_action( 'rest_api_init', function () {
	$routes = array(
		array( '/woo/status', 'GET', 'studio_woo_status' ),
		array( '/woo/setup', 'POST', 'studio_woo_setup' ),
		array( '/woo/products', 'POST', 'studio_woo_products' ),
	);
	foreach ( $routes as $r ) {
		register_rest_route( 'studio/v1', $r[0], array(
			'methods'             => $r[1],
			'permission_callback' => 'studio_woo_can',
			'callback'            => $r[2],
		) );
	}
} );

/** Gateway plugins on wordpress.org, keyed the way the dashboard names them. */
function studio_woo_gateway_plugins() {
	return array(
		'stripe' => array( 'slug' => 'woocommerce-gateway-stripe', 'file' => 'woocommerce-gateway-stripe/woocommerce-gateway-stripe.php', 'name' => 'Stripe' ),
		'paypal' => array( 'slug' => 'woocommerce-paypal-payments', 'file' => 'woocommerce-paypal-payments/woocommerce-paypal-payments.php', 'name' => 'PayPal Payments' ),
		'mollie' => array( 'slug' => 'mollie-payments-for-woocommerce', 'file' => 'mollie-payments-for-woocommerce/mollie-payments-for-woocommerce.php', 'name' => 'Mollie' ),
	);
}

/** Install (if missing) and activate a wordpress.org plugin. Returns 'installed' | 'activated' | 'active' or WP_Error. */
function studio_woo_ensure_plugin( $slug, $file ) {
	require_once ABSPATH . 'wp-admin/includes/admin.php';
	require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
	require_once ABSPATH . 'wp-admin/includes/plugin-install.php';
	$state = 'active';
	if ( ! isset( get_plugins()[ $file ] ) ) {
		$api = plugins_api( 'plugin_information', array( 'slug' => $slug, 'fields' => array( 'sections' => false ) ) );
		if ( is_wp_error( $api ) ) {
			return new WP_Error( 'studio_woo_lookup', "Could not reach wordpress.org for $slug: " . $api->get_error_message() );
		}
		$upgrader = new Plugin_Upgrader( new WP_Ajax_Upgrader_Skin() );
		$result   = $upgrader->install( $api->download_link );
		if ( is_wp_error( $result ) || ! $result ) {
			$msg = is_wp_error( $result ) ? $result->get_error_message() : implode( ' ', (array) $upgrader->skin->get_error_messages() );
			return new WP_Error( 'studio_woo_install', "$slug could not be installed: " . ( $msg ? $msg : 'the server refused to write the plugin files' ) );
		}
		wp_clean_plugins_cache();
		$state = 'installed';
	}
	if ( ! is_plugin_active( $file ) ) {
		$act = activate_plugin( $file );
		if ( is_wp_error( $act ) ) {
			return new WP_Error( 'studio_woo_activate', "$slug is installed but could not be activated: " . $act->get_error_message() );
		}
		if ( 'active' === $state ) {
			$state = 'activated';
		}
	}
	return $state;
}

/* ---------- status ---------- */

function studio_woo_status() {
	require_once ABSPATH . 'wp-admin/includes/plugin.php';
	$active = class_exists( 'WooCommerce' );
	$out    = array(
		'woo'       => $active ? WC()->version : '',
		'installed' => isset( get_plugins()['woocommerce/woocommerce.php'] ),
		'currency'  => $active ? get_woocommerce_currency() : '',
		'pages'     => array(),
		'products'  => 0,
		'gateways'  => array(),
		'zones'     => array(),
	);
	if ( ! $active ) {
		return $out;
	}
	foreach ( array( 'shop', 'cart', 'checkout', 'myaccount' ) as $p ) {
		$id                   = wc_get_page_id( $p );
		$out['pages'][ $p ]   = $id > 0 ? array( 'id' => $id, 'url' => get_permalink( $id ) ) : null;
	}
	$counts          = wp_count_posts( 'product' );
	$out['products'] = (int) $counts->publish + (int) $counts->draft + (int) $counts->private;
	foreach ( WC()->payment_gateways()->payment_gateways() as $id => $g ) {
		if ( 'yes' === $g->enabled ) {
			$out['gateways'][] = array( 'id' => $id, 'title' => wp_strip_all_tags( $g->get_title() ) );
		}
	}
	foreach ( (array) get_option( 'studio_woo_zones', array() ) as $zid ) {
		$z = new WC_Shipping_Zone( (int) $zid );
		if ( ! $z->get_id() ) {
			continue;
		}
		$out['zones'][] = array( 'id' => $z->get_id(), 'name' => $z->get_zone_name(), 'methods' => count( $z->get_shipping_methods() ) );
	}
	return $out;
}

/* ---------- setup ---------- */

/**
 * Body: {
 *   store: { country: "NL" | "US:CA", address, city, postcode, currency: "EUR", email? },
 *   payments: { stripe?: {publishable, secret, test}, paypal?: {}, mollie?: {key, test}, bacs?: {accounts: [...]}, cod?: {} },
 *   shipping: [ { name, countries: ["NL","BE"], rate: "4.95", free_over?: "50" } ]
 * }
 */
function studio_woo_setup( WP_REST_Request $req ) {
	@set_time_limit( 600 );
	$report = array( 'steps' => array(), 'notes' => array() );
	$step   = function ( $label, $ok, $detail = '' ) use ( &$report ) {
		$report['steps'][] = array( 'label' => $label, 'ok' => (bool) $ok, 'detail' => $detail );
	};

	$woo   = studio_woo_ensure_plugin( 'woocommerce', 'woocommerce/woocommerce.php' );
	if ( is_wp_error( $woo ) ) {
		return new WP_Error( $woo->get_error_code(), $woo->get_error_message(), array( 'status' => 500 ) );
	}
	$step( 'WooCommerce ' . ( 'installed' === $woo ? 'installed and activated' : ( 'activated' === $woo ? 'activated' : 'already active' ) ), true );
	if ( ! class_exists( 'WooCommerce' ) ) {
		// Activated in this request: its classes load on the next one.
		$report['retry'] = true;
		$report['notes'][] = 'WooCommerce was just activated. Setup continues on the next run.';
		return $report;
	}

	// Store basics. New installs skip the onboarding wizard; an existing live site isn't hidden behind "coming soon".
	$store = (array) $req->get_param( 'store' );
	$map   = array(
		'country'  => 'woocommerce_default_country',
		'address'  => 'woocommerce_store_address',
		'city'     => 'woocommerce_store_city',
		'postcode' => 'woocommerce_store_postcode',
		'currency' => 'woocommerce_currency',
	);
	foreach ( $map as $k => $opt ) {
		if ( ! empty( $store[ $k ] ) ) {
			update_option( $opt, sanitize_text_field( $store[ $k ] ) );
		}
	}
	if ( ! empty( $store['email'] ) && is_email( $store['email'] ) ) {
		update_option( 'woocommerce_email_from_address', sanitize_email( $store['email'] ) );
	}
	update_option( 'woocommerce_calc_taxes', 'no' );
	// First setup by the studio: skip WooCommerce's onboarding wizard, and don't let its "coming soon" mode
	// (switched on when WooCommerce is first activated) hide the client's existing site from visitors.
	if ( ! get_option( 'studio_woo_setup_done' ) ) {
		update_option( 'woocommerce_onboarding_profile', array( 'skipped' => true ) );
		update_option( 'woocommerce_coming_soon', 'no' );
		update_option( 'woocommerce_task_list_hidden', 'yes' );
		update_option( 'studio_woo_setup_done', time(), false );
	}
	$step( 'Store address and currency (' . get_woocommerce_currency() . ')', true );

	// Shop, cart, checkout and account pages (WooCommerce's own).
	if ( class_exists( 'WC_Install' ) ) {
		WC_Install::create_pages();
	}
	$missing = array_filter( array( 'shop', 'cart', 'checkout', 'myaccount' ), function ( $p ) {
		return wc_get_page_id( $p ) <= 0;
	} );
	$step( 'Shop, cart, checkout and account pages', ! $missing, $missing ? 'Missing: ' . implode( ', ', $missing ) : '' );

	// Payments.
	$pay     = (array) $req->get_param( 'payments' );
	$plugins = studio_woo_gateway_plugins();
	foreach ( $plugins as $key => $p ) {
		if ( ! isset( $pay[ $key ] ) ) {
			continue;
		}
		$r = studio_woo_ensure_plugin( $p['slug'], $p['file'] );
		if ( is_wp_error( $r ) ) {
			// Don't configure a gateway whose plugin isn't there.
			unset( $pay[ $key ] );
			$step( $p['name'] . ' not set up', false, html_entity_decode( wp_strip_all_tags( $r->get_error_message() ) ) . ' Install it under Plugins → Add New, then run the setup again.' );
		}
	}
	if ( isset( $pay['stripe'] ) ) {
		$s    = (array) $pay['stripe'];
		$test = ! empty( $s['test'] );
		$cur  = (array) get_option( 'woocommerce_stripe_settings', array() );
		$cur['enabled']  = 'yes';
		$cur['testmode'] = $test ? 'yes' : 'no';
		if ( ! empty( $s['publishable'] ) && ! empty( $s['secret'] ) ) {
			$cur[ $test ? 'test_publishable_key' : 'publishable_key' ] = sanitize_text_field( $s['publishable'] );
			$cur[ $test ? 'test_secret_key' : 'secret_key' ]           = sanitize_text_field( $s['secret'] );
		}
		update_option( 'woocommerce_stripe_settings', $cur );
		$keyed = ! empty( $s['publishable'] ) && ! empty( $s['secret'] );
		$step( 'Stripe enabled' . ( $test ? ' (test mode)' : '' ), true, $keyed ? '' : 'Add the API keys, or connect the account under WooCommerce → Settings → Payments → Stripe' );
	}
	if ( isset( $pay['mollie'] ) ) {
		$m    = (array) $pay['mollie'];
		$test = ! empty( $m['test'] );
		if ( ! empty( $m['key'] ) ) {
			update_option( $test ? 'mollie-payments-for-woocommerce_test_api_key' : 'mollie-payments-for-woocommerce_live_api_key', sanitize_text_field( $m['key'] ) );
		}
		update_option( 'mollie-payments-for-woocommerce_test_mode_enabled', $test ? 'yes' : 'no' );
		$step( 'Mollie' . ( $test ? ' (test mode)' : '' ), true, empty( $m['key'] ) ? 'Add the API key under WooCommerce → Settings → Payments → Mollie' : 'Mollie turns on the payment methods active in the Mollie account' );
	}
	if ( isset( $pay['paypal'] ) ) {
		$step( 'PayPal Payments installed', true, 'The store owner connects their PayPal account under WooCommerce → Settings → Payments → PayPal (PayPal requires this sign-in)' );
	}
	if ( isset( $pay['bacs'] ) ) {
		$b   = (array) $pay['bacs'];
		$cur = (array) get_option( 'woocommerce_bacs_settings', array() );
		$cur['enabled'] = 'yes';
		update_option( 'woocommerce_bacs_settings', $cur );
		$accounts = array();
		foreach ( (array) ( $b['accounts'] ?? array() ) as $a ) {
			$a          = (array) $a;
			$accounts[] = array(
				'account_name'   => sanitize_text_field( $a['account_name'] ?? '' ),
				'account_number' => sanitize_text_field( $a['account_number'] ?? '' ),
				'bank_name'      => sanitize_text_field( $a['bank_name'] ?? '' ),
				'sort_code'      => sanitize_text_field( $a['sort_code'] ?? '' ),
				'iban'           => sanitize_text_field( $a['iban'] ?? '' ),
				'bic'            => sanitize_text_field( $a['bic'] ?? '' ),
			);
		}
		if ( $accounts ) {
			update_option( 'woocommerce_bacs_accounts', $accounts );
		}
		$step( 'Bank transfer enabled', true, $accounts ? '' : 'Add the bank account under WooCommerce → Settings → Payments → Direct bank transfer' );
	}
	if ( isset( $pay['cod'] ) ) {
		$cur            = (array) get_option( 'woocommerce_cod_settings', array() );
		$cur['enabled'] = 'yes';
		update_option( 'woocommerce_cod_settings', $cur );
		$step( 'Cash on delivery enabled', true );
	}

	// Built-in methods the owner unticked are switched off (gateway plugins are left alone).
	foreach ( array( 'bacs' => 'Bank transfer', 'cod' => 'Cash on delivery' ) as $gid => $label ) {
		$cur = (array) get_option( "woocommerce_{$gid}_settings", array() );
		if ( ! isset( $pay[ $gid ] ) && 'yes' === ( $cur['enabled'] ?? '' ) ) {
			$cur['enabled'] = 'no';
			update_option( "woocommerce_{$gid}_settings", $cur );
			$step( "$label switched off", true );
		}
	}

	// Flat-rate shipping zones: replace the zones the studio created last time.
	$zones = $req->get_param( 'shipping' );
	if ( is_array( $zones ) ) {
		foreach ( (array) get_option( 'studio_woo_zones', array() ) as $zid ) {
			$old = new WC_Shipping_Zone( (int) $zid );
			if ( $old->get_id() ) {
				$old->delete();
			}
		}
		$ids = array();
		foreach ( $zones as $z ) {
			$z    = (array) $z;
			$zone = new WC_Shipping_Zone();
			$zone->set_zone_name( sanitize_text_field( $z['name'] ?? 'Shipping' ) );
			foreach ( (array) ( $z['countries'] ?? array() ) as $cc ) {
				$zone->add_location( strtoupper( sanitize_text_field( $cc ) ), 'country' );
			}
			$zone->save();
			$flat = $zone->add_shipping_method( 'flat_rate' );
			update_option( "woocommerce_flat_rate_{$flat}_settings", array(
				'title'      => __( 'Flat rate', 'woocommerce' ),
				'tax_status' => 'none',
				'cost'       => wc_format_decimal( $z['rate'] ?? '0' ),
			) );
			if ( isset( $z['free_over'] ) && '' !== (string) $z['free_over'] ) {
				$free = $zone->add_shipping_method( 'free_shipping' );
				update_option( "woocommerce_free_shipping_{$free}_settings", array(
					'title'      => __( 'Free shipping', 'woocommerce' ),
					'requires'   => 'min_amount',
					'min_amount' => wc_format_decimal( $z['free_over'] ),
				) );
			}
			$ids[] = $zone->get_id();
		}
		update_option( 'studio_woo_zones', $ids, false );
		$step( count( $ids ) . ' shipping zone' . ( 1 === count( $ids ) ? '' : 's' ), count( $ids ) > 0 );
	}

	$report['status'] = studio_woo_status();
	return $report;
}

/* ---------- products ---------- */

/** "Clothing > T-shirts | Sale" → term ids, creating missing categories (and parents). */
function studio_woo_category_ids( $spec ) {
	$ids = array();
	foreach ( array_filter( array_map( 'trim', explode( '|', (string) $spec ) ) ) as $path ) {
		$parent = 0;
		foreach ( array_filter( array_map( 'trim', explode( '>', $path ) ) ) as $name ) {
			$term = term_exists( $name, 'product_cat', $parent );
			if ( ! $term ) {
				$term = wp_insert_term( $name, 'product_cat', array( 'parent' => $parent ) );
			}
			if ( is_wp_error( $term ) ) {
				break;
			}
			$parent = (int) ( is_array( $term ) ? $term['term_id'] : $term );
		}
		if ( $parent ) {
			$ids[] = $parent;
		}
	}
	return array_values( array_unique( $ids ) );
}

/** Image URL → attachment id, downloading each URL once per site. */
function studio_woo_image_id( $url ) {
	$url = esc_url_raw( trim( $url ) );
	if ( ! $url ) {
		return 0;
	}
	$seen = (array) get_option( 'studio_woo_media', array() );
	if ( ! empty( $seen[ $url ] ) && get_post( (int) $seen[ $url ] ) ) {
		return (int) $seen[ $url ];
	}
	require_once ABSPATH . 'wp-admin/includes/media.php';
	require_once ABSPATH . 'wp-admin/includes/file.php';
	require_once ABSPATH . 'wp-admin/includes/image.php';
	$id = media_sideload_image( $url, 0, null, 'id' );
	if ( is_wp_error( $id ) ) {
		return 0;
	}
	$seen[ $url ] = (int) $id;
	update_option( 'studio_woo_media', $seen, false );
	return (int) $id;
}

/**
 * Body: { products: [ { type: simple|variable|variation, sku, name, parent_sku?, regular_price, sale_price,
 *   categories, images: [url|attachment id], description, short_description, stock,
 *   attributes: [ { name, values: [..] } ] } ] }
 * Variables must come before their variations (the dashboard sends them in that order).
 */
function studio_woo_products( WP_REST_Request $req ) {
	if ( ! class_exists( 'WooCommerce' ) ) {
		return new WP_Error( 'studio_woo_missing', 'WooCommerce isn\'t active. Run the store setup first.', array( 'status' => 409 ) );
	}
	@set_time_limit( 600 );
	$out = array( 'saved' => array(), 'errors' => array() );
	foreach ( (array) $req->get_param( 'products' ) as $row ) {
		$row  = (array) $row;
		$type = in_array( $row['type'] ?? '', array( 'simple', 'variable', 'variation' ), true ) ? $row['type'] : 'simple';
		$sku  = wc_clean( $row['sku'] ?? '' );
		$name = wc_clean( $row['name'] ?? '' );
		try {
			$existing = $sku ? wc_get_product_id_by_sku( $sku ) : 0;
			if ( 'variation' === $type ) {
				$parent_id = wc_get_product_id_by_sku( wc_clean( $row['parent_sku'] ?? '' ) );
				if ( ! $parent_id ) {
					throw new Exception( 'parent product ' . ( $row['parent_sku'] ?? '?' ) . ' not found' );
				}
				$p = $existing ? wc_get_product( $existing ) : new WC_Product_Variation();
				$p->set_parent_id( $parent_id );
				$attrs = array();
				foreach ( (array) ( $row['attributes'] ?? array() ) as $a ) {
					$a                                 = (array) $a;
					$attrs[ sanitize_title( $a['name'] ) ] = (string) ( ( (array) $a['values'] )[0] ?? '' );
				}
				$p->set_attributes( $attrs );
			} else {
				$class = 'variable' === $type ? 'WC_Product_Variable' : 'WC_Product_Simple';
				$p     = $existing ? wc_get_product( $existing ) : new $class();
				if ( ! is_a( $p, $class ) ) {
					// Type changed since the last import: rebuild it as the right class, same id.
					$p = new $class( $existing );
				}
				$p->set_name( $name );
				$p->set_status( 'publish' );
				$p->set_description( wp_kses_post( $row['description'] ?? '' ) );
				$p->set_short_description( wp_kses_post( $row['short_description'] ?? '' ) );
				$p->set_category_ids( studio_woo_category_ids( $row['categories'] ?? '' ) );
				if ( 'variable' === $type ) {
					$attrs = array();
					foreach ( (array) ( $row['attributes'] ?? array() ) as $i => $a ) {
						$a    = (array) $a;
						$attr = new WC_Product_Attribute();
						$attr->set_name( wc_clean( $a['name'] ) );
						$attr->set_options( array_map( 'wc_clean', (array) $a['values'] ) );
						$attr->set_position( $i );
						$attr->set_visible( true );
						$attr->set_variation( true );
						$attrs[] = $attr;
					}
					$p->set_attributes( $attrs );
				}
			}
			if ( $sku && ! $existing ) {
				$p->set_sku( $sku );
			}
			if ( 'variable' !== $type ) {
				$p->set_regular_price( wc_format_decimal( $row['regular_price'] ?? '' ) );
				$p->set_sale_price( isset( $row['sale_price'] ) && '' !== $row['sale_price'] ? wc_format_decimal( $row['sale_price'] ) : '' );
				if ( isset( $row['stock'] ) && '' !== (string) $row['stock'] ) {
					$p->set_manage_stock( true );
					$p->set_stock_quantity( (int) $row['stock'] );
				} else {
					$p->set_manage_stock( false );
					$p->set_stock_status( 'instock' );
				}
			}
			$images = array_values( array_filter( array_map( function ( $img ) {
				return is_numeric( $img ) ? (int) $img : studio_woo_image_id( (string) $img );
			}, (array) ( $row['images'] ?? array() ) ) ) );
			if ( $images ) {
				$p->set_image_id( $images[0] );
				if ( 'variation' !== $type ) {
					$p->set_gallery_image_ids( array_slice( $images, 1 ) );
				}
			}
			$id = $p->save();
			if ( 'variation' === $type ) {
				WC_Product_Variable::sync( $p->get_parent_id() );
			}
			$out['saved'][] = array( 'sku' => $sku, 'id' => $id, 'type' => $type );
		} catch ( Exception $e ) {
			$out['errors'][] = array( 'sku' => $sku, 'name' => $name, 'error' => $e->getMessage() );
		}
	}
	return $out;
}
