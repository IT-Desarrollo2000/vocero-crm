# Importar los leads de un evento (Excel → CRM)

Para el administrador del sistema. Los vendedores anotan los prospectos del
evento en una hoja de Excel; tú la importas con un script desde tu
computadora. Cada fila entra a la Bandeja con la tarjeta **«Lead de evento»**
y, si la columna Vendedor coincide con alguien del equipo, asignada a esa
persona. **No se le manda ningún mensaje al prospecto**: cada vendedor le
escribe con una plantilla desde la Bandeja.

Spec y decisiones: [specs/036-importar-leads-evento/spec.md](../specs/036-importar-leads-evento/spec.md).

## Antes de empezar

- La instancia debe tener `LEADS_EXTERNOS=on` (es la misma entrada que usa el
  ERP para el formulario web y FastApp).
- La clave: **Ajustes → Leads externos**. Es la MISMA que usa el ERP: no la
  rotes para importar (si la rotas, actualiza también el Vault del ERP). Si no
  la tienes a la mano, pídesela a quien la guardó; rotarla deja al ERP en 401.
- En tu máquina: el repo con `pnpm install` (trae `exceljs`).

## La hoja

Columnas (el orden no importa; los nombres se reconocen sin importar
acentos, mayúsculas o emojis):

- **Nombre** (obligatoria)
- **WhatsApp** — 10 dígitos (también vale `+52 1 …`, o la fórmula
  `HYPERLINK("https://wa.me/52…","Enviar WhatsApp")`) (obligatoria)
- Vendedor — como se llama en el CRM: nombre completo, o solo el primer nombre
  si nadie más del equipo lo comparte
- Modelo de interés · Comentarios · Correo
- ¿Aceptó que le escribamos por WhatsApp? — Sí / No / x

Columnas que no se reconocen se ignoran (el script te dice cuáles). Si hay
varias hojas, elige una con `--hoja "Nombre de la hoja"`. También acepta `.csv`.

## Paso 1 — Ensayo (no manda nada)

```bash
node scripts/importar-leads.mjs "Expo Autos.xlsx" --evento "Expo Autos Mérida 2026"
```

Revisa el resumen: válidos, inválidos (con fila y motivo) y repetidos dentro
del archivo (se queda la primera fila con ese WhatsApp). Junto al Excel queda
`Expo Autos.resultado.csv` con el estado de cada fila (`listo`, `inválido`,
`repetido`). Corrige en el Excel lo que haga falta y repite el ensayo.

## Paso 2 — Enviar

```bash
INTAKE_API_KEY=<la clave> node scripts/importar-leads.mjs "Expo Autos.xlsx" \
  --evento "Expo Autos Mérida 2026" --url https://crm.tu-dominio.com --enviar
```

En PowerShell: `$env:INTAKE_API_KEY="<la clave>"; node scripts/importar-leads.mjs …`.
La clave va SOLO en la variable de entorno (nunca como argumento) y el script
nunca la imprime. `--url` puede omitirse si `APP_BASE_URL` ya apunta al CRM.

Manda una fila a la vez (~100 por minuto, para no frenar al ERP). Al final:
nuevos, ya importados (duplicados), errores, asignación por estado y
**vendedores sin coincidencia**.

## Leer el `.resultado.csv`

| columna | qué dice |
|---|---|
| `estado` | `nuevo` · `duplicado` (ya se había importado) · `inválido` · `repetido` · `error` · `no enviado` (el envío se detuvo) |
| `detalle` | el motivo (contacto nuevo/existente, teléfono no válido, …) |
| `asignacion` | `asignado` · `ya_asignada` (otra persona ya lo atiende; no se le quita) · `vendedor_no_encontrado` · `ambiguo` (el nombre es de más de una persona) |

El archivo trae los teléfonos completos: es tu archivo, no lo compartas.

## Corregir y volver a importar

Es seguro correr el mismo archivo otra vez con el mismo `--evento`: lo ya
importado vuelve como `duplicado`, sin otra tarjeta. Si corregiste la columna
Vendedor (p. ej. un `ambiguo` → nombre completo), el reintento asigna los
chats que sigan **libres**. Ojo: el nombre del evento es parte de la llave;
con otro nombre de evento, las filas entrarían como leads nuevos (otra
tarjeta en la misma conversación).

## Si algo falla

- **401**: la clave no es la vigente (¿la rotaron?). El script se detiene.
- **404**: `LEADS_EXTERNOS` está apagada en la instancia.
- **429**: el script espera y reintenta solo; si persiste, córrelo más tarde.
- Errores de red/5xx: reintenta hasta 4 veces; las filas que fallen quedan
  como `error` en el CSV. Volver a correr el archivo completo es seguro.
