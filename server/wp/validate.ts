import { randomBytes } from "node:crypto";
import { BANNED_WIDGETS, FREE_WIDGETS, PRO_WIDGETS } from "./reference.ts";

export interface ElementorElement {
  id: string;
  elType: "container" | "widget" | string;
  widgetType?: string;
  isInner?: boolean;
  settings: Record<string, unknown>;
  elements: ElementorElement[];
}

const TEXT_EDITOR_TAGS = new Set(["p", "br", "strong", "em", "b", "i", "a", "ul", "ol", "li", "span", "u", "sup", "sub"]);
const newId = () => randomBytes(4).toString("hex").slice(0, 7);

/**
 * Check a converted section against the rules and normalise what's safe to fix
 * (ids, isInner flags). Returns human-readable errors for anything that isn't.
 */
export function validateElements(
  input: unknown,
  opts: { pro: boolean; customWidgets: string[] },
): { elements: ElementorElement[]; errors: string[]; widgets: string[] } {
  const errors: string[] = [];
  const widgets = new Set<string>();
  const seen = new Set<string>();
  const allowed = new Set([...FREE_WIDGETS, ...(opts.pro ? PRO_WIDGETS : []), ...opts.customWidgets]);

  if (!Array.isArray(input) || !input.length) return { elements: [], errors: ["Expected a non-empty JSON array of containers"], widgets: [] };

  const walk = (el: ElementorElement, depth: number, path: string) => {
    if (!el || typeof el !== "object") {
      errors.push(`${path}: not an object`);
      return;
    }
    if (typeof el.id !== "string" || !/^[0-9a-f]{7,8}$/.test(el.id) || seen.has(el.id)) el.id = newId();
    seen.add(el.id);
    el.settings = el.settings && typeof el.settings === "object" && !Array.isArray(el.settings) ? el.settings : {};
    el.elements = Array.isArray(el.elements) ? el.elements : [];

    if (el.elType === "container") {
      el.isInner = depth > 0;
      delete el.widgetType;
      if (depth === 0 && el.settings.html_tag === "main") el.settings.html_tag = "section";
    } else if (el.elType === "widget") {
      const t = String(el.widgetType ?? "");
      widgets.add(t);
      if (BANNED_WIDGETS.includes(t)) errors.push(`${path}: the "${t}" widget is not allowed. Rebuild it with native widgets.`);
      else if (PRO_WIDGETS.includes(t) && !opts.pro) errors.push(`${path}: "${t}" is an Elementor Pro widget and Pro is not in scope. Use free widgets or a custom studio_ widget.`);
      else if (!allowed.has(t)) errors.push(`${path}: unknown widget "${t}".`);
      if (t === "text-editor") {
        const html = String(el.settings.editor ?? "");
        const bad = [...html.matchAll(/<\s*([a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase()).filter((tag) => !TEXT_EDITOR_TAGS.has(tag));
        if (bad.length) errors.push(`${path}: text-editor may only contain simple formatting, found <${[...new Set(bad)].join(">, <")}>. Use containers and widgets for layout.`);
        if (/style\s*=/.test(html)) errors.push(`${path}: text-editor must not carry inline style attributes. Use the widget's typography/color controls.`);
      }
      if (el.elements.length) {
        errors.push(`${path}: widgets cannot have child elements.`);
        el.elements = [];
      }
      el.isInner = false;
    } else {
      errors.push(`${path}: unknown elType "${el.elType}"`);
    }
    el.elements.forEach((c, i) => walk(c, depth + 1, `${path} > ${c?.elType === "widget" ? c.widgetType : "container"}[${i}]`));
  };

  const elements = input as ElementorElement[];
  elements.forEach((el, i) => {
    if (el?.elType !== "container") errors.push(`root[${i}]: every top-level element must be a container`);
    walk(el, 0, `section[${i}]`);
  });
  return { elements, errors, widgets: [...widgets].filter(Boolean) };
}

/** Basic safety scan for generated custom widget PHP before it goes into the plugin. */
export function checkWidgetPhp(name: string, php: string): string[] {
  const errors: string[] = [];
  if (!/^studio_[a-z0-9_]+$/.test(name)) errors.push(`widget name "${name}" must match studio_[a-z0-9_]+`);
  if (!/class\s+Studio_Widget_\w+/.test(php)) errors.push(`${name}: the class must be named Studio_Widget_<Name>`);
  if (!/extends\s+\\?Elementor\\Widget_Base/.test(php)) errors.push(`${name}: class must extend \\Elementor\\Widget_Base`);
  if (!new RegExp(`return\\s+['"]${name}['"]`).test(php)) errors.push(`${name}: get_name() must return '${name}'`);
  // This code runs on the client's live site, and what Claude writes is shaped by scraped pages, so
  // anything that can run commands, touch files, load code, reach the network or change users is out.
  const banned = [
    "eval", "assert", "exec", "shell_exec", "system", "passthru", "proc_open", "popen", "pcntl_\\w+", "posix_\\w+", "dl", "create_function",
    "call_user_func(?:_array)?", "forward_static_call(?:_array)?", "func_get_args", "extract", "parse_str", "unserialize", "putenv", "ini_set", "set_include_path",
    "file_put_contents", "file_get_contents", "fopen", "fwrite", "fputs", "file", "readfile", "unlink", "rmdir", "mkdir", "rename", "copy", "chmod", "chown", "symlink", "move_uploaded_file", "tempnam",
    "base64_decode", "gzinflate", "gzuncompress", "gzdecode", "str_rot13", "hex2bin", "convert_uudecode",
    "curl_\\w+", "fsockopen", "stream_socket_client", "wp_remote_\\w+", "wp_safe_remote_\\w+", "download_url",
    "update_option", "add_option", "delete_option", "wp_insert_user", "wp_create_user", "wp_update_user", "wp_set_password", "wp_set_current_user", "wp_set_auth_cookie", "add_role", "add_cap", "grant_super_admin",
    "register_rest_route", "add_rewrite_rule",
  ];
  // Scan the code itself: string contents and comments can say anything.
  const code = php.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\/[^\n]*|#(?!\[)[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' || m[0] === "'" ? "''" : " "));
  if (new RegExp(`(?<![\\w>:$])(${banned.join("|")})\\s*\\(`, "i").test(code)) errors.push(`${name}: uses a disallowed PHP function`);
  if (/\b(include|require)(_once)?\b/i.test(code)) errors.push(`${name}: must not include or require other files`);
  if (/`/.test(code)) errors.push(`${name}: backtick shell commands are not allowed`);
  if (/(?<![\w>:])\$\w+\s*\(|\$\$\w|\$\{/.test(code)) errors.push(`${name}: variable functions and variable variables are not allowed`);
  if (/\$wpdb\b/.test(code)) errors.push(`${name}: must not query the database directly`);
  if (/\$_(GET|POST|REQUEST|COOKIE|SERVER|FILES|ENV)\b|\$GLOBALS\b/.test(php)) errors.push(`${name}: must not read request superglobals`);
  if (/<\?php[\s\S]*<\?php/.test(php)) errors.push(`${name}: one PHP block only`);
  return errors;
}
