import type { getDb } from "@/lib/db";

/**
 * 023 — El ejecutor de las lecturas/escrituras de agenda: la conexión normal o
 * la transacción que sostiene el candado por organización. Las funciones que
 * corren DENTRO del candado lo reciben como último parámetro opcional.
 */
type Db = ReturnType<typeof getDb>;
export type AgendaTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type AgendaDb = Db | AgendaTx;
