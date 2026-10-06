/**
 * dsh-supercollider — OSC, by hand.
 *
 * Both implementations this package replaces wrote their own OSC
 * (`rust-server/src/sc_process.rs:180-233`, `mcp_py/sc_process.py:112-173`)
 * because an OSC library would be an npm dependency and this pack ships none.
 * This is that encoder and decoder, generalised to the tags scsynth actually
 * puts on the wire.
 *
 * The rules, because every one of them is a bug waiting to happen:
 *
 *   - **Big-endian, 4-byte aligned.** An OSC string is NUL-terminated and then
 *     padded with NULs to the next 4-byte boundary; a blob is a big-endian
 *     int32 length, then the bytes, then the same padding.
 *   - **Padding is computed on the STRING'S OWN length, never on the running
 *     buffer.** `rust-server/src/sc_process.rs:181` padded against
 *     `out.len()`, which is only correct because every earlier element ended
 *     aligned. Computing it per element is correct unconditionally.
 *   - **A blob's padding follows its content**, so a decoder must advance
 *     `length + pad(length)`.
 *   - **A typetag string always starts with `,`.** scsynth ignores a message
 *     whose tags do not, so a decoder treats a missing `,` as a malformed
 *     datagram rather than guessing.
 *   - **Booleans are 32-bit ints**, and in JavaScript `true` is not a number, so
 *     the encoder asks explicitly rather than letting a type test fall through.
 *
 * The decoder is deliberately total: an unknown tag consumes nothing and is
 * reported in `args` as `{ tag }`, so one unexpected field cannot desynchronise
 * the rest of a `/status.reply` and turn a parse into a wrong answer.
 */

/** The 4-byte boundary every OSC element is padded to. */
const ALIGN = 4

/**
 * A NUL-terminated ASCII/UTF-8 string padded to a 4-byte boundary.
 *
 * @param value - the string.
 * @returns its OSC encoding.
 */
export function encodeString(value) {
  const bytes = Buffer.from(String(value), 'utf8')
  const withNul = bytes.length + 1
  const padded = Math.ceil(withNul / ALIGN) * ALIGN
  const out = Buffer.alloc(padded)
  bytes.copy(out, 0)
  // Buffer.alloc zero-fills, so the terminator and the padding are already 0.
  return out
}

/** A 32-bit big-endian int. */
export function encodeInt32(value) {
  const out = Buffer.alloc(4)
  out.writeInt32BE(Math.trunc(Number(value)) | 0)
  return out
}

/** A 32-bit big-endian float. */
export function encodeFloat32(value) {
  const out = Buffer.alloc(4)
  out.writeFloatBE(Number(value))
  return out
}

/** A 64-bit big-endian float. */
export function encodeFloat64(value) {
  const out = Buffer.alloc(8)
  out.writeDoubleBE(Number(value))
  return out
}

/**
 * A blob: big-endian int32 length, the bytes, then padding.
 *
 * @param value - a Buffer or Uint8Array.
 * @returns its OSC encoding.
 */
export function encodeBlob(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const pad = (ALIGN - (data.length % ALIGN)) % ALIGN
  return Buffer.concat([encodeInt32(data.length), data, Buffer.alloc(pad)])
}

/** A 64-bit OSC timetag (NTP seconds since 1900, in a 32.32 fixed point). */
export function encodeTimeTag(seconds = Date.now() / 1000) {
  const out = Buffer.alloc(8)
  // 2208988800 is the seconds between 1900-01-01 and 1970-01-01.
  const ntp = seconds + 2208988800
  const whole = Math.floor(ntp)
  const fraction = Math.round((ntp - whole) * 4294967296)
  out.writeUInt32BE(whole >>> 0, 0)
  out.writeUInt32BE(fraction >>> 0, 4)
  return out
}

/**
 * The typetag one argument encodes to, or null when this codec cannot carry it.
 *
 * `true`/`false` are checked before `number` on purpose: in JavaScript
 * `typeof true === 'boolean'`, but a caller reaching this function through JSON
 * may hand over the number 1, and both must become `i`.
 *
 * @param value - one argument.
 * @returns the tag character, or null.
 */
export function tagOf(value) {
  if (typeof value === 'boolean') return 'i'
  if (typeof value === 'string') return 's'
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return 'b'
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? 'i' : 'f'
  }
  if (value !== null && typeof value === 'object' && value.timetag === true) return 't'
  return null
}

/**
 * One OSC message: the address, the typetag string, then each argument.
 *
 * @param address - the address pattern, e.g. `/s_new`.
 * @param args - the arguments, in order. Default: none.
 * @returns the datagram.
 * @throws when an argument has no OSC representation.
 */
export function encodeMessage(address, args = []) {
  if (typeof address !== 'string' || !address.startsWith('/')) {
    throw new Error('an OSC address must be a string starting with "/": ' + JSON.stringify(address))
  }
  let tags = ','
  const payload = []
  for (const [index, value] of args.entries()) {
    const tag = tagOf(value)
    if (tag === null) {
      throw new Error(
        'OSC argument ' + index + ' of ' + address + ' has no representation (' + describe(value) + ')',
      )
    }
    tags += tag
    if (tag === 's') payload.push(encodeString(value))
    else if (tag === 'b') payload.push(encodeBlob(value))
    else if (tag === 'i') payload.push(encodeInt32(typeof value === 'boolean' ? (value ? 1 : 0) : value))
    else if (tag === 'f') payload.push(encodeFloat32(value))
    else if (tag === 't') payload.push(encodeTimeTag(value.seconds))
  }
  return Buffer.concat([encodeString(address), encodeString(tags), ...payload])
}

/**
 * One OSC bundle: the `#bundle` marker, a timetag, then each contained element
 * prefixed with its own big-endian int32 length.
 *
 * @param options - `{ elements, seconds }`. `elements` are already-encoded
 *   Buffers (a bundle nests a message or another bundle); `seconds` defaults to
 *   "immediately".
 * @returns the datagram.
 */
export function encodeBundle(options = {}) {
  const elements = Array.isArray(options.elements) ? options.elements : []
  const parts = [encodeString('#bundle'), encodeTimeTag(options.seconds)]
  for (const element of elements) {
    const data = Buffer.isBuffer(element) ? element : Buffer.from(element)
    parts.push(encodeInt32(data.length), data)
  }
  return Buffer.concat(parts)
}

/** Read one OSC string at `offset`; returns the value and the next offset. */
function readString(buffer, offset) {
  const end = buffer.indexOf(0, offset)
  if (end < 0) throw new Error('OSC string is not NUL-terminated at offset ' + offset)
  const value = buffer.toString('utf8', offset, end)
  const next = offset + Math.ceil((end - offset + 1) / ALIGN) * ALIGN
  return { value, next }
}

/**
 * Decode one datagram.
 *
 * @param buffer - the received bytes.
 * @returns `{ kind: 'message', address, tags, args }` or
 *   `{ kind: 'bundle', seconds, elements }`.
 * @throws when the datagram is not an OSC message or bundle.
 */
export function decodeMessage(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (data.length < 4) throw new Error('an OSC datagram is at least 4 bytes; got ' + data.length)
  if (data[0] === 0x23 /* '#' */) return decodeBundle(data)

  let offset = 0
  const address = readString(data, offset)
  offset = address.next
  const tags = readString(data, offset)
  offset = tags.next
  if (!tags.value.startsWith(',')) {
    throw new Error('an OSC message typetag string must start with ","; got ' + JSON.stringify(tags.value))
  }

  const args = []
  for (const tag of tags.value.slice(1)) {
    switch (tag) {
      case 'i': {
        args.push(data.readInt32BE(offset))
        offset += 4
        break
      }
      case 'f': {
        args.push(data.readFloatBE(offset))
        offset += 4
        break
      }
      case 'd': {
        args.push(data.readDoubleBE(offset))
        offset += 8
        break
      }
      case 's':
      case 'S': {
        const read = readString(data, offset)
        args.push(read.value)
        offset = read.next
        break
      }
      case 'b': {
        const length = data.readInt32BE(offset)
        offset += 4
        const bytes = data.subarray(offset, offset + length)
        args.push(Buffer.from(bytes))
        offset += length + ((ALIGN - (length % ALIGN)) % ALIGN)
        break
      }
      case 't': {
        const seconds = data.readUInt32BE(offset)
        const fraction = data.readUInt32BE(offset + 4)
        args.push({ timetag: true, seconds: seconds + fraction / 4294967296 - 2208988800 })
        offset += 8
        break
      }
      case 'h': {
        args.push(data.readBigInt64BE(offset))
        offset += 8
        break
      }
      case 'T': {
        args.push(true)
        break
      }
      case 'F': {
        args.push(false)
        break
      }
      case 'N': {
        args.push(null)
        break
      }
      case 'I': {
        args.push(Infinity)
        break
      }
      default: {
        // Unknown tag: report it and keep the rest readable rather than
        // derailing the offsets. A /status.reply must never be half-decoded
        // into a confident wrong number.
        args.push({ tag, unknown: true })
        break
      }
    }
  }
  return { kind: 'message', address: address.value, tags: tags.value, args }
}

/** Decode a bundle, recursing into its elements. */
function decodeBundle(data) {
  const marker = readString(data, 0)
  if (marker.value !== '#bundle') throw new Error('expected #bundle, got ' + JSON.stringify(marker.value))
  const seconds = data.readUInt32BE(marker.next) + data.readUInt32BE(marker.next + 4) / 4294967296 - 2208988800
  const elements = []
  let offset = marker.next + 8
  while (offset + 4 <= data.length) {
    const length = data.readInt32BE(offset)
    offset += 4
    if (length <= 0 || offset + length > data.length) break
    elements.push(decodeMessage(data.subarray(offset, offset + length)))
    offset += length
  }
  return { kind: 'bundle', seconds, elements }
}

/**
 * The decoded value at one typed position of a `/status.reply`, or null.
 *
 * scsynth's reply is `,iiiiiffdd` on every version measured here
 * (`[1, ugenCount, synthCount, groupCount, synthDefCount, avgCPU, peakCPU,
 * nominalSR, actualSR]`), but the *decoder* must not assume that: a reply is
 * read by tag, and this helper returns a number only when the tag says number.
 *
 * @param args - the decoded args.
 * @param index - the position.
 * @returns the numeric value, or null.
 */
export function numberAt(args, index) {
  const value = Array.isArray(args) ? args[index] : undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A human description of a value, for an error message. */
function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value === undefined) return 'undefined'
  return typeof value
}

/**
 * `/status.reply` as the fields this package reports.
 *
 * @param args - the decoded args of a `/status.reply`.
 * @returns the named metrics; every field is null when it is absent rather
 *   than 0, so "unknown" and "zero" never look the same.
 */
export function statusMetrics(args) {
  return {
    ugenCount: numberAt(args, 1),
    synthCount: numberAt(args, 2),
    groupCount: numberAt(args, 3),
    synthDefCount: numberAt(args, 4),
    avgCpu: numberAt(args, 5),
    peakCpu: numberAt(args, 6),
    nominalSampleRate: numberAt(args, 7),
    actualSampleRate: numberAt(args, 8),
  }
}

/** True when a datagram's address is `wanted` (a message, not a bundle). */
export function isAddress(message, wanted) {
  return message !== null && typeof message === 'object' && message.address === wanted
}
