// Open Jobs stopped running on 2026-10-10 (the Cloudflare bill). This is the Worker that stays deployed:
//   - every Durable Object class is kept so no data is deleted, but each is a stub: an alarm that fires deletes
//     itself and never re-arms, and a request gets 410. The crawler fleet (one Board object per career site) goes
//     quiet after each board's next alarm. No crons, no containers, no assets.
//   - GET /data/* still serves the published snapshot from the R2 bucket (Range supported) so the last export,
//     the archive tar and the search index stay downloadable. Everything else answers 410 with a plain notice.
// To run the project again: point `main` back at src/index.ts and restore the containers, assets, triggers
// and services blocks in wrangler.jsonc (git history has them), then redeploy with scripts/cloud-deploy.sh.
import { DurableObject } from "cloudflare:workers";
import { dataIndex } from "./dataindex";

type Env = { DATA: R2Bucket };

const STOPPED = "Open Jobs stopped running on 10 October 2026. The last snapshot (5 October 2026) stays under /data/. Source: https://github.com/elliottdehn/open-jobs";

class Stopped extends DurableObject {
	async alarm(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
	}
	async fetch(): Promise<Response> {
		return new Response(STOPPED, { status: 410 });
	}
}
export class Board extends Stopped {}
export class Registry extends Stopped {}
export class RateLimit extends Stopped {}
export class Budget extends Stopped {}
export class Lock extends Stopped {}
export class Stats extends Stopped {}
export class Dedupe extends Stopped {}
export class Consolidate extends Stopped {}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open Jobs has stopped</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;max-width:40em;margin:4em auto;padding:0 1.2em;color:#152019}a{color:#177A45}</style>
<h1>Open Jobs is no longer running</h1>
<p>The crawler and this search page were shut down on 10 October 2026. Running them cost more than a free project
with no business model could carry.</p>
<p>The last snapshot, built 5 October 2026, stays downloadable: the <a href="/data/exports/open-jobs-latest.tar">full export</a>
(one parquet file per applicant tracking system, about 31 GB with descriptions and embeddings) and the
<a href="/data/">search index and every other published file</a>.</p>
<p>The code is at <a href="https://github.com/elliottdehn/open-jobs">github.com/elliottdehn/open-jobs</a> for anyone who wants to run their own.</p>
`;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "*", "access-control-expose-headers": "*" };
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
		const parts = url.pathname.split("/").filter(Boolean);

		if (parts.length === 0 || url.pathname === "/index.html") {
			return new Response(PAGE, { status: 200, headers: { ...cors, "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } });
		}
		if (parts[0] === "data" && parts.length === 1 && request.method === "GET") return dataIndex(env, cors);
		// GET /data/exports/[<date>/[jobs/|boards/]]  -> JSON listing of that prefix
		if (parts[0] === "data" && parts[1] === "exports" && url.pathname.endsWith("/") && request.method === "GET") {
			const prefix = parts.slice(1).join("/") + "/";
			const r = await env.DATA.list({ prefix, delimiter: "/" });
			const body = { prefix, dirs: r.delimitedPrefixes.map((d) => d.slice(prefix.length)), files: r.objects.map((o) => ({ file: o.key.slice(prefix.length), bytes: o.size })) };
			return Response.json(body, { headers: { ...cors, "cache-control": "public, max-age=3600" } });
		}
		// GET /data/<key>  -> object from the R2 bucket, with Range support
		if (parts[0] === "data" && parts.length >= 2 && (request.method === "GET" || request.method === "HEAD")) {
			const key = parts.slice(1).join("/");
			const range = request.headers.get("range");
			const obj = request.method === "HEAD" ? await env.DATA.head(key) : await env.DATA.get(key, { range: range ? request.headers : undefined });
			if (!obj) return new Response("not found", { status: 404, headers: cors });
			const headers = new Headers(cors);
			obj.writeHttpMetadata(headers);
			headers.set("etag", obj.httpEtag);
			headers.set("accept-ranges", "bytes");
			headers.set("cache-control", "public, max-age=3600");
			if ((request.headers.get("if-none-match") || "").split(",").some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === obj.httpEtag.replace(/^W\//, ""))) return new Response(null, { status: 304, headers });
			const body = (obj as R2ObjectBody).body;
			if (!body) { headers.set("content-length", String(obj.size)); return new Response(null, { headers }); }
			if (range && obj.range && "offset" in obj.range && obj.range.offset !== undefined) {
				const offset = obj.range.offset;
				const end = offset + (obj.range.length ?? obj.size - offset) - 1;
				headers.set("content-range", `bytes ${offset}-${end}/${obj.size}`);
				headers.set("content-length", String(end - offset + 1));
				return new Response(body, { status: 206, headers });
			}
			headers.set("content-length", String(obj.size));
			return new Response(body, { headers });
		}
		return new Response(STOPPED, { status: 410, headers: { ...cors, "content-type": "text/plain; charset=utf-8" } });
	},
};
