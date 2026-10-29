/**
 * Text extraction from Messages `attributedBody` blobs.
 *
 * On Ventura and later `message.text` is often NULL and the body lives only in
 * `attributedBody`: an NSAttributedString archived as a typedstream. We do not
 * decode the whole stream. The string payload follows the first `NSString`
 * class name: a few class-version bytes, the `+` type tag, a length, then the
 * UTF-8 bytes. The length is one byte, or 0x81 then a two-byte little-endian
 * length, or 0x82 then a four-byte one.
 */

const NSSTRING = Buffer.from("NSString", "latin1");

/** typedstream tag for a length-prefixed C string. */
const STRING_TAG = 0x2b;

/** How far past the class name to look for the string tag (observed: 4 bytes). */
const MAX_TAG_SCAN = 8;

/** Object replacement character Messages puts where an attachment sits in the text. */
const ATTACHMENT_PLACEHOLDER = /￼/g;

export function extractAttributedBodyText(blob: Buffer | null | undefined): string | null {
  if (!blob || blob.length === 0) return null;
  const marker = blob.indexOf(NSSTRING);
  if (marker < 0) return null;

  let i = marker + NSSTRING.length;
  const scanEnd = Math.min(blob.length, i + MAX_TAG_SCAN);
  while (i < scanEnd && blob[i] !== STRING_TAG) i++;
  if (i >= scanEnd) return null;
  i++;

  if (i >= blob.length) return null;
  let len = blob[i++];
  if (len === 0x81) {
    if (i + 2 > blob.length) return null;
    len = blob.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    if (i + 4 > blob.length) return null;
    len = blob.readUInt32LE(i);
    i += 4;
  }
  if (i + len > blob.length) return null;
  return blob.subarray(i, i + len).toString("utf8");
}

/** Extract from the `hex(attributedBody)` string the sqlite3 CLI returns. */
export function extractAttributedBodyHex(hex: string | null | undefined): string | null {
  if (!hex || hex.length % 2 !== 0) return null;
  return extractAttributedBodyText(Buffer.from(hex, "hex"));
}

/** Message body: `text` when present, else the attributedBody payload, minus attachment placeholders. */
export function messageText(text: string | null | undefined, attributedBodyHex: string | null | undefined): string {
  const raw = text ? text : extractAttributedBodyHex(attributedBodyHex) ?? "";
  return raw.replace(ATTACHMENT_PLACEHOLDER, "").trim();
}

/**
 * The same extraction as an SQL expression, so search can LIKE over bodies
 * that exist only in attributedBody. `blob` is the attributedBody column and
 * `pos` the 1-based position of `NSString` in it (instr), computed once by the
 * caller. Assumes the observed fixed layout (length byte 13 bytes after the
 * marker) and handles the one-byte and 0x81 lengths; 0x82 bodies (over 64 KB)
 * are not searchable this way.
 */
export function attributedBodyTextSql(blob: string, pos: string): string {
  const nibble = (hexExpr: string, at: number) =>
    `(instr('0123456789ABCDEF', substr(${hexExpr}, ${at}, 1)) - 1)`;
  const lenByte = `hex(substr(${blob}, ${pos} + 13, 1))`;
  const len16 = `hex(substr(${blob}, ${pos} + 14, 2))`;
  const short = `(${nibble(lenByte, 1)} * 16 + ${nibble(lenByte, 2)})`;
  const long = `(${nibble(len16, 3)} * 4096 + ${nibble(len16, 4)} * 256 + ${nibble(len16, 1)} * 16 + ${nibble(len16, 2)})`;
  return `CASE WHEN ${blob} IS NULL OR ${pos} = 0 THEN NULL
    WHEN ${lenByte} = '81' THEN CAST(substr(${blob}, ${pos} + 16, ${long}) AS TEXT)
    ELSE CAST(substr(${blob}, ${pos} + 14, ${short}) AS TEXT) END`;
}
