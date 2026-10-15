/**
 * 019 (15-oct) — Imágenes de prueba generadas DENTRO del navegador de
 * Playwright (canvas), para ejercer la conversión a JPG del lado cliente sin
 * fixtures binarios en el repo. Lo usan e2e-catalogo y e2e-adjuntos-ui.
 *
 * Devuelve objetos listos para `setInputFiles` (`{ name, mimeType, buffer }`).
 */

/** WebP pequeño con transparencia (debe salir JPEG con fondo blanco). */
export async function browserWebp(page, name) {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 480;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 640, 480);
    grad.addColorStop(0, "#25D366");
    grad.addColorStop(1, "rgba(0, 0, 255, 0.3)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 640, 480);
    const blob = await new Promise((r) => c.toBlob(r, "image/webp", 0.9));
    if (!blob || blob.type !== "image/webp") throw new Error(`el navegador no codifica WebP (${blob?.type})`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return { name, mimeType: "image/webp", buffer: Buffer.from(b64, "base64") };
}

/**
 * PNG de ruido aleatorio opaco (peor caso para JPEG): `side`×`side`, pesa
 * bastante más de 5 MB (3000 px ≈ 27 MB).
 */
export async function browserNoisePng(page, name, side = 3000) {
  const b64 = await page.evaluate(async (n) => {
    const c = document.createElement("canvas");
    c.width = n;
    c.height = n;
    const g = c.getContext("2d");
    const img = g.createImageData(n, n);
    const a = img.data;
    for (let i = 0; i < a.length; i += 65536) crypto.getRandomValues(a.subarray(i, Math.min(i + 65536, a.length)));
    for (let i = 3; i < a.length; i += 4) a[i] = 255;
    g.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, side);
  return { name, mimeType: "image/png", buffer: Buffer.from(b64, "base64") };
}

/** "HEIC" que ningún navegador decodifica (bytes basura). */
export function garbageHeic(name) {
  const junk = Buffer.alloc(4096);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919 + 13) & 0xff;
  return { name, mimeType: "image/heic", buffer: junk };
}

/** Lee el tamaño de un JPEG (marcador SOF) — null si no es JPEG. */
export function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
