import { randomBytes } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * A direct SMTP conversation with a mail server, the way a mail app or FluentSMTP connects:
 * implicit TLS on 465, STARTTLS on 587/25. Used to test a mailbox (go-live) and to send outreach (automations).
 */

type Conn = { sock: Socket | TLSSocket; read: () => Promise<string>; write: (l: string) => void };

function wrap(sock: Socket | TLSSocket): Conn {
  let buf = "";
  let waiter: (() => void) | null = null;
  let failed: Error | null = null;
  sock.setEncoding("utf8");
  sock.on("data", (d: string) => {
    buf += d;
    waiter?.();
  });
  const fail = (e: Error) => {
    failed = e;
    waiter?.();
  };
  sock.on("error", fail);
  sock.on("close", () => fail(new Error("The server closed the connection")));
  return {
    sock,
    write: (l) => sock.write(l + "\r\n"),
    // One full reply: lines "250-..." continue, "250 ..." ends.
    read: async () => {
      for (;;) {
        const m = /(^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(buf);
        if (m) {
          const end = m.index + m[0].length;
          const reply = buf.slice(0, end);
          buf = buf.slice(end);
          return reply;
        }
        if (failed) throw failed;
        await new Promise<void>((r) => (waiter = r));
        waiter = null;
      }
    },
  };
}

const code = (reply: string) => Number(/(\d{3}) [^\r\n]*\r\n$/.exec(reply)?.[1] ?? 0);
const last = (reply: string) => reply.trim().split("\r\n").pop() ?? "";

function secure(sock: Socket | undefined, host: string, port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ ...(sock ? { socket: sock } : { host, port }), servername: host, rejectUnauthorized: false, timeout: 15000 });
    s.once("secureConnect", () => resolve(s));
    s.once("error", reject);
    s.once("timeout", () => reject(new Error(`${host}:${port} didn't answer`)));
  });
}

export type Security = "ssl" | "tls" | "none";
export interface SmtpConfig { host: string; port: number; security: Security; user?: string; password?: string }
type Session = { c: Conn; tls: boolean; certOk: boolean; auth: boolean | null };

/** Connect, greet, upgrade to TLS and log in. The caller QUITs and destroys the socket. */
async function open(cfg: SmtpConfig, onConn: (c: Conn) => void): Promise<Session> {
  const { host, port, security } = cfg;
  let c: Conn;
  let tls = false;
  let certOk = false;
  if (security === "ssl") {
    const s = await secure(undefined, host, port);
    tls = true;
    certOk = !s.authorizationError;
    c = wrap(s);
  } else {
    const s = netConnect({ host, port, timeout: 15000 });
    await new Promise<void>((res, rej) => {
      s.once("connect", () => res());
      s.once("error", rej);
      s.once("timeout", () => rej(new Error(`${host}:${port} didn't answer (the network may block outgoing port ${port})`)));
    });
    c = wrap(s);
  }
  onConn(c);
  if (code(await c.read()) !== 220) throw new Error("The server didn't greet as a mail server");
  c.write("EHLO studio.local");
  let caps = await c.read();
  if (security === "tls") {
    if (!/STARTTLS/i.test(caps)) throw new Error("The server doesn't offer STARTTLS on this port");
    c.write("STARTTLS");
    if (code(await c.read()) !== 220) throw new Error("STARTTLS was refused");
    const plain = c.sock as Socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    const s = await secure(plain, host, port);
    tls = true;
    certOk = !s.authorizationError;
    c = wrap(s);
    onConn(c);
    c.write("EHLO studio.local");
    caps = await c.read();
  }
  let auth: boolean | null = null;
  if (cfg.user && cfg.password) {
    if (!/AUTH[ =][^\r\n]*(LOGIN|PLAIN)/i.test(caps)) throw new Error("The server doesn't offer password login on this port");
    c.write("AUTH PLAIN " + Buffer.from(`\0${cfg.user}\0${cfg.password}`).toString("base64"));
    const r = await c.read();
    auth = code(r) === 235;
    if (!auth) throw new Error(`Login refused: ${last(r)}`);
  }
  return { c, tls, certOk, auth };
}

function describe(e: unknown, host: string, port: number) {
  const err = e as NodeJS.ErrnoException;
  return `${host}:${port} ${err.code === "ENOTFOUND" ? "doesn't exist in DNS" : err.code === "ECONNREFUSED" ? "refused the connection" : err.message}`;
}

export interface SmtpResult {
  ok: boolean;
  tls: boolean;
  certOk: boolean;
  auth: boolean | null; // null = no credentials given
  detail: string;
}

/** Connect (and log in, with credentials) without sending anything. */
export async function smtpProbe(host: string, port: number, security: Security, creds?: { user: string; password: string }): Promise<SmtpResult> {
  const out: SmtpResult = { ok: false, tls: false, certOk: false, auth: null, detail: "" };
  let conn: Conn | null = null;
  const guard = setTimeout(() => conn?.sock.destroy(new Error("Timed out talking to the mail server")), 30000);
  try {
    const s = await open({ host, port, security, user: creds?.user, password: creds?.password }, (c) => (conn = c));
    Object.assign(out, { tls: s.tls, certOk: s.certOk, auth: s.auth });
    s.c.write("QUIT");
    out.ok = s.tls ? s.certOk : security === "none";
    out.detail = `${host}:${port} ${s.tls ? (s.certOk ? "TLS with a valid certificate" : "TLS, but the certificate isn't valid for this name") : "no encryption"}${s.auth ? ", login accepted" : ""}`;
  } catch (e) {
    out.detail = describe(e, host, port);
  } finally {
    clearTimeout(guard);
    (conn as Conn | null)?.sock.destroy();
  }
  return out;
}

/* ---------- sending ---------- */

export interface MailMessage {
  fromName: string;
  fromEmail: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  attachment?: { name: string; type: string; data: Buffer };
}

const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);
// An encoded word can't sit inside quotes, so only plain-ASCII names are quoted.
const addr = (name: string, email: string) => (!name ? `<${email}>` : /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "")}" <${email}>` : `${encWord(name)} <${email}>`);
const b64lines = (b: Buffer) => b.toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function buildMime(m: MailMessage) {
  const boundary = "studio-" + randomBytes(8).toString("hex");
  const domain = m.fromEmail.split("@")[1] || "localhost";
  const head = [
    `From: ${addr(clean(m.fromName), clean(m.fromEmail))}`,
    `To: <${clean(m.to)}>`,
    ...(m.replyTo ? [`Reply-To: <${clean(m.replyTo)}>`] : []),
    `Subject: ${encWord(clean(m.subject))}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  const textPart = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64lines(Buffer.from(m.text.replace(/\r?\n/g, "\r\n")))];
  if (!m.attachment) return [...head, ...textPart].join("\r\n");
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...textPart,
    `--${boundary}`,
    `Content-Type: ${m.attachment.type}; name="${m.attachment.name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${m.attachment.name}"`,
    "",
    b64lines(m.attachment.data),
    `--${boundary}--`,
  ].join("\r\n");
}

/** Send one message. Throws with the server's reason when it's refused. */
export async function sendMail(cfg: SmtpConfig, m: MailMessage) {
  let conn: Conn | null = null;
  const guard = setTimeout(() => conn?.sock.destroy(new Error("Timed out talking to the mail server")), 60000);
  try {
    const { c } = await open(cfg, (x) => (conn = x));
    c.write(`MAIL FROM:<${clean(m.fromEmail)}>`);
    let r = await c.read();
    if (code(r) !== 250) throw new Error(`Sender refused: ${last(r)}`);
    c.write(`RCPT TO:<${clean(m.to)}>`);
    r = await c.read();
    if (code(r) !== 250 && code(r) !== 251) throw new Error(`Recipient refused: ${last(r)}`);
    c.write("DATA");
    if (code(await c.read()) !== 354) throw new Error("The server didn't accept the message body");
    // Dot-stuffing: a line starting with "." gets a second one.
    c.write(buildMime(m).replace(/^\./gm, "..") + "\r\n.");
    r = await c.read();
    if (code(r) !== 250) throw new Error(`Message refused: ${last(r)}`);
    c.write("QUIT");
    return last(r);
  } catch (e) {
    throw new Error(describe(e, cfg.host, cfg.port));
  } finally {
    clearTimeout(guard);
    (conn as Conn | null)?.sock.destroy();
  }
}
