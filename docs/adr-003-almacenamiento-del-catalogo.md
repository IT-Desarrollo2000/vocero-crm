# ADR-003 — El almacenamiento del catálogo es un conector, y Azure Blob el primero

**Estado**: aceptado · **Fecha**: 2026-10-15 · **Feature**:
[`019-catalogo-productos`](../specs/019-catalogo-productos/spec.md) (FR-910…FR-915)

## Contexto

El Catálogo (019) guarda fotos y fichas de productos que se reenvían una y otra
vez por WhatsApp, Instagram y Messenger. A diferencia de los adjuntos del chat
(018), no son una caché: tienen que seguir ahí dentro de un año, así que la
purga de 30 días no los toca y el volumen crece con el negocio.

El núcleo ya tiene dónde ponerlos: el disco local de la instancia
(`MEDIA_DIR`), sin terceros. Pero el dueño de la primera instancia que lo usa
pidió guardarlos en **Azure Blob**, en su propia cuenta: ahí respalda y paga el
almacenamiento, y no quiere que el disco del VPS sea el único lugar donde
viven los archivos de su catálogo.

El Principio II (constitución 1.4.0) prohíbe el almacenamiento de objetos
externo **como dependencia del núcleo** y admite un servicio de terceros solo
como **conector opcional** bajo cinco condiciones. Este ADR dice cómo entra.

## Decisión

**1. Un contrato, dos implementaciones.** `CatalogStorage { put, get, delete,
test }` (`src/server/catalog/storage/types.ts`). `local` es el default y el
camino soberano (`MEDIA_DIR/{org}/catalog/{fileId}`); `azure-blob` es el
conector. Las dos corren la MISMA suite de contrato
(`tests/unit/helpers/catalog-storage-contract.ts`): `local` contra un
directorio temporal, `azure-blob` contra Azurite, el emulador oficial. El
dominio (store, envío, rutas) solo conoce el contrato y `StorageError`.

**2. La variable es la bandera y la config (patrón ADR-001).**
`CATALOG_STORAGE=azure-blob` enciende el conector; `AZURE_STORAGE_CONNECTION_STRING`
y `AZURE_STORAGE_CONTAINER` lo configuran. Sin la primera, la instancia no lo
carga, no lo menciona (la UI no contiene "Azure" en ningún lado) y sus rutas de
Ajustes responden 404. Cualquier valor que no sea `azure-blob` cuenta como
`local`: un typo no manda los archivos a ningún lado raro.

**3. Sin formulario.** A diferencia de Zoom o Google (ADR-002), el almacenamiento
es de la **instancia**, no de cada organización ni de cada operador: decide
dónde viven los bytes de todo el despliegue, igual que `DATABASE_URL` o
`MEDIA_DIR`. Lo configura quien despliega, en la plataforma (Coolify), no un
Propietario desde el navegador. Ajustes solo muestra el estado ("Almacenamiento
del catálogo: Azure Blob · cuenta … · contenedor …") y un botón "Probar
conexión"; la clave nunca viaja al cliente.

Sobre la condición 4 del Principio II (credenciales del negocio, cifradas en
reposo): la credencial es la de la cuenta de Azure **del propio negocio**, y
vive donde viven los demás secretos de despliegue (`DATABASE_URL`,
`ENCRYPTION_KEY`): en el almacén de secretos de la plataforma, nunca en la BD,
nunca en el cliente, nunca en logs. Cifrarla con `ENCRYPTION_KEY` —que está en
el mismo sitio— no añadiría protección real.

**4. Sin SDK.** `@azure/storage-blob` arrastra decenas de dependencias para
usar cuatro operaciones (Put Blob, Get Blob, Delete Blob, Get Container
Properties). La autorización SharedKey son ~40 líneas de HMAC-SHA256 con
`node:crypto` y `fetch`, versión de API fija (`x-ms-version: 2021-08-06`).
Queda cubierta por vectores fijos —el string-to-sign del ejemplo de la
documentación de Microsoft y una firma calculada aparte con `openssl`— y por la
suite de contrato contra Azurite, que rechaza cualquier firma mal hecha (en CI
corre sin `--skipApiVersionCheck`, así que también valida la versión).

**5. Sin SAS.** El contenedor es privado y nadie fuera del CRM recibe una URL
de Azure:
- La UI ve los archivos por `GET /api/catalog/files/:id`, que los sirve por
  proxy con las cabeceras seguras de 018 (FR-914).
- WhatsApp y Messenger reciben los bytes subidos por el CRM a Meta.
- Instagram, que solo acepta envíos por URL pública, recibe la **URL firmada del
  CRM** de la copia en caché del hilo (`src/server/media/signed-url.ts`), igual
  que cualquier adjunto. Azure nunca se expone a Meta.

La cadena con `SharedAccessSignature=` se rechaza en v1 como `misconfigured`:
firmar con SAS es otra autorización, y no hay caso de uso que la pida.

**6. Cada archivo recuerda dónde se guardó.** `product_file.storage_provider` +
`storage_key` (FR-912). `getCatalogStorage()` es el proveedor de los archivos
NUEVOS; `getCatalogStorage(row.storageProvider)` es el de uno ya guardado.
Cambiar `CATALOG_STORAGE` **no migra nada**: lo subido a `local` se sigue
leyendo del disco aunque lo nuevo vaya a Azure, y al revés. Migrar entre
proveedores queda fuera de v1.

**7. Degradación definida.** El fallo de Azure se queda dentro del catálogo:
- Config inválida (cadena ausente o mal formada, SAS, contenedor con nombre
  inválido): **la app arranca igual**. `getEnv()` no valida estas variables; el
  adaptador se construye "envenenado" y cada operación rechaza con
  `StorageError("misconfigured")`. Se registra UNA línea saneada al primer uso
  y Ajustes → Almacenamiento dice qué variable revisar.
- Azure caído o lento (red, 5xx, timeout de 30 s; 10 s al probar): `unavailable`.
- 403 → `misconfigured` "clave inválida"; contenedor inexistente →
  `misconfigured` "el contenedor no existe".
- En el catálogo, todo eso es **503** al subir o abrir un archivo guardado en
  Azure; el catálogo se sigue viendo (miniaturas rotas) y un envío por lote
  manda el texto y marca ese archivo como `failed`. Chat, agente, agenda y lo
  guardado en `local` siguen igual.
- Errores saneados: del error de Azure solo se conserva el código HTTP y
  `x-ms-error-code`. El cuerpo NO se lee (Azure devuelve ahí la URL y el
  string-to-sign) y la clave y la cabecera `Authorization` nunca aparecen en un
  mensaje ni en un log.

## Las cinco condiciones del Principio II

| Condición | Cómo se cumple |
|---|---|
| 1. Apagado por defecto | `CATALOG_STORAGE` ausente = `local`; ni UI, ni rutas (404), ni credenciales |
| 2. Adaptador con contrato público | `CatalogStorage` + suite `runStorageContract` compartida |
| 3. Funciona sin él, degradación definida | `local` es el camino completo; Azure caído = 503 solo en sus archivos |
| 4. Credenciales del negocio | su propia cuenta; secreto de despliegue, nunca BD/cliente/logs (ver 3) |
| 5. CI apagado y encendido | `default` sin Azurite (la suite de Azure se salta); `completo` con `CATALOG_STORAGE=azure-blob` y Azurite como servicio (`AZURITE_URL` la vuelve obligatoria) |

## Lo que se descartó

- **El SDK oficial.** Ver 4: peso desproporcionado para cuatro llamadas, y un
  árbol de dependencias más que auditar en cada instancia.
- **Un formulario en Ajustes para pegar la cadena.** Pondría un secreto de la
  instancia en manos de un rol de organización, lo guardaría en la BD y obligaría
  a resolver qué pasa con los archivos de otra org si alguien lo cambia.
- **URLs SAS para Instagram o para el navegador.** Exponen el proveedor a Meta y
  al cliente, caducan por su cuenta y meten una segunda forma de autorización;
  la URL firmada del CRM ya resuelve el caso.
- **Migrar automáticamente al cambiar de proveedor.** Una copia masiva en el
  arranque es lenta, puede fallar a medias y no es reversible; recordar el
  proveedor por archivo hace innecesario migrar.
- **Azure también para los adjuntos del chat.** Son una caché de 30 días (018);
  sacarlos del disco no aporta y complica la purga.
- **Una interfaz genérica de "object storage" (S3/R2/Azure).** Hoy hay un
  proveedor pedido; el contrato de cuatro operaciones ya es la costura donde
  entraría un segundo.

## La revisión "a la tercera"

ADR-002 dejó dicho que **a la tercera** bandera convenía sentarse a evaluar una
interfaz común. La tercera fue `ATRIBUCION` (016) y la revisión no se hizo;
`CATALOG_STORAGE` es en rigor la cuarta (y la tercera familia de conectores,
tras canales y agenda), así que se hace aquí. La decisión es **no todavía**:
las que existen no tienen
la misma forma. `CHANNELS` es una lista, `AGENDA` y `ATRIBUCION` son
encendido/apagado, y `CATALOG_STORAGE` es una **elección entre proveedores**
cuya config también vive en el entorno. Lo que sí comparten —leer
`process.env` directo para no depender de que todo el entorno valide, 404 para
la superficie apagada, la UI que no menciona lo apagado— ya está escrito como
patrón (`agenda/flag.ts`, `attribution/flag.ts`, `catalog/storage/index.ts`).
Una abstracción sobre cuatro formas distintas sería más grande que las cuatro
juntas. El criterio de ADR-001 sigue: del orden de quince banderas, hace falta
un mecanismo de extensiones de verdad.

## Cómo activarlo en Coolify

1. En Azure: Cuenta de almacenamiento → Almacenamiento de datos → Contenedores
   → "+ Contenedor", nivel de acceso **Privado**, nombre en minúsculas, números
   y guiones (p. ej. `vocero-catalogo`). El CRM no crea contenedores.
2. Seguridad y redes → Claves de acceso → "Mostrar" → copia la **Cadena de
   conexión** (la que trae `AccountKey=`; una SAS no sirve).
3. En Coolify → la aplicación → Environment Variables (runtime, no build):
   ```
   CATALOG_STORAGE=azure-blob
   AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…;EndpointSuffix=core.windows.net
   AZURE_STORAGE_CONTAINER=vocero-catalogo
   ```
   Marca la cadena como secreta. Redespliega.
4. En el CRM, como Propietario: Configuración → **Almacenamiento** → "Probar
   conexión". "Clave inválida" = la cadena está mal copiada o la clave se rotó;
   "el contenedor no existe" = revisa el nombre.
5. Lo subido antes sigue en el disco local y se sigue sirviendo de ahí; solo lo
   nuevo va a Azure. Para volver atrás, quita `CATALOG_STORAGE` (lo subido a
   Azure se sigue leyendo de Azure mientras la cadena siga puesta).

En desarrollo: `docker compose -f docker-compose.dev.yml --profile azurite up -d
azurite` y la cadena del emulador (está en ese archivo; es pública y estándar).

## Consecuencias

- Una instancia default no cambia: disco local, sin variables nuevas.
- La CI `completo` levanta Azurite y corre el contrato de `azure-blob`; si el
  servicio no responde, la suite falla en vez de saltarse.
- Rotar la clave en Azure exige actualizar la variable y redesplegar; mientras
  tanto, lo guardado en Azure responde 503 y "Probar conexión" dice "clave
  inválida".
- Un segundo proveedor (S3, R2, otro) entra como otra implementación del mismo
  contrato y otro valor de `CATALOG_STORAGE`, con su propia suite contra un
  emulador — sin migración de esquema: `storage_provider` ya es por archivo.
