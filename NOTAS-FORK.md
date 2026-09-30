# NOTAS-FORK — Vocero CRM para agenciaev

Fork de trabajo de [`kevinrivm/vocero-crm`](https://github.com/kevinrivm/vocero-crm).

**Regla rectora: el diff contra upstream se mantiene diminuto.** Todo lo que se
pueda hacer en un archivo NUEVO se hace en un archivo nuevo; solo se tocan
archivos de upstream cuando no hay alternativa. Así rebasear sobre versiones
nuevas de Vocero es trivial en vez de un conflicto por release.

---

## 1. Remotos y ramas

| Remoto | URL | Estado |
|---|---|---|
| `upstream` | `https://github.com/kevinrivm/vocero-crm.git` | configurado (era `origin` al clonar) |
| `origin` | `https://github.com/IT-Desarrollo2000/vocero-crm.git` | **NO configurado todavía** — el fork aún no existe en GitHub |

Cuando el fork exista en la organización, agregarlo con:

```bash
git remote add origin https://github.com/IT-Desarrollo2000/vocero-crm.git
git push -u origin agenciaev
```

Ramas:

- `main` — espejo limpio de upstream. **No se commitea aquí.**
- `agenciaev` — rama de trabajo y de deploy. Todo lo nuestro vive acá.

---

## 2. Qué cambiamos respecto a upstream

### 2.1 Aislamiento de esquema (2 archivos modificados)


Vocero corre contra la base Postgres de Supabase que ya usa el proyecto
**agenciaev**. Para que no se pisen, Vocero vive aislado en el esquema
`vocero`.

Sus tablas se declaran **sin calificar** (`pgTable("contact", ...)`, sin
`pgSchema`), así que el esquema se resuelve por `search_path` de la conexión.
Fijamos ese `search_path` en los dos únicos puntos donde se abre una conexión:

- **`src/lib/db/index.ts`** — cliente de la app (`max: 10`).
- **`scripts/migrate.mjs`** — migraciones al arranque del contenedor (`max: 1`).

En ambos se agregó una sola opción al objeto de `postgres()`:

```js
connection: { search_path: "vocero, extensions" }
```

**Por qué `public` NO está en el `search_path`:** es deliberado. Si estuviera,
una tabla que falte en `vocero` se resolvería **en silencio** contra la tabla
homónima de agenciaev en `public` — lectura o, peor, escritura cruzada entre
proyectos. Sin `public`, ese caso falla ruidosamente con
`relation ... does not exist`, que es exactamente lo que queremos.

`extensions` sí va, porque es donde Supabase instala `pgcrypto`, `uuid-ossp`,
etc.

`scripts/migrate.mjs` lleva **además** dos cosas: una transformación del SQL de
las migraciones —porque el `search_path` por sí solo no basta, las FK que
genera drizzle-kit traen `public` cableado (**§3.4**)— y una resolución más
robusta de la carpeta `drizzle/` (**§3.5**).

> Nota: el `search_path` se fija **por conexión desde el driver**, no en el rol
> de Postgres ni en la `DATABASE_URL`. Cualquier herramienta que se conecte por
> fuera de estos dos archivos (psql, `drizzle-kit`, un script suelto) **no lo
> hereda** y hay que pasárselo a mano — ver §4.

### 2.2 Archivos nuevos (no tocan upstream)

| Archivo | Para qué |
|---|---|
| `docker-compose.supabase.yml` | Deploy contra Supabase: mismo `app` + `caddy` del compose original, **sin** el servicio `postgres` ni su volumen `vocero_pg`. |
| `.env.agenciaev.example` | Plantilla de variables del fork, basada en el `.env.example` de upstream. |
| `NOTAS-FORK.md` | Este archivo. |

El `docker-compose.yml` de upstream **se deja intacto** a propósito (sigue
sirviendo para levantar la Ruta B con Postgres local, y no genera conflictos al
rebasear).

Dos cosas que el compose nuevo **agrega** respecto al de upstream, no solo
quita:

- `MEDIA_DIR` + volumen nombrado `vocero_media` montado en `/data/media`.
  El compose de upstream **no declara ninguno de los dos** (el `Dockerfile` sí
  prepara `/data/media` con el dueño correcto). Sin el volumen, los adjuntos de
  WhatsApp se pierden al recrear el contenedor y **no se pueden recuperar**:
  Meta expira sus archivos a los ~30 días.
- Las variables opcionales `CHANNELS`, `AGENDA`, `ATRIBUCION` y `BOT_API_KEY`,
  que existen en `src/lib/env.ts` y en `.env.example` pero que el compose de
  upstream no propaga al contenedor.

### 2.3 `.gitignore` (1 línea)

Upstream ignora `.env.*` con una sola excepción (`!.env.example`), lo que
también dejaría fuera nuestra plantilla. Se agregó `!.env.agenciaev.example`.
El archivo solo contiene placeholders `REEMPLAZA_...`; **ningún secreto real
entra al repo**.

---

## 3. Base de datos: reglas duras

### 3.1 Dos comandos PROHIBIDOS: `drizzle-kit push` y `pnpm db:migrate`

Las migraciones se aplican **siempre por `scripts/migrate.mjs`**, nunca por
`drizzle-kit` directo.

```bash
pnpm db:generate                                    # genera el SQL nuevo   ✅
MIGRATIONS_DIR=./drizzle node --env-file=.env scripts/migrate.mjs   # aplica ✅
node --env-file=.env scripts/migrate.mjs            # ídem (autodetecta)    ✅

pnpm db:migrate                                     # ❌ JAMÁS  (ver abajo)
pnpm exec drizzle-kit push                          # ❌ JAMÁS  (ver abajo)
```

#### Por qué no `pnpm db:migrate`

`drizzle-kit migrate` entra por `drizzle.config.ts` y lee los `.sql` de
`drizzle/` **tal como están en disco**: se salta por completo la transformación
de FK del fork (§3.4). Resultado: revienta con
`relation "public.user" does not exist` y deja la migración a medias — que es
exactamente el problema que el fork resuelve.

Es la misma trampa que `push`, solo que más silenciosa porque el comando
*parece* el correcto y está en el `package.json` de upstream.

#### Por qué no `drizzle-kit push`

`push` **introspecta** el esquema real y lo fuerza a coincidir con
`src/lib/db/schema.ts`, borrando todo lo que ese archivo no declare. Dentro del
esquema `vocero` agenciaev crea **triggers de integración** (y objetos
asociados) que no están —ni van a estar— en el schema de Drizzle: `push` los
eliminaría sin avisar y rompería la integración entre los dos sistemas. Además
sus DROP se ejecutan sin migración que los deje registrados, así que no hay
rastro de qué se perdió.

Upstream **no expone** un script `db:push` en `package.json` — no lo agregues.

#### Cómo se aplican entonces

- **En producción**: sola. El `CMD` del Dockerfile es
  `node migrate.mjs && node server.js`, así que corre en cada arranque del
  contenedor con la transformación incluida.
- **En local**: `node --env-file=.env scripts/migrate.mjs`. El script resuelve
  `drizzle/` tanto si lo corren desde `scripts/` como desde la raíz (el bundle
  de Docker vive en la raíz), y `MIGRATIONS_DIR` sigue teniendo precedencia si
  querés forzar la ruta.

> `pnpm db:generate` **sí** es seguro: solo escribe SQL nuevo en `drizzle/`, no
> toca la base. Después de generarlo, revisá que las FK nuevas tengan la forma
> `REFERENCES "public"."…"` que la transformación cubre (§3.4).

### 3.2 Conexión: session pooler, puerto 5432

`DATABASE_URL` debe apuntar al **session pooler** de Supabase:

```
postgresql://vocero_app.<PROJECT_REF>:PASSWORD@aws-1-us-east-1.pooler.supabase.com:5432/postgres
```

Tres detalles, los tres verificados conectándose de verdad. Cada uno falla de
una forma distinta y ninguno es adivinable:

| Detalle | Si te equivocás | Error |
|---|---|---|
| Usuario con **project-ref pegado** (`vocero_app.<ref>`) | `vocero_app` a secas | `ENOIDENTIFIER no tenant identifier provided (external_id or sni_host)` |
| Host **`aws-1-`** (para este proyecto), no `aws-0-` | host equivocado | `XX000 tenant/user vocero_app.<ref> not found` |
| Puerto **5432** (session), no 6543 (transaction) | 6543 | `prepared statement "sN" does not exist` intermitente + fallos de login |

Sobre el **usuario**: el ref no es cosmético — Supavisor saca de ahí a qué
proyecto (tenant) entrar.

Sobre el **host**: ⚠️ `aws-0-` y `aws-1-` **resuelven los dos en DNS**, porque
es un endpoint compartido. Un `ping` o `nslookup` no delata el error: sólo se
ve al autenticar. El número y la región **varían por proyecto**, así que hay
que sacarlos siempre de
**Dashboard → Settings → Database → Connection string → "Session pooler"** y
copiar el host tal cual.

Sobre el **puerto**: el modo transaction no conserva la sesión entre queries y
rompe los *prepared statements* que usan `postgres.js` (el driver de Vocero) y
Better Auth. Usar 6543 obligaría a agregar `prepare: false` al driver — un
parche más contra upstream que preferimos no cargar.

**El pooler no es opcional:** la conexión directa
(`db.<PROJECT_REF>.supabase.co`) resuelve **sólo a IPv6**, así que desde una red
sin IPv6 simplemente no es alcanzable.

**El `search_path` sobrevive al pooler.** Verificado: `current_setting('search_path')`
a través de Supavisor devuelve `vocero, extensions`. Lo sostiene el
`ALTER ROLE` de la migración de agenciaev (§3.3), además de lo que manda el
driver por conexión.

### 3.3 Preparativos en Supabase (una sola vez, fuera de este repo)

Ya están hechos del lado de agenciaev, en su migración
`20260831000000_vocero_schema_and_role.sql`:

1. `CREATE SCHEMA IF NOT EXISTS vocero;`
2. Rol dedicado `vocero_app` con permisos **solo** sobre `vocero` (y `USAGE`
   sobre `extensions`). **Sin permisos sobre `public`** — el aislamiento por
   `search_path` es la primera barrera, los GRANTs son la segunda.
3. `ALTER ROLE vocero_app SET search_path = vocero, extensions;` (defensa en
   profundidad; el driver igual lo manda por conexión).
4. Pre-crea el esquema **`drizzle`** con dueño `vocero_app` y otorga
   `CREATE ON DATABASE`. `migrate()` se llama sin `migrationsSchema`, así que
   `drizzle-orm` usa su default y guarda la tabla de control en
   `drizzle.__drizzle_migrations`, fuera de `vocero`. **No hace falta pasar
   `migrationsSchema`.**

   > El `GRANT CREATE ON DATABASE` es necesario aunque el esquema ya exista:
   > `CREATE SCHEMA IF NOT EXISTS` evalúa el privilegio **antes** del bail-out
   > por existencia, así que pre-crearlo no basta por sí solo.

### 3.4 Las migraciones traen `"public"` cableado — RESUELTO en `migrate.mjs`

**El parche de `search_path` no alcanzaba por sí solo.** El SQL que genera
`drizzle-kit` en `drizzle/` califica el esquema **a mano** en las claves
foráneas:

```sql
CREATE TABLE "account" ( ... );                      -- sin calificar → cae en `vocero` ✅
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ...;  -- ❌ apuntaba a `public`
```

Alcance medido: **49 ocurrencias** de `REFERENCES "public"."…"` en **8 de las 11**
migraciones (`0000`, `0002`, `0004`, `0008`, `0009`, `0010`), sobre las tablas
`ad_attribution`, `agent_test_run`, `contact`, `conversation`, `lead`,
`media_asset`, `organization`, `pipeline_stage` y `user`. Todas son de esa
**única forma sintáctica** — ninguna otra clase de sentencia estaba afectada, lo
que hizo que la corrección fuera acotada.

Sin arreglo, las tablas se creaban bien en `vocero` y después la primera
`ALTER TABLE … ADD CONSTRAINT` fallaba con
`relation "public.user" does not exist`, dejando la migración `0000` a medias y
el contenedor sin arrancar.

#### Qué se hizo

`scripts/migrate.mjs` (archivo que el fork ya parcheaba) **desqualifica el
esquema de las FK antes de migrar**:

```
REFERENCES "public"."   →   REFERENCES "
```

Se **desqualifica**, no se reescribe a `"vocero"."`: así funciona con cualquier
nombre de esquema y queda consistente con los `CREATE TABLE`, que ya vienen sin
calificar. El esquema lo resuelve el `search_path` de la conexión, igual que
todo lo demás.

Detalles de la implementación:

- `readMigrationFiles()` lee los `.sql` del disco, así que la transformación
  ocurre **antes** de `migrate()`: se escriben copias en un directorio temporal
  y se apunta `migrationsFolder` ahí.
- El temporal vive en `os.tmpdir()`, **no** dentro de `/app`: el contenedor
  puede montar el filesystem de la app en solo lectura.
- Se copia también `drizzle/meta/` — `readMigrationFiles()` arranca por
  `_journal.json` y sin él no encuentra ninguna migración.
- Es **idempotente**: el contenedor corre esto en cada arranque, así que el
  directorio temporal se borra y se regenera.
- La transformación se hace **una sola vez, fuera** del bucle de 15 reintentos:
  es determinista y no depende de la BD.
- Loguea el conteo por archivo (`[migrate] 0004_…: 6 FK desqualificadas`). Cero
  reemplazos **no** es error: hay migraciones sin FKs.

#### Red de seguridad

Después de transformar, se verifica que no quede ningún `"public".` en el SQL
resultante (ni la variante sin comillas, acotada a `REFERENCES` para no saltar
por un comentario que mencione "public."). Si queda algo, **aborta con
`process.exit(1)`** indicando archivo y número de línea.

Significaría que upstream introdujo una forma de calificación que la
transformación no cubre, y es mucho mejor que el arranque falle a que se creen
tablas a medias en el esquema equivocado.

#### Validado contra la Supabase real

Las 11 migraciones aplicaron limpias: **49 FK desqualificadas**, las **29 tablas
quedaron en el esquema `vocero`** con sus 49 FK apuntando a `vocero`, y **cero
tablas filtradas a `public`**. El mecanismo está verificado de punta a punta.

#### Sobre los hashes

Drizzle hashea el **contenido** de cada migración para `__drizzle_migrations`.
Como la transformación es determinista, el hash es estable entre arranques: no
provoca re-aplicaciones ni desajustes.

#### Por qué no las otras dos opciones

- **`pgSchema("vocero")` en `src/lib/db/schema.ts` + regenerar las migraciones.**
  Sería lo "limpio", pero el diff contra upstream **explota**: 29 tablas
  redeclaradas más los 11 archivos SQL regenerados. Cada release de upstream que
  toque el schema se volvería un conflicto de rebase a mano. Va en contra de la
  regla rectora del fork.
- **Postgres propio para Vocero** (el `docker-compose.yml` de upstream tal cual).
  Resuelve el aislamiento trivialmente, pero se pierde lo que motivó compartir
  la base: los **triggers de sincronización** que agenciaev instala dentro del
  esquema `vocero`, el **backup unificado** de un solo Postgres, y el
  **realtime vía Supabase Broadcast**. El costo operativo supera al del parche.

La opción de fondo —proponer el arreglo a upstream— sigue siendo deseable a
largo plazo, pero no bloquea el deploy.

### 3.5 Resolución de la carpeta `drizzle/` en `migrate.mjs`

Upstream resuelve las migraciones como `path.join(here, "drizzle")`, donde
`here` es el directorio del propio script. Eso funciona **solo** en la imagen
Docker, porque esbuild bundlea `migrate.mjs` a la **raíz** (`/app/migrate.mjs`),
al lado de `/app/drizzle`.

Ejecutándolo desde el repo (`node scripts/migrate.mjs`), `here` es `scripts/` y
busca `scripts/drizzle`, que no existe:

```
Error: ENOENT ... lstat 'vocero-crmscriptsdrizzlemeta'
```

El fork prueba **las dos rutas** antes de rendirse:

1. `MIGRATIONS_DIR` si está definida (precedencia absoluta, como en upstream).
2. `here/drizzle` — bundle en la raíz (Docker).
3. `here/../drizzle` — ejecución desde el repo.

Se valida por la existencia de `meta/` (no de la carpeta a secas), porque es lo
que `readMigrationFiles()` necesita: un `drizzle/` sin journal no sirve. Si no
encuentra ninguna, aborta con `exit(1)` listando **dónde buscó**.

Así el mismo script sirve en los dos escenarios sin variables de entorno extra.

---

## 4. Herramientas que se conectan por fuera de la app

`drizzle.config.ts` (upstream) arma sus credenciales solo con `url:` desde
`DATABASE_URL` — **no fija `search_path`**. Cualquier comando de `drizzle-kit`
lanzado a mano cae en el `search_path` por defecto del rol. Por eso el paso 3
de §3.3 (el `ALTER ROLE`) no es opcional: es lo que cubre a `drizzle-kit`,
`psql` y scripts sueltos.

Si te conectas con un rol que no tenga ese `ALTER ROLE`, fija el esquema en la
sesión antes de tocar nada:

```sql
SET search_path = vocero, extensions;
```

---

## 5. Procedimiento de rebase sobre upstream

```bash
git fetch upstream --tags
git checkout agenciaev
git rebase upstream/main          # o `git rebase <tag>` si upstream publica tags
```

> **Estado actual:** upstream **no tiene ningún tag publicado** (`git tag` sale
> vacío; la versión vive en `package.json`, hoy `1.2.0`). Hasta que los
> publiquen, se rebasea contra `upstream/main`. Conviene rebasear sobre un
> commit concreto y anotarlo, no sobre un `main` móvil.

Conflictos esperables y cómo resolverlos:

| Archivo | Riesgo | Qué hacer |
|---|---|---|
| `src/lib/db/index.ts` | bajo | Reaplicar la línea `connection: { search_path: ... }` dentro del objeto de opciones. |
| `scripts/migrate.mjs` | **medio** | Reaplicar las tres cosas: el `connection: { search_path: ... }`, la transformación de FK de §3.4 (`prepararMigracionesAisladas` + su llamada antes del bucle de reintentos + `migrationsFolder: migrationsFolderAislado`) y la resolución de rutas de §3.5 (`resolverMigrationsFolder`). Es el archivo con más código nuestro. |
| `.gitignore` | muy bajo | Conservar `!.env.agenciaev.example`. |
| `docker-compose.supabase.yml` | ninguno | Archivo nuestro. **Revisar a mano** si upstream cambió su `docker-compose.yml`: hay que replicar los cambios relevantes (variables nuevas del servicio `app`). |
| `.env.agenciaev.example` | ninguno | Archivo nuestro. Revisar si upstream agregó variables a `.env.example` y reflejarlas. |

Después de cada rebase, checklist mínimo:

1. `git diff upstream/main --stat` — debe seguir siendo pequeño (≈5 archivos).
2. Confirmar que `connection: { search_path: ... }` sigue en **los dos**
   archivos: `grep -rn "search_path" src/lib/db/index.ts scripts/migrate.mjs`.
3. Revisar `drizzle/` por migraciones nuevas de upstream antes de desplegar.
4. **Revisar si las migraciones nuevas traen formas de calificar el esquema que
   la transformación de `migrate.mjs` no cubra** (§3.4). Hoy solo se maneja
   `REFERENCES "public"."…"`. La red de seguridad aborta el arranque si algo se
   cuela, pero es mucho mejor verlo antes de desplegar:

   ```bash
   grep -rn 'public' drizzle/*.sql | grep -v 'REFERENCES "public"."'
   ```

5. `pnpm typecheck && pnpm test`.
6. Aplicar migraciones **solo** con `node --env-file=.env scripts/migrate.mjs`,
   nunca con `pnpm db:migrate` (§3.1).

---

## 6. Reglas de operación

- **Nunca** `git push --force` a `origin/agenciaev` una vez que haya deploys.
  Tras un rebase, coordinar con el equipo.
- **Nunca** commitear el `.env` real. Solo `.env.agenciaev.example` con
  placeholders.
- No hacer push a `upstream` (es de un tercero).
- Los cambios de valor general deberían ir como PR **a upstream**, no quedarse
  en el fork: cada parche propio es deuda de rebase.
