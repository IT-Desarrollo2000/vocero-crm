/**
 * 032 — Catálogo «que se explica solo». Puro: lo usan
 * `src/components/catalog/catalog-client.tsx` y `product-detail.tsx`, y lo
 * cubre `tests/unit/catalog-readiness.test.ts`.
 *
 * Dado un producto y los atajos de `/api/quick-replies`, decide si está
 * «Listo para mandar», qué «Le falta: …» o si está «Pausado: no se puede
 * mandar». La regla sale de lo que hace de verdad la Bandeja:
 *
 * - Un producto INACTIVO no aparece en el botón «Catálogo»
 *   (`inbox/catalog-panel.tsx`) y sus atajos se ocultan del compositor
 *   (`inbox/catalog-staging.ts`): pausado gana a todo.
 * - Solo salen los archivos compartidos y los de variantes ACTIVAS
 *   (`filesForAttach`): un archivo de una variante pausada no cuenta.
 * - El envío (`server/catalog/send.ts`) no exige precio ni código; el precio
 *   lo pone «Insertar detalles» y el código hace falta para «Crear atajos»
 *   (`defaultShortcutsFor`, tope `SHORTCUT_CODE_MAX`).
 * - La ficha es recomendable, no imprescindible: sin ella el cliente recibe
 *   solo las fotos. Por eso cuenta como faltante en la tarjeta, pero no en
 *   «N productos no se pueden mandar completos» del resumen.
 */

import {
  SHORTCUT_CODE_MAX,
  defaultShortcutsFor,
  filesForAttach,
  type CatalogProductDto,
  type QuickReplyAttach,
} from "@/lib/catalog";

export type ReadinessProduct = Pick<
  CatalogProductDto,
  "id" | "name" | "code" | "price" | "active" | "variants" | "files"
>;

/** Lo mínimo de un atajo de `GET /api/quick-replies`. */
export type ShortcutRef = {
  shortcut: string;
  productId: string | null;
  attach: QuickReplyAttach | null;
};

export type MissingItem = "fotos" | "precio" | "codigo" | "codigo_largo" | "atajos" | "ficha";

export type ReadinessState = "ready" | "missing" | "paused";
export type ReadinessTone = "success" | "warning" | "danger" | "muted";

export type ReadinessCheck = {
  id: "fotos" | "ficha" | "precio" | "activo" | "atajos";
  ok: boolean;
  text: string;
};

/** Atajo ligado al producto, con lo que manda dicho en palabras. */
export type ProductShortcut = {
  shortcut: string;
  attach: QuickReplyAttach | null;
  /** «las 2 fotos», «la ficha», «solo el texto (aún no tiene ficha)». */
  sends: string;
};

export type ProductReadiness = {
  state: ReadinessState;
  tone: ReadinessTone;
  /** Texto de la etiqueta de la tarjeta. */
  label: string;
  /** En orden de importancia. Vacío si está listo (o pausado sin faltantes). */
  missing: MissingItem[];
  /** Fotos y fichas que de verdad salen (compartidas + variantes activas). */
  images: number;
  documents: number;
  /** Atajos ligados a este producto; null = no se pudieron leer. */
  shortcuts: ProductShortcut[] | null;
  /** «¿Listo para mandar?» del detalle (Propietario). */
  checks: ReadinessCheck[];
};

export const READY_LABEL = "Listo para mandar";
export const PAUSED_LABEL = "Pausado: no se puede mandar";

const MISSING_LABEL: Record<MissingItem, string> = {
  fotos: "fotos",
  precio: "precio",
  codigo: "código",
  codigo_largo: "código más corto",
  atajos: "atajos",
  ficha: "ficha PDF",
};

/** Frase para el resumen: «Mesa de centro no tiene código, así que…». */
const MISSING_PHRASE: Record<MissingItem, string> = {
  fotos: "no tiene fotos",
  precio: "no tiene precio",
  codigo: "no tiene código, así que no tiene atajo para escribirlo en el chat",
  codigo_largo: `tiene un código de más de ${SHORTCUT_CODE_MAX} caracteres, así que no cabe en un atajo`,
  atajos: "no tiene atajos todavía (créalos desde su detalle)",
  ficha: "no tiene ficha PDF",
};

/** Por qué no se puede mandar un producto pausado, según quién mira. */
export function pausedExplanation(canEdit: boolean): string {
  return canEdit
    ? "Lo pausaste: no aparece en «Catálogo» dentro del chat ni en sus atajos. Para volver a mandarlo, actívalo en «Editar»."
    : "El propietario lo pausó (por ejemplo, porque se agotó). No aparece en «Catálogo» dentro del chat.";
}

/** Variante pausada, en palabras. */
export const PAUSED_VARIANT_TEXT = "Pausada: no aparece en el chat";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** «a», «a y b», «a, b y c». */
export function joinY(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

/** Lo que manda un atajo, contado con los archivos que salen de verdad. */
function shortcutSends(product: ReadinessProduct, attach: QuickReplyAttach | null): string {
  if (!attach) return "solo el texto";
  const n = filesForAttach(product, attach).length;
  if (attach === "images") {
    if (n === 0) return "solo el texto (aún no tiene fotos)";
    return n === 1 ? "la foto" : `las ${n} fotos`;
  }
  if (attach === "documents") {
    if (n === 0) return "solo el texto (aún no tiene ficha)";
    return n === 1 ? "la ficha" : `las ${n} fichas`;
  }
  if (n === 0) return "solo el texto (aún no tiene archivos)";
  return n === 1 ? "el archivo" : `los ${n} archivos`;
}

/** Un producto tiene precio si lo tiene él o alguna variante activa. */
function priceText(product: ReadinessProduct): string | null {
  const own = product.price?.trim();
  if (own) return own;
  const byVariant = product.variants.some((v) => v.active && v.price?.trim());
  return byVariant ? "según la variante" : null;
}

/**
 * Estado de un producto. `shortcuts` es la lista completa de
 * `/api/quick-replies` (se filtra aquí por `productId`); null = no se pudo
 * leer, y entonces no se acusa un falso «Le falta: atajos».
 */
export function productReadiness(
  product: ReadinessProduct,
  shortcuts: readonly ShortcutRef[] | null
): ProductReadiness {
  const images = filesForAttach(product, "images").length;
  const documents = filesForAttach(product, "documents").length;
  const price = priceText(product);

  const linked =
    shortcuts === null
      ? null
      : shortcuts
          .filter((s) => s.productId === product.id)
          .map((s) => ({
            shortcut: s.shortcut,
            attach: s.attach,
            sends: shortcutSends(product, s.attach),
          }));

  const code = product.code?.trim() ?? "";
  let shortcutGap: MissingItem | null = null;
  if (linked !== null && linked.length === 0) {
    if (!code) shortcutGap = "codigo";
    else if (!defaultShortcutsFor(product)) shortcutGap = "codigo_largo";
    else shortcutGap = "atajos";
  }

  const missing: MissingItem[] = [];
  if (images === 0) missing.push("fotos");
  if (!price) missing.push("precio");
  if (shortcutGap) missing.push(shortcutGap);
  if (documents === 0) missing.push("ficha");

  const checks: ReadinessCheck[] = [
    images > 0
      ? { id: "fotos", ok: true, text: plural(images, "foto", "fotos") }
      : {
          id: "fotos",
          ok: false,
          text:
            documents > 0
              ? "Sin fotos: el cliente solo recibe la ficha."
              : "Sin fotos ni ficha: no hay nada que mandarle al cliente.",
        },
    price
      ? { id: "precio", ok: true, text: `Precio: ${price}` }
      : {
          id: "precio",
          ok: false,
          text: "Sin precio: «Insertar detalles» no le dirá cuánto cuesta.",
        },
    product.active
      ? { id: "activo", ok: true, text: "Visible en el chat (está activo)" }
      : {
          id: "activo",
          ok: false,
          text: "Pausado: no aparece en «Catálogo» ni en los atajos del chat.",
        },
  ];
  if (linked !== null) {
    checks.push(
      linked.length > 0
        ? {
            id: "atajos",
            ok: true,
            text: `Atajos: ${linked.map((s) => `/${s.shortcut}`).join(", ")}`,
          }
        : shortcutGap === "codigo"
          ? {
              id: "atajos",
              ok: false,
              text: "Sin código: no se le pueden crear atajos.",
            }
          : shortcutGap === "codigo_largo"
            ? {
                id: "atajos",
                ok: false,
                text: `El código pasa de ${SHORTCUT_CODE_MAX} caracteres y no cabe en un atajo.`,
              }
            : {
                id: "atajos",
                ok: false,
                text: "Sin atajos todavía.",
              }
    );
  }
  checks.push(
    documents > 0
      ? { id: "ficha", ok: true, text: plural(documents, "ficha", "fichas") }
      : {
          id: "ficha",
          ok: false,
          text:
            images > 0
              ? "Sin ficha PDF: el cliente solo recibe las fotos."
              : "Sin ficha PDF.",
        }
  );

  if (!product.active) {
    return {
      state: "paused",
      tone: "muted",
      label: PAUSED_LABEL,
      missing,
      images,
      documents,
      shortcuts: linked,
      checks,
    };
  }
  if (missing.length === 0) {
    return {
      state: "ready",
      tone: "success",
      label: READY_LABEL,
      missing,
      images,
      documents,
      shortcuts: linked,
      checks,
    };
  }
  const label =
    missing.length === 1 && missing[0] === "fotos"
      ? "Le faltan las fotos"
      : `Le falta: ${joinY(missing.map((m) => MISSING_LABEL[m]))}`;
  return {
    state: "missing",
    tone: missing.includes("fotos") ? "danger" : "warning",
    label,
    missing,
    images,
    documents,
    shortcuts: linked,
    checks,
  };
}

/** ¿Este faltante impide mandarlo «completo»? La ficha no (ver cabecera). */
function isBlocking(m: MissingItem): boolean {
  return m !== "ficha";
}

export type CatalogSummary = {
  /** Productos activos (los pausados no cuentan en lo demás). */
  active: number;
  ready: number;
  /** Activos con algún faltante (incluye «solo le falta la ficha»). */
  withMissing: number;
  /** Activos con un faltante que no es la ficha. */
  incomplete: number;
  /** Activos a los que solo les falta la ficha. */
  onlyFicha: number;
  paused: number;
  /** null si no hay nada que avisar. */
  headline: string | null;
  /** «Comedor Roble no tiene fotos · Mesa de centro no tiene código…». */
  details: string[];
  /** Cuántos incompletos quedaron fuera de `details`. */
  more: number;
  /** Nota aparte para los que solo no tienen ficha. */
  fichaNote: string | null;
};

/**
 * Resumen para la lista del Propietario: cuántos están listos y cuántos
 * tienen faltantes, con el detalle de los primeros `maxDetails`.
 */
export function catalogSummary(
  items: ReadonlyArray<{ product: Pick<ReadinessProduct, "name">; readiness: ProductReadiness }>,
  maxDetails = 3
): CatalogSummary {
  const active = items.filter((i) => i.readiness.state !== "paused");
  const paused = items.length - active.length;
  const ready = active.filter((i) => i.readiness.state === "ready").length;
  const withMissing = active.filter((i) => i.readiness.state === "missing");
  const incomplete = withMissing.filter((i) => i.readiness.missing.some(isBlocking));
  const onlyFicha = withMissing.length - incomplete.length;

  const details = incomplete.slice(0, maxDetails).map((i) => {
    const phrases = i.readiness.missing.filter(isBlocking).map((m) => MISSING_PHRASE[m]);
    return `${i.product.name} ${joinY(phrases)}`;
  });

  const headline =
    incomplete.length > 0
      ? incomplete.length === 1
        ? "1 producto no se puede mandar completo todavía"
        : `${incomplete.length} productos no se pueden mandar completos todavía`
      : null;

  const fichaNote =
    onlyFicha > 0
      ? onlyFicha === 1
        ? "A 1 producto solo le falta la ficha PDF: el cliente recibe las fotos."
        : `A ${onlyFicha} productos solo les falta la ficha PDF: el cliente recibe las fotos.`
      : null;

  return {
    active: active.length,
    ready,
    withMissing: withMissing.length,
    incomplete: incomplete.length,
    onlyFicha,
    paused,
    headline,
    details,
    more: Math.max(0, incomplete.length - details.length),
    fichaNote,
  };
}

export type DefaultShortcutStatus = "linked" | "taken" | "missing";

export type DefaultShortcutState = {
  shortcut: string;
  attach: QuickReplyAttach;
  status: DefaultShortcutStatus;
  /** «Ya existe» · «Ese atajo ya lo usa otra respuesta» · «Falta crearlo». */
  text: string;
};

/**
 * Estado ANTES del clic de cada atajo que haría «Crear atajos»
 * (`/fotos_<código>`, `/ficha_<código>`): ya ligado a este producto, ocupado
 * por otra respuesta (el POST respondería «Ya existía … (no se tocó)») o por
 * crear. null si el producto no admite atajos (sin código o código largo) o
 * si la lista de atajos no se pudo leer.
 */
export function defaultShortcutStates(
  product: Pick<ReadinessProduct, "id" | "name" | "code">,
  shortcuts: readonly ShortcutRef[] | null
): DefaultShortcutState[] | null {
  const defaults = defaultShortcutsFor(product);
  if (!defaults || shortcuts === null) return null;
  return defaults.map((d) => {
    const found = shortcuts.find((s) => s.shortcut === d.shortcut);
    const status: DefaultShortcutStatus = !found
      ? "missing"
      : found.productId === product.id
        ? "linked"
        : "taken";
    const text =
      status === "linked"
        ? "Ya existe"
        : status === "taken"
          ? "Ese atajo ya lo usa otra respuesta rápida"
          : "Falta crearlo";
    return { shortcut: d.shortcut, attach: d.attach, status, text };
  });
}

/** «2 fotos y 1 ficha», «3 fotos», «1 ficha»; null si no hay nada que mandar. */
export function filesSummary(images: number, documents: number): string | null {
  const parts = [
    images > 0 ? plural(images, "foto", "fotos") : null,
    documents > 0 ? plural(documents, "ficha", "fichas") : null,
  ].filter((s): s is string => s !== null);
  return parts.length > 0 ? joinY(parts) : null;
}
