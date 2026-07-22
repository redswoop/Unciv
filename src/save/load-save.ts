/**
 * Load an Unciv save into a GameInfo.
 *
 * Wire format (from Unciv's UncivFiles.gameInfoFromString + Gzip.kt):
 *   save = base64( gzip( json ) )  — when settings.saveZipped / multiplayer
 *   save = json                    — otherwise
 * Loader mirrors Unciv: strip newlines, try base64+gunzip, fall back to
 * treating the text as JSON directly. The JSON itself may be libGDX
 * "minimal" (old saves) or strict (new saves); parseGdxJson handles both.
 */

import { parseGdxJson } from "./gdx-json";
import type { GameInfo } from "./types";

const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzipToString(bytes: Uint8Array): Promise<string> {
  // Bun / Node test context
  const maybeBun = (globalThis as { Bun?: { gunzipSync(d: Uint8Array): Uint8Array } }).Bun;
  if (maybeBun?.gunzipSync) {
    return new TextDecoder().decode(maybeBun.gunzipSync(bytes));
  }
  // Browser
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

/** Unciv's gameInfoFromString, ported: returns the inner JSON text. */
export async function unwrapSaveText(raw: string): Promise<string> {
  const fixed = raw.trim().replace(/[\r\n]/g, "");
  if (!fixed.startsWith("{") && BASE64_RE.test(fixed.slice(0, 256))) {
    try {
      const bytes = base64ToBytes(fixed);
      if (isGzip(bytes)) return await gunzipToString(bytes);
    } catch {
      // fall through — treat as plain JSON, exactly like Unciv does
    }
  }
  return fixed;
}

export async function loadSaveFromText(raw: string): Promise<GameInfo> {
  const json = await unwrapSaveText(raw);
  const parsed = parseGdxJson(json) as unknown as GameInfo;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.civilizations)) {
    throw new Error("Not an Unciv save: no civilizations array");
  }
  if (!parsed.tileMap || !Array.isArray(parsed.tileMap.tileList)) {
    throw new Error("Not an Unciv save: no tileMap.tileList");
  }
  return parsed;
}

/** Convenience for tests/CLI (Bun). Browsers use loadSaveFromText. */
export async function loadSaveFromFile(path: string): Promise<GameInfo> {
  const maybeBun = (globalThis as { Bun?: { file(p: string): { text(): Promise<string> } } }).Bun;
  if (!maybeBun) throw new Error("loadSaveFromFile requires Bun");
  return loadSaveFromText(await maybeBun.file(path).text());
}
