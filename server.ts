import { S3Client } from "@aws-sdk/client-s3";
import { join } from "node:path";
import { PMTiles, TileType } from "pmtiles";
import { S3Source } from "./s3-source.ts";

const PUBLIC_DIR = join(import.meta.dir, "public");
const PORT = 3333;
const LAYER_NAME = process.env.LAYER_NAME ?? "tiles";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const S3_ENDPOINT = requireEnv("S3_ENDPOINT");
const S3_REGION = requireEnv("S3_REGION");
const S3_BUCKET = requireEnv("S3_BUCKET");
const S3_KEY = requireEnv("S3_KEY");
const S3_ACCESS_KEY_ID = requireEnv("S3_ACCESS_KEY_ID");
const S3_SECRET_ACCESS_KEY = requireEnv("S3_SECRET_ACCESS_KEY");

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const s3Client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
});

const pmtiles = new PMTiles(new S3Source(s3Client, S3_BUCKET, S3_KEY));

const EXT_BY_TILE_TYPE: Record<number, string> = {
  [TileType.Mvt]: "pbf",
  [TileType.Png]: "png",
  [TileType.Jpeg]: "jpg",
  [TileType.Webp]: "webp",
};

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  pbf: "application/x-protobuf",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

async function router(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const cors = corsHeaders(req.headers.get("Origin"));

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // List the layer + metadata
  if (path === "/layers") {
    const header = await pmtiles.getHeader();
    const ext = EXT_BY_TILE_TYPE[header.tileType] ?? "pbf";
    const result = {
      [LAYER_NAME]: {
        format: ext,
        minzoom: String(header.minZoom),
        maxzoom: String(header.maxZoom),
        bounds: `${header.minLon},${header.minLat},${header.maxLon},${header.maxLat}`,
        center: `${header.centerLon},${header.centerLat},${header.centerZoom}`,
      },
    };
    return Response.json(result, { headers: cors });
  }

  // Tile endpoint: /tiles/{name}/{z}/{x}/{y}.{ext}
  const tileMatch = path.match(
    /^\/tiles\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.(pbf|png|jpg|webp)$/,
  );
  if (tileMatch) {
    const [, name, zStr, xStr, yStr, ext] = tileMatch;

    if (name !== LAYER_NAME) {
      return new Response(`Layer "${name}" not found`, {
        status: 404,
        headers: cors,
      });
    }

    const tile = await pmtiles.getZxy(
      parseInt(zStr, 10),
      parseInt(xStr, 10),
      parseInt(yStr, 10),
    );

    if (!tile) {
      // 204 = tile exists in zoom range but not in data; MapLibre handles this silently
      return new Response(null, { status: 204, headers: cors });
    }

    const headers: Record<string, string> = {
      ...cors,
      "Content-Type": CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    };

    return new Response(tile.data, { status: 200, headers });
  }

  // Static files from public/
  const filePath = path === "/" ? "/index.html" : path;
  const staticFile = Bun.file(join(PUBLIC_DIR, filePath));

  if (await staticFile.exists()) {
    return new Response(staticFile);
  }

  return new Response("Not Found", { status: 404 });
}

Bun.serve({
  port: PORT,
  fetch: router,
  error(err) {
    console.error("[error]", err);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`\n[info] Tile server running at http://localhost:${PORT}`);
console.log(`[info] Layer: ${LAYER_NAME} (s3://${S3_BUCKET}/${S3_KEY})`);
console.log(
  `[info] Endpoints: GET /layers  |  GET /tiles/${LAYER_NAME}/{z}/{x}/{y}.{pbf|png|jpg|webp}\n`,
);
