import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  IDS_MAX,
  decodeCursor,
  encodeCursor,
  inboxOrderBy,
  keysetCondition,
  parseIds,
  parseInboxQuery,
  parseLimit,
  sortKeySql,
} from "@/server/inbox/list-query";

/**
 * 06 (contrato 06-0): parseo tolerante de `GET /api/conversations`, cursor
 * opaco y el texto del ORDER BY, que debe coincidir con el índice de 0016.
 */

const dialect = new PgDialect();
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const params = (qs: string) => new URLSearchParams(qs);

describe("parseLimit (D-06-1)", () => {
  it("ausente o vacío → undefined (lista completa)", () => {
    expect(parseLimit(null)).toBeUndefined();
    expect(parseLimit("  ")).toBeUndefined();
  });
  it("ilegible → 50; fuera de rango → al borde [1, 200]", () => {
    expect(parseLimit("abc")).toBe(50);
    expect(parseLimit("0")).toBe(1);
    expect(parseLimit("-5")).toBe(1);
    expect(parseLimit("9999")).toBe(200);
    expect(parseLimit("30")).toBe(30);
  });
});

describe("cursor opaco", () => {
  const cur = { t: "2026-10-12 14:03:07.123456", i: "cv_abc" };

  it("ida y vuelta conserva los microsegundos", () => {
    expect(decodeCursor(encodeCursor(cur))).toEqual(cur);
  });

  it("basura, JSON ajeno o fecha sin µs → null (primera página)", () => {
    expect(decodeCursor("basura")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    const sinMicros = Buffer.from(
      JSON.stringify({ t: "2026-10-12T14:03:07.123Z", i: "cv_abc" })
    ).toString("base64url");
    expect(decodeCursor(sinMicros)).toBeNull();
    const sinId = Buffer.from(JSON.stringify({ t: cur.t })).toString("base64url");
    expect(decodeCursor(sinId)).toBeNull();
  });
});

describe("parseIds", () => {
  it("dedup, recorta vacíos y topa en IDS_MAX", () => {
    expect(parseIds("a, b,,a")).toEqual(["a", "b"]);
    expect(parseIds("")).toBeUndefined();
    expect(parseIds(null)).toBeUndefined();
    const many = Array.from({ length: 80 }, (_, i) => `cv_${i}`).join(",");
    expect(parseIds(many)).toHaveLength(IDS_MAX);
  });
});

describe("parseInboxQuery (tolerante)", () => {
  it("defaults sin parámetros", () => {
    expect(parseInboxQuery(params(""))).toEqual({
      limit: undefined,
      cursor: undefined,
      filter: "all",
      stageId: undefined,
      channel: undefined,
      origin: undefined,
      mine: false,
      unassigned: false,
      closing: false,
      q: undefined,
      ids: undefined,
      contactId: undefined,
      since: undefined,
    });
  });

  it("020: vista + filtros combinables; pastillas viejas → filtro equivalente", () => {
    expect(parseInboxQuery(params("filter=unread&origin=ad&unassigned=1&closing=true"))).toMatchObject({
      filter: "unread",
      origin: "ad",
      unassigned: true,
      closing: true,
    });
    expect(parseInboxQuery(params("filter=unassigned"))).toMatchObject({
      filter: "all",
      unassigned: true,
      closing: false,
    });
    expect(parseInboxQuery(params("filter=closing"))).toMatchObject({
      filter: "all",
      closing: true,
    });
    // 027: la vista vieja "Mías" → filtro `mine` (≡ assigned=me).
    expect(parseInboxQuery(params("filter=mine"))).toMatchObject({
      filter: "all",
      mine: true,
      unassigned: false,
    });
    // Tolerante: valores desconocidos = sin filtro.
    expect(parseInboxQuery(params("origin=organico&unassigned=quizas"))).toMatchObject({
      origin: undefined,
      unassigned: false,
    });
  });

  it("valores inválidos caen al default sin error", () => {
    const q = parseInboxQuery(
      params("filter=handoff&channel=telegram&cursor=xx&since=ayer&q=%20%20")
    );
    expect(q.filter).toBe("all");
    expect(q.channel).toBeUndefined();
    expect(q.cursor).toBeUndefined();
    expect(q.since).toBeUndefined();
    expect(q.q).toBeUndefined();
  });

  it("valores válidos pasan", () => {
    const q = parseInboxQuery(
      params("limit=20&filter=human&channel=instagram&stage=stg_1&q=Jos%C3%A9&contact=ct_1")
    );
    expect(q).toMatchObject({
      limit: 20,
      filter: "human",
      channel: "instagram",
      stageId: "stg_1",
      q: "José",
      contactId: "ct_1",
    });
  });
});

describe("SQL del orden y keyset", () => {
  it("ORDER BY con el mismo texto que el índice de 0016 (DESC, sin NULLS)", () => {
    const order = dialect.sqlToQuery(sql.join(inboxOrderBy, sql`, `)).sql;
    expect(order).toBe(
      'coalesce("conversation"."last_message_at", "conversation"."created_at") DESC, "conversation"."id" DESC'
    );
    const migration = readFileSync(
      path.join(ROOT, "drizzle", "0016_indices_bandeja.sql"),
      "utf8"
    );
    expect(migration).toContain(
      '(coalesce("last_message_at", "created_at")) DESC,"id" DESC'
    );
    const sentencias = migration
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(sentencias).toContain('CREATE INDEX IF NOT EXISTS "conversation_org_sort_idx"');
    expect(sentencias).not.toMatch(/NULLS LAST|CONCURRENTLY|WHERE/);
  });

  it("cursor sale de to_char con µs y el keyset es fila-valor", () => {
    expect(dialect.sqlToQuery(sortKeySql).sql).toContain("'YYYY-MM-DD HH24:MI:SS.US'");
    const k = dialect.sqlToQuery(
      keysetCondition({ t: "2026-10-12 14:03:07.123456", i: "cv_1" })
    );
    expect(k.sql).toBe(
      '(coalesce("conversation"."last_message_at", "conversation"."created_at"), "conversation"."id") < ($1::timestamp, $2)'
    );
    expect(k.params).toEqual(["2026-10-12 14:03:07.123456", "cv_1"]);
  });
});
