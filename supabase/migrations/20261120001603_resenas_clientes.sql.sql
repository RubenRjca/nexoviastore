/*
# Tabla de reseñas de clientes (single-tenant, sin login)

## Propósito
Permite a los visitantes de Nexovia Store dejar y leer reseñas de productos.
La tienda no tiene pantalla de login, por lo que cualquier visitante puede
escribir y leer reseñas. No hay aislamiento por usuario: los datos son públicos.

## Tabla nueva
- `resenas`
  - `id` uuid, clave primaria
  - `producto_sku` text, SKU del producto reseñado (referencia al catálogo)
  - `nombre` text, nombre que muestra el cliente al dejar la reseña
  - `texto` text, contenido de la reseña
  - `estrellas` smallint, calificación de 1 a 5
  - `created_at` timestamptz, fecha de creación

## Seguridad (RLS)
- RLS habilitado.
- Grants de SELECT e INSERT a anon + authenticated (la tienda no tiene login).
- SELECT público: cualquiera puede leer todas las reseñas.
- INSERT público: cualquiera puede dejar una reseña, con validación de estrellas
  entre 1 y 5, nombre y texto no vacíos.

## Notas
- No se permite UPDATE ni DELETE desde el cliente (solo el operador puede
  moderarlas desde el panel de Supabase).
- No hay columna user_id porque la app no tiene login.
*/

CREATE TABLE IF NOT EXISTS resenas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_sku text NOT NULL,
  nombre text NOT NULL CHECK (trim(nombre) <> ''),
  texto text NOT NULL CHECK (trim(texto) <> ''),
  estrellas smallint NOT NULL CHECK (estrellas >= 1 AND estrellas <= 5),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS resenas_producto_sku_idx ON resenas (producto_sku);

ALTER TABLE resenas ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON resenas TO anon, authenticated;

DROP POLICY IF EXISTS "anon_read_resenas" ON resenas;
CREATE POLICY "anon_read_resenas"
ON resenas FOR SELECT
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_resenas" ON resenas;
CREATE POLICY "anon_insert_resenas"
ON resenas FOR INSERT
TO anon, authenticated WITH CHECK (true);
