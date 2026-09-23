/**
 * Condensed Elementor (classic containers + widgets) data reference, taken from the
 * control schemas of Elementor 4.3. Fed to Claude with every conversion request.
 */

export const FREE_WIDGETS = [
  "heading", "text-editor", "image", "button", "video", "icon", "spacer", "divider", "icon-box", "image-box", "icon-list",
  "accordion", "toggle", "tabs", "counter", "progress", "testimonial", "star-rating", "rating", "social-icons", "google_maps",
  "image-carousel", "alert", "menu-anchor", "text-path",
];

export const PRO_WIDGETS = [
  "form", "nav-menu", "posts", "portfolio", "slides", "price-table", "price-list", "flip-box", "call-to-action", "animated-headline",
  "testimonial-carousel", "media-carousel", "gallery", "countdown", "share-buttons", "blockquote", "table-of-contents", "hotspot",
  "lottie", "nested-tabs", "nested-accordion", "loop-grid", "loop-carousel", "reviews", "search", "off-canvas", "login",
];

/** Never allowed: they bypass native widgets. */
export const BANNED_WIDGETS = ["html", "shortcode", "wp-widget-custom_html", "wp-widget-text", "sidebar", "template"];

export const ELEMENTOR_REFERENCE = `ELEMENTOR DATA FORMAT (classic containers + widgets)

Every element: { "id": "<7 lowercase hex chars, unique>", "elType": "container" | "widget", "isInner": boolean, "settings": {…}, "elements": [ … ] }
Widgets also have "widgetType". Widgets always have "elements": [].
Top-level containers: isInner false. Nested containers: isInner true.

UNITS
- Slider values: {"unit":"px","size":48,"sizes":[]}  (unit px|em|rem|%|vw|vh)
- Box values (padding, margin, border_width, border_radius): {"unit":"px","top":"80","right":"24","bottom":"80","left":"24","isLinked":false}. Always give all four sides.
- Gap: flex_gap {"column":"24","row":"24","isLinked":true,"unit":"px"}
- Responsive: add the suffix _tablet or _mobile to any control, e.g. padding_mobile, typography_font_size_mobile, flex_direction_mobile, align_mobile. Desktop has no suffix.
- Colours: hex or rgba strings.
- Images: {"url":"…","id":<attachment id or "">,"size":""}
- Links: {"url":"…","is_external":"","nofollow":"","custom_attributes":""}
- Icons: {"value":"fas fa-phone","library":"fa-solid"}  (fa-solid | fa-regular | fa-brands). SVG icons: {"value":{"id":123,"url":"…"},"library":"svg"}

CONTAINER settings (elType "container")
content_width "boxed"|"full"; boxed_width (slider, px) for the inner max width; width (slider, %/px) when the container is a child
flex_direction row|column (+ _mobile); flex_justify_content flex-start|center|flex-end|space-between|space-around|space-evenly
flex_align_items flex-start|center|flex-end|stretch; flex_wrap nowrap|wrap; flex_gap (see above)
container_type "grid" with grid_columns_grid {"unit":"fr","size":4}, grid_rows_grid {"unit":"fr","size":1}, grid_gaps (like flex_gap), grid_columns_grid_mobile
min_height (slider); overflow hidden; html_tag div|header|footer|main|section|nav|aside|article
padding, margin (box); background_background "classic" then background_color; background_image + background_size cover + background_position center center
background_overlay_background "classic", background_overlay_color, background_overlay_opacity {"unit":"px","size":0.5}
border_border solid|dashed…, border_width (box), border_color, border_radius (box)
box_shadow_box_shadow_type "yes", box_shadow_box_shadow {"horizontal":0,"vertical":10,"blur":30,"spread":0,"color":"rgba(0,0,0,0.12)"}
position absolute (+ _offset_x/_offset_y sliders), z_index; _element_id (CSS id / anchor); hide_desktop/hide_tablet/hide_mobile "hidden-desktop"…
Child sizing inside a row: width {"unit":"%","size":50} with content_width "full"; or _flex_size "grow".

COMMON WIDGET ADVANCED settings (any widget)
_margin, _padding (box); _element_width "initial" + _element_custom_width (slider) for fixed widths; _flex_size grow|none
_background_background "classic" + _background_color; _border_border, _border_width, _border_color, _border_radius; _z_index

TYPOGRAPHY group (prefix differs per widget: typography_, title_typography_, description_typography_, …)
<prefix>typography "custom" (required to activate), <prefix>font_family "Inter", <prefix>font_size (slider), <prefix>font_weight "400"|"500"|"700"…,
<prefix>line_height (slider, em or px), <prefix>letter_spacing (slider, px or em), <prefix>text_transform uppercase|none, <prefix>font_style italic

WIDGETS (free)
heading: title, header_size h1…h6|div|p|span, align, title_color, typography_*
text-editor: editor (limited HTML: p, br, strong, em, b, i, a, ul, ol, li, span only), align, text_color, typography_*
image: image, image_size "full", align, width (slider %/px), height, object_fit cover, image_border_radius (box), link_to custom + link
button: text, link, align (left|center|right|justify), size xs…xl, button_text_color, background_color, hover_color, button_background_hover_color,
        border_border, border_width, border_color, border_radius, button_padding (box), typography_*, selected_icon, icon_align row|row-reverse
icon: selected_icon, view default|stacked|framed, primary_color, secondary_color, size (slider), align
icon-box: selected_icon, title_text, description_text, position top|left, title_size, primary_color, icon_size, title_color, description_color, title_typography_*, description_typography_*
image-box: image, title_text, description_text, title_size, position top|left
icon-list: icon_list [{"_id":"abc1234","text":"…","selected_icon":{…},"link":{…}}], view traditional|inline, icon_color, text_color, icon_size, space_between (slider), icon_typography_*
divider: style solid, weight (slider), color, width (slider %), gap (slider)
spacer: space (slider)
counter: starting_number, ending_number, prefix, suffix, title, number_color, title_color, typography_number_*, typography_title_*
testimonial: testimonial_content, testimonial_name, testimonial_job, testimonial_image
star-rating: rating_scale "5", rating {"unit":"px","size":4.8}, title
social-icons: social_icon_list [{"_id":"…","social_icon":{"value":"fab fa-facebook","library":"fa-brands"},"link":{…}}], shape rounded|square|circle, align
accordion / toggle: tabs [{"_id":"…","tab_title":"…","tab_content":"<p>…</p>"}], title_color, content_color
google_maps: address, zoom {"unit":"px","size":14}, height {"unit":"px","size":400}
video: video_type youtube|vimeo|hosted, youtube_url, hosted_url {"url":…}, autoplay "yes", mute "yes", loop "yes", controls "", show_image_overlay "yes", image_overlay
image-carousel: carousel [{"id":…,"url":…}], slides_to_show "3", navigation both|arrows|dots|none

PRO WIDGET SETTINGS (only when Pro is allowed)
nav-menu: menu (menu slug), layout horizontal, pointer underline|none, dropdown tablet|mobile, toggle burger, color_menu_item, color_menu_item_hover, menu_typography_*
form: form_name, form_fields [{"_id":"…","field_type":"text|email|tel|textarea","field_label":"…","placeholder":"…","required":"true","width":"100"}], button_text, email_to
price-table, call-to-action, slides, testimonial-carousel, flip-box, animated-headline, gallery: use their standard Elementor Pro control names.
`;
