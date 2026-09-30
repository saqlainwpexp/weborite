import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * A direct SMTP conversation with the client's mail server, the way a mail app or FluentSMTP connects:
 * implicit TLS on 465, STARTTLS on 587/25. Checks the certificate for the hostname and, with credentials,
 * that AUTH succeeds. Never sends a message.
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

function secure(sock: Socket | undefined, host: string, port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ ...(sock ? { socket: sock } : { host, port }), servername: host, rejectUnauthorized: false, timeout: 15000 });
    s.once("secureConnect", () => resolve(s));
    s.once("error", reject);
    s.once("timeout", () => reject(new Error(`${host}:${port} didn't answer`)));
  });
}

export interface SmtpResult {
  ok: boolean;
  tls: boolean;
  certOk: boolean;
  auth: boolean | null; // null = no credentials given
  detail: string;
}

export async function smtpProbe(host: string, port: number, encryption: "ssl" | "tls" | "none", creds?: { user: string; password: string }): Promise<SmtpResult> {
  const out: SmtpResult = { ok: false, tls: false, certOk: false, auth: null, detail: "" };
  let c: Conn | null = null;
  const guard = setTimeout(() => c?.sock.destroy(new Error("Timed out talking to the mail server")), 30000);
  try {
    if (encryption === "ssl") {
      const s = await secure(undefined, host, port);
      out.tls = true;
      out.certOk = !s.authorizationError;
      c = wrap(s);
    } else {
      const s = netConnect({ host, port, timeout: 15000 });
      await new Promise<void>((res, rej) => {
        s.once("connect", () => res());
        s.once("error", rej);
        s.once("timeout", () => rej(new Error(`${host}:${port} didn't answer (the host may block outgoing port ${port})`)));
      });
      c = wrap(s);
    }
    if (code(await c.read()) !== 220) throw new Error("The server didn't greet as a mail server");
    c.write("EHLO studio.local");
    let caps = await c.read();
    if (encryption === "tls") {
      if (!/STARTTLS/i.test(caps)) throw new Error("The server doesn't offer STARTTLS on this port");
      c.write("STARTTLS");
      if (code(await c.read()) !== 220) throw new Error("STARTTLS was refused");
      const plain = c.sock as Socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("error");
      plain.removeAllListeners("close");
      const s = await secure(plain, host, port);
      out.tls = true;
      out.certOk = !s.authorizationError;
      c = wrap(s);
      c.write("EHLO studio.local");
      caps = await c.read();
    }
    if (creds?.user && creds.password) {
      if (!/AUTH[ =][^\r\n]*(LOGIN|PLAIN)/i.test(caps)) throw new Error("The server doesn't offer password login on this port");
      c.write("AUTH PLAIN " + Buffer.from(`\0${creds.user}\0${creds.password}`).toString("base64"));
      const r = await c.read();
      out.auth = code(r) === 235;
      if (!out.auth) throw new Error(`Login refused: ${r.trim().split("\r\n").pop()}`);
    }
    c.write("QUIT");
    out.ok = out.tls ? out.certOk : encryption === "none";
    out.detail = `${host}:${port} ${out.tls ? (out.certOk ? "TLS with a valid certificate" : "TLS, but the certificate isn't valid for this name") : "no encryption"}${out.auth ? ", login accepted" : ""}`;
  } catch (e) {
    out.ok = false;
    const err = e as NodeJS.ErrnoException;
    out.detail = `${host}:${port} ${err.code === "ENOTFOUND" ? "doesn't exist in DNS" : err.code === "ECONNREFUSED" ? "refused the connection" : err.message}`;
  } finally {
    clearTimeout(guard);
    c?.sock.destroy();
  }
  return out;
}
