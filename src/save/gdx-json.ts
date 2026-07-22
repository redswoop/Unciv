/**
 * Parser for libGDX Json output — a superset of JSON.
 *
 * Unciv saves and rulesets come in three dialects, all handled here:
 *  - OutputType.minimal (old saves): unquoted names AND values —
 *    `{civName:Barbarians,gold:-1427,tiles:[{x:-15,y:-44}]}`
 *  - OutputType.json (new saves): valid strict JSON
 *  - Hand-written ruleset files: strict-ish JSON plus `//`/`/* *​/` comments,
 *    tabs, and trailing commas
 *
 * Grammar notes derived from libGDX JsonWriter: an unquoted string never
 * contains `{ } [ ] , : "` or newlines (the writer quotes those), so an
 * unquoted token simply runs until one of those delimiters. Unquoted tokens
 * that look like numbers/booleans/null are typed as such; everything else
 * stays a string (e.g. `Leaning Tower of Pisa`, `4.2.13`).
 */

export type GdxValue =
  | string
  | number
  | boolean
  | null
  | GdxValue[]
  | { [key: string]: GdxValue };

const NUMBER_RE = /^-?(0|[1-9]\d*|\d+)(\.\d+)?([eE][+-]?\d+)?$/;

class Parser {
  private pos = 0;
  constructor(private readonly text: string) {}

  parse(): GdxValue {
    this.skipWhitespaceAndComments();
    const value = this.parseValue();
    this.skipWhitespaceAndComments();
    if (this.pos < this.text.length) {
      throw new SyntaxError(
        `Unexpected trailing content at ${this.pos}: ${this.snippet()}`,
      );
    }
    return value;
  }

  private snippet(): string {
    return JSON.stringify(this.text.slice(this.pos, this.pos + 40));
  }

  private skipWhitespaceAndComments(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.pos++;
      } else if (c === "/" && t[this.pos + 1] === "/") {
        const nl = t.indexOf("\n", this.pos);
        this.pos = nl === -1 ? t.length : nl + 1;
      } else if (c === "/" && t[this.pos + 1] === "*") {
        const end = t.indexOf("*/", this.pos + 2);
        this.pos = end === -1 ? t.length : end + 2;
      } else {
        return;
      }
    }
  }

  private parseValue(): GdxValue {
    const c = this.text[this.pos];
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === '"') return this.parseQuotedString();
    return this.parseUnquoted();
  }

  private parseObject(): { [key: string]: GdxValue } {
    const obj: { [key: string]: GdxValue } = {};
    this.pos++; // {
    this.skipWhitespaceAndComments();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return obj;
    }
    for (;;) {
      this.skipWhitespaceAndComments();
      const key =
        this.text[this.pos] === '"'
          ? this.parseQuotedString()
          : this.parseUnquotedToken();
      this.skipWhitespaceAndComments();
      if (this.text[this.pos] !== ":") {
        throw new SyntaxError(`Expected ':' at ${this.pos}: ${this.snippet()}`);
      }
      this.pos++; // :
      this.skipWhitespaceAndComments();
      obj[String(key)] = this.parseValue();
      this.skipWhitespaceAndComments();
      const d = this.text[this.pos];
      if (d === ",") {
        this.pos++;
        this.skipWhitespaceAndComments();
        if (this.text[this.pos] === "}") {
          // trailing comma
          this.pos++;
          return obj;
        }
        continue;
      }
      if (d === "}") {
        this.pos++;
        return obj;
      }
      throw new SyntaxError(
        `Expected ',' or '}' at ${this.pos}: ${this.snippet()}`,
      );
    }
  }

  private parseArray(): GdxValue[] {
    const arr: GdxValue[] = [];
    this.pos++; // [
    this.skipWhitespaceAndComments();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return arr;
    }
    for (;;) {
      this.skipWhitespaceAndComments();
      arr.push(this.parseValue());
      this.skipWhitespaceAndComments();
      const d = this.text[this.pos];
      if (d === ",") {
        this.pos++;
        this.skipWhitespaceAndComments();
        if (this.text[this.pos] === "]") {
          // trailing comma
          this.pos++;
          return arr;
        }
        continue;
      }
      if (d === "]") {
        this.pos++;
        return arr;
      }
      throw new SyntaxError(
        `Expected ',' or ']' at ${this.pos}: ${this.snippet()}`,
      );
    }
  }

  private parseQuotedString(): string {
    const t = this.text;
    this.pos++; // "
    let out = "";
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c === "\\") {
        const e = t[this.pos + 1];
        this.pos += 2;
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            out += String.fromCharCode(
              parseInt(t.slice(this.pos, this.pos + 4), 16),
            );
            this.pos += 4;
            break;
          }
          default:
            throw new SyntaxError(`Bad escape \\${e} at ${this.pos}`);
        }
        continue;
      }
      out += c;
      this.pos++;
    }
    throw new SyntaxError("Unterminated string");
  }

  /** Raw unquoted token: runs until a structural delimiter. */
  private parseUnquotedToken(): string {
    const t = this.text;
    const start = this.pos;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (
        c === "," || c === "{" || c === "}" || c === "[" || c === "]" ||
        c === ":" || c === '"' || c === "\n" || c === "\r"
      ) {
        break;
      }
      this.pos++;
    }
    if (this.pos === start) {
      throw new SyntaxError(
        `Expected a value at ${this.pos}: ${this.snippet()}`,
      );
    }
    return t.slice(start, this.pos).trim();
  }

  /** Unquoted token in value position: type it like libGDX does. */
  private parseUnquoted(): GdxValue {
    const token = this.parseUnquotedToken();
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    if (NUMBER_RE.test(token)) return Number(token);
    return token;
  }
}

export function parseGdxJson(text: string): GdxValue {
  return new Parser(text).parse();
}
