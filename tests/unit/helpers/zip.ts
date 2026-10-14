/**
 * 018 — ZIP mínimo REAL para pruebas (entradas "stored", sin compresión) con
 * directorio central y End of Central Directory. La política de archivos solo
 * lee los nombres del directorio central, así que el contenido es irrelevante.
 */
export function makeZip(names: string[]): Uint8Array {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const name of names) {
    const nb = [...enc.encode(name)];
    const data = [...enc.encode("x")];
    const offset = local.length;
    // Cabecera local: firma, versión, flags, método 0, hora, fecha, crc,
    // tamaños, largo de nombre y de extra.
    local.push(
      ...[0x50, 0x4b, 0x03, 0x04], ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
      ...le32(0), ...le32(data.length), ...le32(data.length), ...le16(nb.length), ...le16(0),
      ...nb, ...data
    );
    // Registro del directorio central (46 bytes fijos + nombre).
    central.push(
      ...[0x50, 0x4b, 0x01, 0x02], ...le16(20), ...le16(20), ...le16(0), ...le16(0), ...le16(0),
      ...le16(0), ...le32(0), ...le32(data.length), ...le32(data.length), ...le16(nb.length),
      ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...nb
    );
  }
  const eocd = [
    ...[0x50, 0x4b, 0x05, 0x06], ...le16(0), ...le16(0), ...le16(names.length),
    ...le16(names.length), ...le32(central.length), ...le32(local.length), ...le16(0),
  ];
  return new Uint8Array([...local, ...central, ...eocd]);
}

/** Un .docx limpio (sin macros). */
export function makeDocx(): Buffer {
  return Buffer.from(makeZip(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]));
}
