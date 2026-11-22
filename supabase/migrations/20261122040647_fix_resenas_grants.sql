/*
# Restringir permisos de la tabla resenas a SELECT e INSERT

## Propósito
La tabla `resenas` fue creada con grants de SELECT, INSERT, UPDATE y DELETE para anon y authenticated.
El diseño original (ver comentario en la migración inicial) solo permite SELECT e INSERT desde el cliente:
los visitantes pueden leer y dejar reseñas, pero la moderación (UPDATE/DELETE) la hace el operador
desde el panel de Supabase, no desde la tienda.

## Cambios
1. Revocar UPDATE y DELETE de anon y authenticated en la tabla `resenas`.
2. Confirmar que conservan SELECT e INSERT (sin cambios en las políticas RLS).

## Seguridad
- RLS sigue habilitado.
- Las políticas `anon_read_resenas` (SELECT) y `anon_insert_resenas` (INSERT) no cambian.
- anon y authenticated conservan SELECT e INSERT.
- UPDATE y DELETE quedan fuera del alcance del cliente.
*/
REVOKE UPDATE, DELETE ON resenas FROM anon, authenticated;
