import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "@/lib/auth/session";

/**
 * 034 — `GET /api/training/[id]/file`: Range → 206 con `Content-Range`, fuera
 * de límites → 416, sin Range → 200; siempre `Accept-Ranges` y cabeceras
 * seguras; PDF como descarga con nombre legible, video inline;
 * `Cache-Control: private`. El store va simulado (los bytes en memoria).
 */

const sessionState: { current: SessionContext | null } = { current: null };

vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    requireSession: async () => {
      if (!sessionState.current) throw new UnauthorizedError();
      return sessionState.current;
    },
  };
});

type Row = { id: string; kind: "document" | "video" | "help_image"; title: string; mimeType: string; storageProvider: "local" };
const files = new Map<string, { row: Row; data: Buffer }>();
const reads: string[] = [];

vi.mock("@/server/training/store", () => {
  class TrainingError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message?: string
    ) {
      super(message ?? code);
    }
  }
  return {
    TrainingError,
    openTrainingFile: async (org: string, id: string) => {
      const f = files.get(`${org}:${id}`);
      if (!f) return null;
      return {
        row: f.row,
        size: f.data.length,
        read: async (s: number, e: number) => {
          reads.push(`range ${s}-${e}`);
          return f.data.subarray(s, e + 1);
        },
        readAll: async () => {
          reads.push("all");
          return f.data;
        },
      };
    },
  };
});

const { GET } = await import("@/app/api/training/[id]/file/route");

const SELLER: SessionContext = { userId: "u_s", organizationId: "org_1", role: "member" };
const VIDEO = Buffer.alloc(1816, 1);
const PDF = Buffer.from("%PDF-1.4 ...");

function get(id: string, range?: string) {
  const req = new Request(`http://x/api/training/${id}/file`, {
    headers: range ? { range } : {},
  });
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  sessionState.current = SELLER;
  reads.length = 0;
  files.clear();
  files.set("org_1:tra_v", {
    row: { id: "tra_v", kind: "video", title: "La Bandeja", mimeType: "video/mp4", storageProvider: "local" },
    data: VIDEO,
  });
  files.set("org_1:tra_d", {
    row: { id: "tra_d", kind: "document", title: "Presentación del equipo", mimeType: "application/pdf", storageProvider: "local" },
    data: PDF,
  });
  files.set("org_1:tra_bad", {
    row: { id: "tra_bad", kind: "video", title: "x", mimeType: "image/png", storageProvider: "local" },
    data: VIDEO,
  });
});

describe("GET /api/training/[id]/file", () => {
  it("Range bytes=0-99 → 206 con Content-Range y Accept-Ranges (lectura parcial)", async () => {
    const res = await get("tra_v", "bytes=0-99");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-99/1816");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("cache-control")).toMatch(/^private/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    expect(reads).toEqual(["range 0-99"]);
  });

  it("bytes=0- → 206 hasta el final", async () => {
    const res = await get("tra_v", "bytes=0-");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-1815/1816");
  });

  it("rango fuera de límites → 416 con bytes */size", async () => {
    const res = await get("tra_v", "bytes=5000-6000");
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1816");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(reads).toEqual([]);
  });

  it("sin Range → 200 completo con Accept-Ranges", async () => {
    const res = await get("tra_v");
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("1816");
    expect(reads).toEqual(["all"]);
  });

  it("PDF → descarga con «título».pdf (ASCII + UTF-8)", async () => {
    const res = await get("tra_d");
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toMatch(/^attachment; filename="Presentacion del equipo\.pdf"; filename\*=UTF-8''Presentaci%C3%B3n%20del%20equipo\.pdf$/);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toMatch(/^private/);
  });

  it("de otra org o id imposible → 404; sin sesión → 401", async () => {
    sessionState.current = { ...SELLER, organizationId: "org_2" };
    expect((await get("tra_v")).status).toBe(404);
    sessionState.current = SELLER;
    expect((await get("..%2Fx")).status).toBe(404);
    sessionState.current = null;
    expect((await get("tra_v")).status).toBe(401);
  });

  it("MIME guardado que no es de su tipo → 415 blocked", async () => {
    const res = await get("tra_bad");
    expect(res.status).toBe(415);
  });
});
