import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";

const TILES_DIR = join(import.meta.dir, "tiles");
const PUBLIC_DIR = join(import.meta.dir, "public");
const PORT = 3333;

const layers = new Map<string, Database>();

async function loadLayers() {
  let files: string[];
  try {
    files = await readdir(TILES_DIR);
  } catch {
    console.warn(
      `[warn] tiles/ directory not found at ${TILES_DIR}. Create it and add .mbtiles files.`,
    );
    return;
  }

  for (const file of files) {
    if (extname(file) !== ".mbtiles") continue;
    const name = basename(file, ".mbtiles");
    const db = new Database(join(TILES_DIR, file), { readonly: true });
    layers.set(name, db);
    console.log(`[info] Loaded layer: ${name}`);
  }
}

function getTile(
  db: Database,
  z: number,
  x: number,
  y: number,
): Uint8Array | null {
  const meta = getMetadata(db);
  const scheme = meta["scheme"] ?? "tms";
  // mbtiles default is TMS (row 0 = bottom); XYZ (slippy map) is top-down
  const tileRow = scheme === "tms" ? (1 << z) - 1 - y : y;

  const row = db
    .query<
      { tile_data: Uint8Array },
      [number, number, number]
    >("SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?")
    .get(z, x, tileRow);
  return row?.tile_data ?? null;
}

function getMetadata(db: Database): Record<string, string> {
  const rows = db
    .query<
      { name: string; value: string },
      []
    >("SELECT name, value FROM metadata")
    .all();
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CONTENT_TYPES: Record<string, string> = {
  pbf: "application/x-protobuf",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

async function router(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // List available layers + metadata
  if (path === "/layers") {
    const result: Record<string, unknown> = {};
    for (const [name, db] of layers) {
      const meta = getMetadata(db);
      result[name] = {
        format: meta["format"] ?? "pbf",
        minzoom: meta["minzoom"] ?? "0",
        maxzoom: meta["maxzoom"] ?? "14",
        bounds: meta["bounds"] ?? "-180,-85,180,85",
        center: meta["center"] ?? null,
        description: meta["description"] ?? null,
      };
    }
    return Response.json(result, { headers: CORS });
  }

  // Tile endpoint: /tiles/{name}/{z}/{x}/{y}.{ext}
  const tileMatch = path.match(
    /^\/tiles\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.(pbf|png|jpg|webp)$/,
  );
  if (tileMatch) {
    const [, name, zStr, xStr, yStr, ext] = tileMatch;
    const db = layers.get(name);

    if (!db) {
      return new Response(`Layer "${name}" not found`, {
        status: 404,
        headers: CORS,
      });
    }

    const tileData = getTile(
      db,
      parseInt(zStr, 10),
      parseInt(xStr, 10),
      parseInt(yStr, 10),
    );

    if (!tileData) {
      // 204 = tile exists in server but not in data; MapLibre handles this silently
      return new Response(null, { status: 204, headers: CORS });
    }

    const headers: Record<string, string> = {
      ...CORS,
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    };

    // Vector tiles in mbtiles are gzip-compressed; pass raw bytes with encoding header
    if (ext === "pbf") {
      headers["Content-Encoding"] = "gzip";
    }

    return new Response(tileData, { status: 200, headers });
  }

  // Static files from public/
  const filePath = path === "/" ? "/index.html" : path;
  const staticFile = Bun.file(join(PUBLIC_DIR, filePath));

  if (await staticFile.exists()) {
    return new Response(staticFile);
  }

  return new Response("Not Found", { status: 404 });
}

await loadLayers();

Bun.serve({
  port: PORT,
  fetch: router,
  error(err) {
    console.error("[error]", err);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`\n[info] Tile server running at http://localhost:${PORT}`);
console.log(
  `[info] Layers loaded: ${[...layers.keys()].join(", ") || "(none — add .mbtiles files to tiles/)"}`,
);
console.log(
  `[info] Endpoints: GET /layers  |  GET /tiles/{name}/{z}/{x}/{y}.{pbf|png|jpg}\n`,
);
