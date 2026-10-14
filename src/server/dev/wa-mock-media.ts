/**
 * 018 — Binarios del wa-mock (solo entorno de pruebas). Antes devolvía el
 * texto "wa-mock-media": con la política de archivos (firma por magic bytes)
 * eso se bloquearía, así que ahora son bytes REALES del tipo que se declara.
 *
 * El id decide (lo comparten la metadata de Graph y la descarga, para que
 * `file_size` y `mime_type` cuadren con los bytes):
 *   - contiene `html` → HTML con <script> (para AC-4: "HTML declarado como PDF")
 *   - contiene `exe`  → ejecutable `MZ…`
 *   - si no, contiene `pdf` → PDF mínimo válido; si no → JPEG 1×1 válido.
 * El MIME DECLARADO sigue el criterio de siempre (`pdf` → application/pdf,
 * si no image/jpeg): un id `media-e2e-html-pdf` es HTML que dice ser PDF.
 */

/** JPEG 1×1 blanco (JFIF baseline). */
const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
  "base64"
);

/** PDF de una página en blanco, con su tabla xref calculada. */
function minimalPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const PDF_BYTES = minimalPdf();
const EXE_BYTES = Buffer.concat([
  Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
  Buffer.from("This program cannot be run in DOS mode.", "latin1"),
]);
const HTML_BYTES = Buffer.from(
  "<!doctype html><html><body><script>alert('wa-mock')</script></body></html>",
  "utf8"
);

/** MIME que el mock de Graph DECLARA para un media id. */
export function mockDeclaredMime(id: string): string {
  return id.includes("pdf") ? "application/pdf" : "image/jpeg";
}

/** Bytes que entrega la "URL efímera" del mock para un media id. */
export function mockMediaBytes(id: string): Buffer {
  if (id.includes("html")) return HTML_BYTES;
  if (id.includes("exe")) return EXE_BYTES;
  if (id.includes("pdf")) return PDF_BYTES;
  return JPEG_1X1;
}
