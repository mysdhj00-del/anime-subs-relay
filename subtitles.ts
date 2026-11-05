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
      text: body,
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
function mergeVTT(engText: string, araText: string): string {
  const eng = parseSubs(engText);
  const ara = parseSubs(araText);
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
  const ara = url.searchParams.get("ara") || "";
  if (!eng || !ara) return new Response("missing eng/ara params", { status: 400 });
  try {
    const [engText, araText] = await Promise.all([
      fetch(eng, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => {
        if (!r.ok) throw new Error(`eng: ${r.status}`);
        return r.text();
      }),
      fetch(ara, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => {
        if (!r.ok) throw new Error(`ara: ${r.status}`);
        return r.text();
      }),
    ]);
    return vttResponse(mergeVTT(engText, araText));
  } catch (e) {
    return new Response(`merge failed: ${String(e).slice(0, 120)}`, { status: 502 });
  }
}
