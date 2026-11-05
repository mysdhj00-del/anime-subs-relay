// Subtitle endpoints for the AnimeVerse addon — PENDING DEPLOYMENT.
// Written 2026-11-05. NOT wired into main.ts yet and NOT deployed:
// the deployed relay (deno-relay.mysdhj00-del.deno.net) still runs
// the Oct 18 main.ts, whose /relay/mergesubs answers 404, and the
// deployment route (GitHub-linked vs dashboard vs token) is unknown.
// Wiring at deploy time (in main.ts, next to the other /relay/*
// branches, before the final 404):
//   import { handleSubTranslate, handleSubMerge } from "./subtitles.ts";
//   if (url.pathname === "/relay/translate") return handleSubTranslate(url);
//   if (url.pathname === "/relay/mergesubs") return handleSubMerge(url);
// Pure Web APIs only (fetch/Response) — no Deno-specific imports,
// no keys, no secrets. Free translation via the public gtx endpoint
// (may 302 from some datacenter IPs — verify after deploy; if gtx
// is blocked from Deno's network, swap translateBatch's URL for
// another free engine, the cue plumbing stays the same).

type Cue = {
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  text: string;
};

function tsToMs(t: string): number {
  const clean = t.trim().replace(",", ".");
  const parts = clean.split(":");
  const secParts = parts[parts.length - 1].split(".");
  const secs = parseInt(secParts[0] || "0", 10);
  const ms = parseInt((secParts[1] || "0").padEnd(3, "0").slice(0, 3), 10);
  let total = secs * 1000 + ms;
  if (parts.length === 3) total += parseInt(parts[0], 10) * 3600 * 1000 + parseInt(parts[1], 10) * 60 * 1000;
  else if (parts.length === 2) total += parseInt(parts[0], 10) * 60 * 1000;
  return total;
}

function fmtMs(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}.${p(r, 3)}`;
}

// Parses VTT and SRT (same block shape; SRT timestamps use a comma).
// Cue text is cleaned: HTML tags stripped (SRT <font> wrappers are
// not valid VTT and render literally), entities decoded, and
// double-encoded UTF-8 repaired (some OpenSubtitles files store
// Arabic as mojibake: UTF-8 bytes re-encoded as Latin-1 — the
// repair maps each char back to its byte and UTF-8-decodes; it
// only applies when the result actually contains Arabic).
// Windows-1252 byte values for the punctuation chars that Latin-1
// lacks (the mojibake in OpenSubtitles files uses Win1252: byte
// 0x84 arrives as „ U+201E, 0x93 as “ U+201C, ...). A plain
// Latin-1 remap produces wrong bytes for those and the repair
// silently fails — this table is what makes the repair work.
const WIN1252_SPECIAL: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

function fixDoubleEncoded(s: string): string {
  // Per-run repair: remap each run of Latin-1/Win1252 chars back to
  // bytes and UTF-8-decode it, keeping genuine Arabic/CJK runs
  // untouched. Runs are needed because one cue mixes proper Arabic
  // with mojibake, and the 0x80-0x9F range must map to its own byte
  // (Latin-1 control chars like U+0081, which is UTF-8 byte 0x81
  // of an Arabic letter) — a whole-string remap bails on those.
  let out = "";
  let run = "";
  const flush = () => {
    if (!run) return;
    try {
      const bytes = new Uint8Array(run.length);
      for (let i = 0; i < run.length; i++) {
        const c = run[i];
        const code = c.charCodeAt(0);
        if (code < 0x100) bytes[i] = code;
        else if (c in WIN1252_SPECIAL) bytes[i] = WIN1252_SPECIAL[c];
        else { out += run; run = ""; return; }
      }
      const fixed = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      out += /[\u0600-\u06FF]/.test(fixed) ? fixed : run;
    } catch {
      out += run;
    }
    run = "";
  };
  for (const c of s) {
    const code = c.charCodeAt(0);
    if (code < 0x100 || c in WIN1252_SPECIAL) run += c;
    else { flush(); out += c; }
  }
  flush();
  return out;
}

function cleanCueText(t: string): string {
  return fixDoubleEncoded(
    t.replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'"),
  ).trim();
}

function parseSubs(text: string): Cue[] {
  const norm = text.replace(/\r\n?/g, "\n");
  const blocks = norm.split(/\n\s*\n/);
  const cues: Cue[] = [];
  const tsRe = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})/;
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    if (/^WEBVTT/i.test(lines[0])) continue;
    if (/^(NOTE|STYLE|REGION)\b/i.test(lines[0])) continue;
    let tsIdx = lines.findIndex((l) => tsRe.test(l));
    if (tsIdx < 0) continue;
    const m = lines[tsIdx].match(tsRe);
    if (!m) continue;
    const body = lines.slice(tsIdx + 1).join("\n").trim();
    if (!body) continue;
    cues.push({
      start: fmtMs(tsToMs(m[1])),
      end: fmtMs(tsToMs(m[2])),
      startMs: tsToMs(m[1]),
      endMs: tsToMs(m[2]),
      text: cleanCueText(body),
    });
  }
  return cues;
}

function toVTT(cues: Cue[]): string {
  const out = ["WEBVTT", ""];
  for (const c of cues) {
    out.push(`${c.start} --> ${c.end}`, c.text, "");
  }
  return out.join("\n");
}

// One gtx request for a batch of cue texts (repeated q params keep
// results aligned per cue). On any parse surprise, returns the
// originals — timing must never break because translation did.
async function translateBatch(texts: string[], to: string): Promise<string[]> {
  const params = new URLSearchParams({
    client: "gtx",
    sl: "en",
    tl: to,
    dt: "t",
  });
  for (const t of texts) params.append("q", t);
  const res = await fetch(
    `https://translate.googleapis.com/translate_a/single?${params.toString()}`,
    { headers: { "User-Agent": "Mozilla/5.0" } },
  );
  if (!res.ok) return texts;
  const data = await res.json().catch(() => null);
  if (!Array.isArray(data) || !Array.isArray(data[0])) return texts;
  // Multi-q shape: data[0][i][0] = translation of texts[i].
  if (data[0].length === texts.length) {
    return texts.map((orig, i) => {
      const entry = data[0][i];
      const tr = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : null;
      return tr && tr.trim() !== "" ? tr : orig;
    });
  }
  return texts;
}

async function translateVTT(vttUrl: string, to: string): Promise<string> {
  const res = await fetch(vttUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`fetch vtt: ${res.status}`);
  const cues = parseSubs(await res.text());
  const out: string[] = [];
  for (let i = 0; i < cues.length; i += 80) {
    const batch = cues.slice(i, i + 80).map((c) => c.text.replace(/\n+/g, " "));
    out.push(...(await translateBatch(batch, to)));
  }
  return toVTT(cues.map((c, i) => ({ ...c, text: out[i] ?? c.text })));
}

// Dual display: Arabic line + English line in one cue, timed by the
// English cue; Arabic-only cues (no English overlap) are appended.
// v12: the Arabic file is shifted by shiftMs before merging — the
// best (file, shift) is chosen by the caller from timing coverage,
// because the first Arabic file on OpenSubtitles is often the
// wrong-timed one (Naruto S1E1: first file 74% coverage, starts at
// 108s; second file 95%, starts at 4s).
function mergeVTT(engText: string, araText: string, shiftMs = 0): string {
  const eng = parseSubs(engText);
  const ara = parseSubs(araText).map((c) => ({ ...c, startMs: c.startMs + shiftMs, endMs: c.endMs + shiftMs }));
  const used = new Set<number>();
  const merged: Cue[] = [];
  for (const e of eng) {
    const parts: string[] = [];
    for (let i = 0; i < ara.length; i++) {
      if (used.has(i)) continue;
      const a = ara[i];
      if (a.startMs < e.endMs && a.endMs > e.startMs) {
        used.add(i);
        parts.push(a.text);
      }
    }
    merged.push({ ...e, text: parts.length > 0 ? `${parts.join(" ")}\n${e.text}` : e.text });
  }
  for (let i = 0; i < ara.length; i++) {
    if (!used.has(i)) merged.push(ara[i]);
  }
  merged.sort((a, b) => a.startMs - b.startMs);
  return toVTT(merged);
}

function vttResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export async function handleSubTranslate(url: URL): Promise<Response> {
  const src = url.searchParams.get("vtt") || url.searchParams.get("url") || "";
  const to = url.searchParams.get("to") || "ar";
  if (!src) return new Response("missing vtt param", { status: 400 });
  try {
    return vttResponse(await translateVTT(src, to));
  } catch (e) {
    return new Response(`translate failed: ${String(e).slice(0, 120)}`, { status: 502 });
  }
}

export async function handleSubMerge(url: URL): Promise<Response> {
  const eng = url.searchParams.get("eng") || "";
  // v12: accept several Arabic candidates; score each against the
  // English file by cue-overlap coverage (shifts -2s..+2s) and merge
  // the best-aligned one. A single ara param behaves as before.
  const aras = url.searchParams.getAll("ara").filter((a) => a.length > 0);
  if (!eng || aras.length === 0) return new Response("missing eng/ara params", { status: 400 });
  try {
    const engText = await fetch(eng, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => {
      if (!r.ok) throw new Error(`eng: ${r.status}`);
      return r.text();
    });
    const engCues = parseSubs(engText);
    const fetched: { text: string; idx: number }[] = [];
    for (let i = 0; i < aras.length; i++) {
      try {
        const t = await fetch(aras[i], { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => {
          if (!r.ok) throw new Error(`ara: ${r.status}`);
          return r.text();
        });
        fetched.push({ text: t, idx: i });
      } catch { /* skip un-fetchable candidates */ }
    }
    if (fetched.length === 0) return new Response("merge failed: ara: all failed", { status: 502 });
    let best = { text: fetched[0].text, idx: fetched[0].idx, shift: 0, cov: -1 };
    for (const f of fetched) {
      const araCues = parseSubs(f.text);
      for (let shift = -2000; shift <= 2000; shift += 500) {
        let cov = 0;
        for (const e of engCues) {
          for (const a of araCues) {
            if (a.startMs + shift < e.endMs && a.endMs + shift > e.startMs) { cov++; break; }
          }
        }
        if (cov > best.cov) best = { text: f.text, idx: f.idx, shift, cov };
      }
    }
    const resp = vttResponse(mergeVTT(engText, best.text, best.shift));
    resp.headers.set("X-Merge-Ara", `idx=${best.idx} shift=${best.shift} cov=${best.cov}/${engCues.length}`);
    return resp;
  } catch (e) {
    return new Response(`merge failed: ${String(e).slice(0, 120)}`, { status: 502 });
  }
}

// ---------- hosting: POST a VTT, get a short https URL ----------
// Why: the phone (not the server) is the only place that can fetch
// the site's own subtitle files (Cloudflare-walled from datacenter
// IPs), and the player only lists https URLs — data: URIs are
// dropped from the track list. So the addon merges/translates
// on-device, POSTs the finished VTT here, and emits the returned
// URL as a normal subtitle entry. Storage is Deno KV with a 24h
// TTL; values are chunked (KV limit is 64 KiB per value).
const STORE_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_CHUNK = 30000;

function storeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function handleSubStore(req: Request, base: URL): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("POST vtt text (raw, JSON {vtt}, or form vtt=)", { status: 405 });
  }
  const raw = await req.text();
  let text = raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      text = JSON.parse(trimmed).vtt ?? "";
    } catch {
      text = "";
    }
  } else if (trimmed.startsWith("vtt=")) {
    text = new URLSearchParams(trimmed).get("vtt") ?? "";
  }
  if (!text || text.length > 500000) {
    return new Response("bad vtt", { status: 400 });
  }
  const id = storeId();
  const kv = await Deno.openKv();
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += STORE_CHUNK) chunks.push(text.slice(i, i + STORE_CHUNK));
  await kv.set(["sub", id, "meta"], { n: chunks.length }, { expireIn: STORE_TTL_MS });
  for (let i = 0; i < chunks.length; i++) {
    await kv.set(["sub", id, i], chunks[i], { expireIn: STORE_TTL_MS });
  }
  kv.close();
  return new Response(JSON.stringify({ ok: true, url: `${base.origin}/s/${id}.vtt` }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export async function handleSubGet(id: string): Promise<Response> {
  // Stored URLs end with .vtt so players can detect the format
  // from the extension; strip it before the KV lookup.
  const cleanId = id.replace(/\.vtt$/i, "");
  if (!cleanId || /[^a-z0-9]/i.test(cleanId)) return new Response("not found", { status: 404 });
  const kv = await Deno.openKv();
  const meta = await kv.get<{ n: number }>(["sub", cleanId, "meta"]);
  if (!meta.value) {
    kv.close();
    return new Response("not found", { status: 404 });
  }
  let out = "";
  for (let i = 0; i < meta.value.n; i++) {
    const part = await kv.get<string>(["sub", cleanId, i]);
    if (part.value) out += part.value;
  }
  kv.close();
  return new Response(out, {
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
