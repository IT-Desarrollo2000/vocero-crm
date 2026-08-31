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

### 3.1 NUNCA correr `drizzle-kit push`

**Solo `drizzle-kit migrate`.**

```bash
pnpm db:generate   # genera el SQL de migración a partir del schema  ✅
pnpm db:migrate    # aplica migraciones pendientes                    ✅
pnpm exec drizzle-kit push                                          # ❌ JAMÁS
```

`push` **introspecta** el esquema real y lo fuerza a coincidir con
`src/lib/db/schema.ts`, borrando todo lo que ese archivo no declare. Dentro del
esquema `vocero` agenciaev crea **triggers de integración** (y objetos
asociados) que no están —ni van a estar— en el schema de Drizzle: `push` los
eliminaría sin avisar y rompería la integración entre los dos sistemas. Además
sus DROP se ejecutan sin migración que los deje registrados, así que no hay
rastro de qué se perdió.

`migrate` solo aplica los archivos SQL de `drizzle/` y lleva registro en su
tabla de migraciones. Es el único camino.

Upstream **no expone** un script `db:push` en `package.json` — no lo agregues.

### 3.2 Conexión: session pooler, puerto 5432

`DATABASE_URL` debe apuntar al **session pooler** de Supabase:

```
postgresql://vocero_app:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres
```

**No usar el transaction pooler (6543).** Ese modo no conserva la sesión entre
queries y rompe los *prepared statements* que usan `postgres.js` (el driver de
Vocero) y Better Auth: errores intermitentes
`prepared statement "sN" does not exist` y fallos de login. Usar 6543 obligaría
a agregar `prepare: false` al driver — un parche más contra upstream que
preferimos no cargar.

### 3.3 Preparativos en Supabase (una sola vez, fuera de este repo)

1. `CREATE SCHEMA IF NOT EXISTS vocero;`
2. Rol dedicado `vocero_app` con permisos **solo** sobre `vocero` (y `USAGE`
   sobre `extensions`). **Sin permisos sobre `public`** — el aislamiento por
   `search_path` es la primera barrera, los GRANTs son la segunda.
3. `ALTER ROLE vocero_app SET search_path = vocero, extensions;` (defensa en
   profundidad; el driver igual lo manda por conexión).

### 3.4 ⚠️ BLOQUEANTE ABIERTO: las migraciones traen `"public"` cableado

**El parche de `search_path` NO alcanza por sí solo.** El SQL generado por
`drizzle-kit` en `drizzle/` califica el esquema **a mano** en las claves
foráneas:

```sql
CREATE TABLE "account" ( ... );                      -- sin calificar → cae en `vocero` ✅
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ...;  -- ❌ apunta a `public`
```

Alcance medido en este commit: **49 ocurrencias** de `REFERENCES "public"."…"`
en **8 de las 11** migraciones (`0000`, `0002`, `0004`, `0008`, `0009`, `0010`).
Las tablas referenciadas son: `ad_attribution`, `agent_test_run`, `contact`,
`conversation`, `lead`, `media_asset`, `organization`, `pipeline_stage`, `user`.

Qué pasa al correr `migrate` contra Supabase con `search_path = vocero`:
las tablas se **crean** bien en `vocero`, y después la primera `ALTER TABLE …
ADD CONSTRAINT` **falla** con `relation "public.user" does not exist`. La
migración `0000` queda a medias y el contenedor no arranca.

Lo bueno: **falla ruidosamente, no en silencio.** Se verificó que ninguno de
esos 9 nombres existe en el `public` de agenciaev, así que no hay riesgo de que
se cree una FK cruzada apuntando al otro proyecto. Si algún día agenciaev
creara una tabla con uno de esos nombres, el riesgo pasaría a ser real y
silencioso.

Opciones para resolverlo (**decisión de equipo pendiente, nada implementado**):

1. **Reescribir el SQL al vuelo en `scripts/migrate.mjs`** — copiar `drizzle/` a
   una carpeta temporal sustituyendo `"public".` → `"vocero".` antes de llamar a
   `migrate()`. Ventaja: queda contenido en un archivo que ya parcheamos, y
   cubre automáticamente las migraciones futuras de upstream. Es la opción
   recomendada.
2. **Parchear los 11 archivos de `drizzle/`** con un `sed`. Simple, pero infla
   el diff (49 líneas en 8 archivos) y hay que repetirlo en cada migración nueva
   que publique upstream. Rompe la regla del diff mínimo.
3. **Proponer el arreglo a upstream** (que `drizzle.config.ts` no cablee el
   esquema, o que el schema use `pgSchema`). Es lo correcto a largo plazo pero
   no desbloquea el deploy de hoy.

Detalle adicional: `migrate()` se llama sin `migrationsSchema`, así que
`drizzle-orm` usa su default y crea la tabla de control en un esquema
**`drizzle`** aparte (`drizzle.__drizzle_migrations`), no dentro de `vocero`.
El rol `vocero_app` necesita permiso para crearlo, o hay que pasarle
`migrationsSchema: "vocero"` a `migrate()` para mantener todo junto. Conviene
resolverlo en la misma pasada que la opción 1.

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
| `scripts/migrate.mjs` | bajo | Ídem. |
| `.gitignore` | muy bajo | Conservar `!.env.agenciaev.example`. |
| `docker-compose.supabase.yml` | ninguno | Archivo nuestro. **Revisar a mano** si upstream cambió su `docker-compose.yml`: hay que replicar los cambios relevantes (variables nuevas del servicio `app`). |
| `.env.agenciaev.example` | ninguno | Archivo nuestro. Revisar si upstream agregó variables a `.env.example` y reflejarlas. |

Después de cada rebase, checklist mínimo:

1. `git diff upstream/main --stat` — debe seguir siendo pequeño (≈5 archivos).
2. Confirmar que `connection: { search_path: ... }` sigue en **los dos**
   archivos: `grep -rn "search_path" src/lib/db/index.ts scripts/migrate.mjs`.
3. Revisar `drizzle/` por migraciones nuevas de upstream antes de desplegar.
4. `pnpm typecheck && pnpm test`.

---

## 6. Reglas de operación

- **Nunca** `git push --force` a `origin/agenciaev` una vez que haya deploys.
  Tras un rebase, coordinar con el equipo.
- **Nunca** commitear el `.env` real. Solo `.env.agenciaev.example` con
  placeholders.
- No hacer push a `upstream` (es de un tercero).
- Los cambios de valor general deberían ir como PR **a upstream**, no quedarse
  en el fork: cada parche propio es deuda de rebase.
