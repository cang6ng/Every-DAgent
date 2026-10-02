/**
 * The one way this package counts the bytes a string occupies on the wire.
 *
 * Encoded size is the only size the wire has: a frame measured in code units
 * can be four times larger once its non-ASCII characters are encoded, and an
 * escaped control character in JSON costs six. A byte bound and a JSON token
 * bound are therefore two numbers, and both come from here — counted, never
 * approximated, and never allocated: measuring a frame must not cost the memory
 * the bound exists to protect.
 *
 * Lone surrogates count as the three bytes their replacement character takes,
 * which is what every encoder on the path will actually write.
 */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
