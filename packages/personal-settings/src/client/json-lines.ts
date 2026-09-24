/**
 * Source lines of the values inside one well-formed JSON document.
 *
 * The hook page tells a reader which line of which file to edit. The runtime
 * parser reports offending values by event name and array index, never by
 * position, so this module walks the same text once and records where each
 * value starts. It is a locator only: nothing here decides whether a value is
 * valid.
 * @module @psychiiii/dsh-three-window-review/client/json-lines
 */

/** One value's position in the document text. */
export interface SourceLocation {
  /** 1-based line of the value's first character. */
  readonly line: number
  /** 1-based column of the value's first character. */
  readonly column: number
}

/** Path of object keys and array indices from the document root to one value. */
export type JsonPath = readonly (string | number)[]

/** Line and column of every value in one document, keyed by {@link JsonPath}. */
export interface JsonLineIndex {
  /**
   * Position of the value at `path`.
   * @param path - object keys and array indices from the root.
   * @returns the position, or undefined when the document has no such value.
   */
  at(path: JsonPath): SourceLocation | undefined
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])

/** Mutable scan position, carrying the 1-based line and the last line's start offset. */
interface Cursor {
  index: number
  line: number
  lineStart: number
}

function keyOf(path: JsonPath): string {
  return path.map(String).join('\u0000')
}

function locationAt(cursor: Cursor): SourceLocation {
  return { line: cursor.line, column: cursor.index - cursor.lineStart + 1 }
}

function skipWhitespace(text: string, cursor: Cursor): void {
  while (cursor.index < text.length && WHITESPACE.has(text[cursor.index]!)) {
    if (text[cursor.index] === '\n') {
      cursor.line += 1
      cursor.lineStart = cursor.index + 1
    }
    cursor.index += 1
  }
}

/** Consume one JSON string starting at the opening quote and return its value. */
function readString(text: string, cursor: Cursor): string {
  let out = ''
  cursor.index += 1
  while (cursor.index < text.length) {
    const char = text[cursor.index]!
    if (char === '"') {
      cursor.index += 1
      return out
    }
    if (char === '\\') {
      const escape = text[cursor.index + 1]
      cursor.index += 2
      switch (escape) {
        case 'n': out += '\n'; break
        case 't': out += '\t'; break
        case 'r': out += '\r'; break
        case 'b': out += '\b'; break
        case 'f': out += '\f'; break
        case 'u': {
          out += String.fromCharCode(Number.parseInt(text.slice(cursor.index, cursor.index + 4), 16))
          cursor.index += 4
          break
        }
        default: out += escape ?? ''
      }
      continue
    }
    if (char === '\n') {
      cursor.line += 1
      cursor.lineStart = cursor.index + 1
    }
    out += char
    cursor.index += 1
  }
  return out
}

/** Consume one primitive (number, boolean, null) without interpreting it. */
function skipPrimitive(text: string, cursor: Cursor): void {
  while (cursor.index < text.length) {
    const char = text[cursor.index]!
    if (char === ',' || char === '}' || char === ']' || WHITESPACE.has(char)) return
    cursor.index += 1
  }
}

function walk(text: string, cursor: Cursor, path: JsonPath, out: Map<string, SourceLocation>): void {
  skipWhitespace(text, cursor)
  out.set(keyOf(path), locationAt(cursor))
  const char = text[cursor.index]
  if (char === '{') {
    cursor.index += 1
    for (;;) {
      skipWhitespace(text, cursor)
      if (text[cursor.index] === '}') { cursor.index += 1; return }
      if (text[cursor.index] === ',') { cursor.index += 1; continue }
      if (text[cursor.index] !== '"') return
      const keyLocation = locationAt(cursor)
      const key = readString(text, cursor)
      out.set(keyOf([...path, key]), keyLocation)
      skipWhitespace(text, cursor)
      if (text[cursor.index] !== ':') return
      cursor.index += 1
      walk(text, cursor, [...path, key], out)
      // The key's own line wins over the value's: a reader edits the key line.
      out.set(keyOf([...path, key]), keyLocation)
    }
  }
  if (char === '[') {
    cursor.index += 1
    let index = 0
    for (;;) {
      skipWhitespace(text, cursor)
      if (text[cursor.index] === ']') { cursor.index += 1; return }
      if (text[cursor.index] === ',') { cursor.index += 1; continue }
      walk(text, cursor, [...path, index], out)
      index += 1
    }
  }
  if (char === '"') { readString(text, cursor); return }
  skipPrimitive(text, cursor)
}

/**
 * Index every value's position in one JSON document.
 * @param text - document text; assumed well-formed, as it is only built after
 *   `JSON.parse` has accepted the same string.
 * @returns the position lookup.
 */
export function jsonLineIndex(text: string): JsonLineIndex {
  const out = new Map<string, SourceLocation>()
  walk(text, { index: 0, line: 1, lineStart: 0 }, [], out)
  return { at: path => out.get(keyOf(path)) }
}

/**
 * Position carried by a `JSON.parse` SyntaxError, when its message has one.
 * V8 reports `line L column C` on current engines and bare `position N` on
 * older ones; both forms are read here, and a message with neither yields
 * undefined rather than a guessed line.
 * @param message - the SyntaxError message.
 * @param text - the document the parse failed on, used to convert an offset.
 * @returns the failing position, or undefined when the message carries none.
 */
export function syntaxErrorLocation(message: string, text: string): SourceLocation | undefined {
  const lineColumn = /line (\d+) column (\d+)/.exec(message)
  if (lineColumn !== null) {
    return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) }
  }
  const position = /position (\d+)/.exec(message)
  if (position === null) return undefined
  const offset = Math.min(Number(position[1]), text.length)
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  const lineStart = before.lastIndexOf('\n') + 1
  return { line, column: offset - lineStart + 1 }
}

/**
 * Where a malformed document stops parsing.
 *
 * `JSON.parse` messages carry a position on some engines and only a quoted
 * snippet on others, so the position is derived here instead of read out of a
 * message whose wording is not part of any contract. The scan follows the JSON
 * grammar and stops at the first character that cannot continue it — the same
 * place a parser gives up, which for the usual trailing comma is the bracket
 * that follows it.
 * @param text - the document text.
 * @returns the first position that cannot continue the grammar, or undefined
 *   when the text is valid JSON.
 */
export function firstSyntaxErrorLocation(text: string): SourceLocation | undefined {
  const cursor: Cursor = { index: 0, line: 1, lineStart: 0 }
  skipWhitespace(text, cursor)
  if (!parseValue(text, cursor)) return locationAt(cursor)
  skipWhitespace(text, cursor)
  return cursor.index === text.length ? undefined : locationAt(cursor)
}

function expect(text: string, cursor: Cursor, character: string): boolean {
  if (text[cursor.index] !== character) return false
  cursor.index += 1
  return true
}

function parseValue(text: string, cursor: Cursor): boolean {
  const character = text[cursor.index]
  if (character === undefined) return false
  if (character === '{') return parseObject(text, cursor)
  if (character === '[') return parseArray(text, cursor)
  if (character === '"') return parseString(text, cursor)
  for (const literal of ['true', 'false', 'null']) {
    if (text.startsWith(literal, cursor.index)) {
      cursor.index += literal.length
      return true
    }
  }
  return parseNumber(text, cursor)
}

function parseObject(text: string, cursor: Cursor): boolean {
  cursor.index += 1
  skipWhitespace(text, cursor)
  if (expect(text, cursor, '}')) return true
  for (;;) {
    skipWhitespace(text, cursor)
    if (!parseString(text, cursor)) return false
    skipWhitespace(text, cursor)
    if (!expect(text, cursor, ':')) return false
    skipWhitespace(text, cursor)
    if (!parseValue(text, cursor)) return false
    skipWhitespace(text, cursor)
    if (expect(text, cursor, ',')) continue
    return expect(text, cursor, '}')
  }
}

function parseArray(text: string, cursor: Cursor): boolean {
  cursor.index += 1
  skipWhitespace(text, cursor)
  if (expect(text, cursor, ']')) return true
  for (;;) {
    skipWhitespace(text, cursor)
    if (!parseValue(text, cursor)) return false
    skipWhitespace(text, cursor)
    if (expect(text, cursor, ',')) continue
    return expect(text, cursor, ']')
  }
}

function parseString(text: string, cursor: Cursor): boolean {
  if (text[cursor.index] !== '"') return false
  cursor.index += 1
  for (;;) {
    const character = text[cursor.index]
    if (character === undefined || character === '\n') return false
    if (character === '"') {
      cursor.index += 1
      return true
    }
    if (character === '\\') {
      const escape = text[cursor.index + 1]
      if (escape === undefined || !'"\\/bfnrtu'.includes(escape)) return false
      cursor.index += escape === 'u' ? 6 : 2
      continue
    }
    cursor.index += 1
  }
}

function parseNumber(text: string, cursor: Cursor): boolean {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(cursor.index))
  if (match === null) return false
  cursor.index += match[0].length
  return true
}
