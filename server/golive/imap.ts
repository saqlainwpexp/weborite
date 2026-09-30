import { connect, type TLSSocket } from "node:tls";

/**
 * Just enough IMAP (over TLS) to find one test message and read its headers:
 * LOGIN, SELECT, UID SEARCH, UID FETCH BODY.PEEK[HEADER]. Handles literals ({n}\r\n...) in responses.
 */
class Imap {
  private buf = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private n = 0;
  private closed: Error | null = null;
  constructor(private sock: TLSSocket) {
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.waiter?.();
    });
    const end = (e?: Error) => {
      this.closed = e ?? new Error("The mail server closed the connection");
      this.waiter?.();
    };
    sock.on("error", end);
    sock.on("close", () => end());
  }

  private async wait() {
    if (this.closed) throw this.closed;
    await new Promise<void>((res) => (this.waiter = res));
    this.waiter = null;
  }

  /** Reads until a line starting with `tag ` arrives; returns everything before it plus that line. */
  private async readUntil(tag: string) {
    for (;;) {
      const text = this.buf.toString("latin1");
      const re = new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)([^\\r\\n]*)\\r\\n`);
      const m = re.exec(text);
      if (m) {
        const end = m.index + m[0].length;
        const body = text.slice(0, m.index + m[1].length);
        this.buf = this.buf.subarray(Buffer.byteLength(text.slice(0, end), "latin1"));
        return { status: m[2], info: m[3].trim(), body };
      }
      await this.wait();
    }
  }

  async greeting() {
    for (;;) {
      const t = this.buf.toString("latin1");
      if (/\r\n/.test(t)) {
        this.buf = Buffer.alloc(0);
        if (!/^\* (OK|PREAUTH)/.test(t)) throw new Error(`Unexpected greeting: ${t.slice(0, 80)}`);
        return;
      }
      await this.wait();
    }
  }

  async cmd(line: string) {
    const tag = `a${++this.n}`;
    this.sock.write(`${tag} ${line}\r\n`);
    const r = await this.readUntil(tag);
    if (r.status !== "OK") throw new Error(`${line.split(" ")[0]} failed: ${r.info}`);
    return r.body;
  }

  close() {
    try {
      this.sock.write(`a${++this.n} LOGOUT\r\n`);
    } catch {
      /* already closed */
    }
    this.sock.destroy();
  }
}

const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`;

export interface ImapConfig { host: string; port: number; user: string; password: string }

/** Headers of the newest message whose subject contains `needle`, or null. Looks in INBOX, then spam folders. */
export async function findMessageHeaders(cfg: ImapConfig, needle: string): Promise<{ headers: string; folder: string } | null> {
  const sock = connect({ host: cfg.host, port: cfg.port || 993, servername: cfg.host, timeout: 30000 });
  await new Promise<void>((res, rej) => {
    sock.once("secureConnect", () => res());
    sock.once("error", rej);
    sock.once("timeout", () => rej(new Error(`Couldn't reach ${cfg.host}:${cfg.port}`)));
  });
  const im = new Imap(sock);
  try {
    await im.greeting();
    await im.cmd(`LOGIN ${q(cfg.user)} ${q(cfg.password)}`);
    const list = await im.cmd(`LIST "" "*"`);
    const folders = [...list.matchAll(/^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/gm)].map((m) => ({ flags: m[1], name: m[2].trim() }));
    const junk = folders.filter((f) => /\\Junk|\\Spam/i.test(f.flags) || /spam|junk|bulk/i.test(f.name)).map((f) => f.name);
    for (const folder of ["INBOX", ...junk]) {
      try {
        await im.cmd(`SELECT ${folder.startsWith('"') ? folder : q(folder)}`);
      } catch {
        continue;
      }
      const found = await im.cmd(`UID SEARCH SUBJECT ${q(needle)}`);
      const uids = (/^\* SEARCH ?(.*)$/m.exec(found)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
      if (!uids.length) continue;
      const body = await im.cmd(`UID FETCH ${uids[uids.length - 1]} (BODY.PEEK[HEADER])`);
      const lit = /\{(\d+)\}\r\n/.exec(body);
      const headers = lit ? body.slice(lit.index + lit[0].length, lit.index + lit[0].length + Number(lit[1])) : body;
      return { headers, folder: folder.replace(/^"|"$/g, "") };
    }
    return null;
  } finally {
    im.close();
  }
}

/** Reads SPF/DKIM/DMARC verdicts from the receiving server's Authentication-Results (and Received-SPF) headers. */
export function authResults(headers: string) {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const lines = unfolded.split(/\r?\n/);
  const ar = lines.filter((l) => /^(ARC-)?Authentication-Results:/i.test(l)).map((l) => l.replace(/^[^:]+:\s*/, ""));
  // The first (topmost) Authentication-Results is the receiving server's own verdict.
  const own = ar[0] ?? "";
  const pick = (k: string) => new RegExp(`\\b${k}=(\\w+)`, "i").exec(own)?.[1]?.toLowerCase() ?? "";
  const received = lines.find((l) => /^Received-SPF:/i.test(l));
  return {
    spf: pick("spf") || (received ? (/^Received-SPF:\s*(\w+)/i.exec(received)?.[1] ?? "").toLowerCase() : ""),
    dkim: pick("dkim"),
    dmarc: pick("dmarc"),
    from: /^From:\s*(.+)$/im.exec(unfolded)?.[1]?.trim() ?? "",
    raw: own,
  };
}
