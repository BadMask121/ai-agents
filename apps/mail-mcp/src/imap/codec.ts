/**
 * Text encodings IMAP and MIME use: modified UTF-7 mailbox names (RFC 3501
 * 5.1.3), encoded-word headers (RFC 2047), RFC 2231 parameters, base64 /
 * quoted-printable bodies, and charsets.
 */

const encoder = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode bytes in `charset`, falling back to UTF-8, then Latin-1, for unknown labels. */
export function decodeCharset(bytes: Uint8Array, charset = "utf-8"): string {
  for (const label of [charset, "utf-8"]) {
    try {
      return new TextDecoder(label.trim().toLowerCase()).decode(bytes);
    } catch {
      /* unsupported label — try the next */
    }
  }
  return String.fromCharCode(...bytes);
}

export function decodeQuotedPrintable(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const hex = (c: number) =>
    c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c !== 0x3d /* = */) {
      out.push(c);
      continue;
    }
    // Soft line break: "=" before CRLF or LF.
    if (input[i + 1] === 0x0d && input[i + 2] === 0x0a) {
      i += 2;
      continue;
    }
    if (input[i + 1] === 0x0a) {
      i += 1;
      continue;
    }
    const hi = hex(input[i + 1] ?? 0);
    const lo = hex(input[i + 2] ?? 0);
    if (hi >= 0 && lo >= 0) {
      out.push(hi * 16 + lo);
      i += 2;
    } else {
      out.push(c);
    }
  }
  return new Uint8Array(out);
}

/** Undo a Content-Transfer-Encoding. 7bit/8bit/binary pass through. */
export function decodeTransfer(bytes: Uint8Array, encoding: string | undefined): Uint8Array {
  switch ((encoding ?? "").toLowerCase()) {
    case "base64":
      return base64ToBytes(new TextDecoder().decode(bytes));
    case "quoted-printable":
      return decodeQuotedPrintable(bytes);
    default:
      return bytes;
  }
}

/** RFC 2047 encoded words, e.g. "=?UTF-8?B?SGVsbG8=?=" → "Hello". */
export function decodeEncodedWords(input: string): string {
  // Whitespace between two adjacent encoded words is not part of the text.
  const joined = input.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
    const cs = charset.split("*")[0]!; // drop an RFC 2231 language suffix
    if (enc.toUpperCase() === "B") return decodeCharset(base64ToBytes(text), cs);
    const qp = text.replace(/_/g, " ");
    return decodeCharset(decodeQuotedPrintable(encoder.encode(qp)), cs);
  });
}

/** RFC 2231 extended value, e.g. "utf-8''na%C3%AFve.pdf". */
export function decodeRfc2231(value: string): string {
  const m = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!m) return value;
  const bytes: number[] = [];
  const s = m[2]!;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(s.charCodeAt(i));
    }
  }
  return decodeCharset(new Uint8Array(bytes), m[1] || "utf-8");
}

// ---- modified UTF-7 (mailbox names) ---------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

export function decodeMailboxName(name: string): string {
  return name.replace(/&([^-]*)-/g, (_m, b64: string) => {
    if (b64 === "") return "&";
    let bits = 0;
    let value = 0;
    const units: number[] = [];
    for (const ch of b64) {
      value = (value << 6) | B64.indexOf(ch);
      bits += 6;
      if (bits >= 16) {
        bits -= 16;
        units.push((value >> bits) & 0xffff);
      }
    }
    return String.fromCharCode(...units);
  });
}

export function encodeMailboxName(name: string): string {
  let out = "";
  let pending: number[] = [];
  const flush = () => {
    if (!pending.length) return;
    let bits = 0;
    let value = 0;
    let b64 = "";
    for (const unit of pending) {
      value = (value << 16) | unit;
      bits += 16;
      while (bits >= 6) {
        bits -= 6;
        b64 += B64[(value >> bits) & 0x3f];
      }
    }
    if (bits > 0) b64 += B64[(value << (6 - bits)) & 0x3f];
    out += `&${b64}-`;
    pending = [];
  };
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += code === 0x26 ? "&-" : name[i];
    } else {
      pending.push(code);
    }
  }
  flush();
  return out;
}

// ---- command arguments -----------------------------------------------------

/** A command argument: a quoted string when it's printable ASCII, else a
 * non-synchronising literal (LITERAL+) carrying UTF-8 bytes. */
export function argument(value: string): string | Uint8Array {
  if (/^[\x20-\x7e]*$/.test(value)) return `"${value.replace(/[\\"]/g, "\\$&")}"`;
  const bytes = encoder.encode(value);
  const head = encoder.encode(`{${bytes.length}+}\r\n`);
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head, 0);
  out.set(bytes, head.length);
  return out;
}
