/**
 * 019 — Lógica pura de la página Catálogo (sin React) para probarla en unit:
 * filtro, portada, agrupación de archivos, reordenamiento, atributos del
 * formulario y mensajes de error de la API.
 */

import type {
  CatalogFileDto,
  CatalogProductDto,
  CatalogVariantDto,
  ProductAttribute,
} from "@/lib/catalog";

/** Filtro de categoría: todas, una concreta o "sin categoría". */
export type CategoryFilter = "all" | "none" | string;

/**
 * Productos que pasan la búsqueda (nombre o código del producto o de alguna
 * variante, sin distinguir mayúsculas ni acentos) y el filtro de categoría.
 */
export function filterProducts(
  products: readonly CatalogProductDto[],
  query: string,
  category: CategoryFilter
): CatalogProductDto[] {
  const q = fold(query.trim());
  return products.filter((p) => {
    if (category === "none" && p.categoryId !== null) return false;
    if (category !== "all" && category !== "none" && p.categoryId !== category) {
      return false;
    }
    if (!q) return true;
    const haystack = [p.name, p.code, ...p.variants.flatMap((v) => [v.name, v.code])];
    return haystack.some((s) => s != null && fold(s).includes(q));
  });
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function byPosition(a: CatalogFileDto, b: CatalogFileDto) {
  return a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Portada de la tarjeta: la primera imagen compartida o, si no hay, cualquiera. */
export function coverImage(product: Pick<CatalogProductDto, "files">): CatalogFileDto | undefined {
  const images = product.files.filter((f) => f.kind === "image").sort(byPosition);
  return images.find((f) => f.variantId === null) ?? images[0];
}

export type FileGroup = {
  /** null = compartidos por todas las variantes. */
  variantId: string | null;
  label: string;
  files: CatalogFileDto[];
};

/**
 * Archivos agrupados para el detalle: primero "Compartidos" (siempre, aunque
 * esté vacío) y luego uno por variante, en el orden de las variantes. Un
 * archivo cuya variante ya no viene en la lista cae en "Compartidos".
 */
export function groupFiles(
  product: Pick<CatalogProductDto, "files" | "variants">
): FileGroup[] {
  const ids = new Set(product.variants.map((v) => v.id));
  const sorted = [...product.files].sort(byPosition);
  const shared = sorted.filter((f) => f.variantId === null || !ids.has(f.variantId));
  const variants = [...product.variants].sort(
    (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)
  );
  return [
    { variantId: null, label: "Compartidos", files: shared },
    ...variants.map((v) => ({
      variantId: v.id,
      label: v.name,
      files: sorted.filter((f) => f.variantId === v.id),
    })),
  ];
}

/**
 * Mover el elemento `index` de una lista (ya ordenada) un lugar arriba (-1) o
 * abajo (+1). Se reparten las MISMAS posiciones que ya tenía la lista en el
 * nuevo orden —solo cambian los dos vecinos, y nada se mueve respecto de
 * archivos que no están en la lista—. Si había posiciones repetidas (datos
 * viejos) se renumera 0..n-1 para que el cambio se note. Devuelve solo los
 * PATCH de quien cambió; vacío si no hay a dónde moverse.
 */
export function swapPositions(
  items: ReadonlyArray<{ id: string; position: number }>,
  index: number,
  dir: -1 | 1
): Array<{ id: string; position: number }> {
  const a = items[index];
  const b = items[index + dir];
  if (!a || !b) return [];
  const order = [...items];
  order[index] = b;
  order[index + dir] = a;
  const slots = items.map((i) => i.position).sort((x, y) => x - y);
  const distinct = new Set(slots).size === slots.length;
  return order
    .map((item, i) => ({
      id: item.id,
      position: distinct ? (slots[i] ?? i) : i,
      before: item.position,
    }))
    .filter((p) => p.position !== p.before)
    .map(({ id, position }) => ({ id, position }));
}

/** Fila editable de atributo (las vacías se descartan al guardar). */
export type AttributeRow = { label: string; value: string };

/**
 * Atributos listos para la API: sin espacios de sobra y sin filas a medias
 * (la API exige label y value de al menos un carácter). Devuelve también si
 * se descartó alguna fila con solo uno de los dos campos, para avisar.
 */
export function cleanAttributes(rows: readonly AttributeRow[]): {
  attributes: ProductAttribute[];
  incomplete: boolean;
} {
  const attributes: ProductAttribute[] = [];
  let incomplete = false;
  for (const r of rows) {
    const label = r.label.trim();
    const value = r.value.trim();
    if (label && value) attributes.push({ label, value });
    else if (label || value) incomplete = true;
  }
  return { attributes, incomplete };
}

/** Precio a mostrar de una variante: el suyo o el heredado del producto. */
export function variantPrice(
  product: Pick<CatalogProductDto, "price">,
  variant: Pick<CatalogVariantDto, "price">
): { text: string | null; inherited: boolean } {
  if (variant.price) return { text: variant.price, inherited: false };
  return { text: product.price, inherited: true };
}

/** Tamaño legible ("320 KB", "1.4 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ApiErrorBody = { error?: { code?: string; message?: string } } | null;

/**
 * Mensaje para la UI de una respuesta fallida de `/api/catalog/*`. El
 * servidor ya manda razones legibles (415 tipo, 413 tamaño, 409 tope o
 * código duplicado, 503 storage); aquí solo se cubren el "sin red" y los
 * casos sin mensaje.
 */
export function catalogErrorText(
  status: number | null,
  body: ApiErrorBody,
  fallback: string
): string {
  if (status === null) return "Sin conexión con el servidor";
  const message = body?.error?.message;
  if (message) return message;
  switch (status) {
    case 403:
      return "Solo el Propietario puede editar el catálogo";
    case 404:
      return "Ya no existe. Recarga la página.";
    case 413:
      return "El archivo es demasiado grande";
    case 415:
      return "Tipo de archivo no admitido";
    case 503:
      return "El almacenamiento del catálogo no está disponible";
    default:
      return fallback;
  }
}

export async function responseError(res: Response | null, fallback: string): Promise<string> {
  if (!res) return catalogErrorText(null, null, fallback);
  const body = (await res.json().catch(() => null)) as ApiErrorBody;
  return catalogErrorText(res.status, body, fallback);
}

export type ShortcutOutcome = {
  shortcut: string;
  status: "created" | "exists" | "error";
  message: string;
};

/**
 * Resultado de un `POST /api/quick-replies` de "Crear atajos" (FR-924): 409
 * `duplicate_shortcut` no es un fallo —el atajo ya existía y no se toca—;
 * cualquier otro error se muestra con el mensaje del servidor.
 */
export function shortcutOutcome(
  shortcut: string,
  status: number | null,
  body: ApiErrorBody
): ShortcutOutcome {
  if (status !== null && status >= 200 && status < 300) {
    return { shortcut, status: "created", message: `Creado /${shortcut}` };
  }
  if (status === 409 && body?.error?.code === "duplicate_shortcut") {
    return { shortcut, status: "exists", message: `Ya existía /${shortcut} (no se tocó)` };
  }
  return {
    shortcut,
    status: "error",
    message: `/${shortcut}: ${catalogErrorText(status, body, "no se pudo crear")}`,
  };
}

/** Petición JSON a la API del catálogo; `null` si no hubo red. */
export function sendJson(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown
): Promise<Response | null> {
  return fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
}
