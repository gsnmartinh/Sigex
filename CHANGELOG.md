# SIGEX 2.1.0

La ficha conserva el rol de origen, la foja de la solicitud y los datos del pago para reutilizarlos en los documentos. Registrar un pago permite escanear su comprobante y preparar juntos X26 y X05 según el medio registrado.

- El ingreso ofrece preparar la solicitud y, si hay licencia retenida, el permiso provisorio.
- La ficha muestra la próxima diligencia y los pendientes para cerrar. Registrar un comprobante ya no basta para sugerir archivo.
- La licencia distingue recepción pendiente, original en el juzgado, disponible para retiro, entregada al titular y devuelta al tribunal. El permiso tiene fechas propias de emisión y vigencia.
- La reconsideración registra presentación, remisión, recepción de respuesta y notificación. Los plazos de pago y devolución quedan detenidos hasta notificar la respuesta; si corresponde pagar, empiezan nuevamente 30 días corridos.
- Los Word quedan registrados por modelo, fecha, versión, firmantes y ORD. Abrir o reimprimir usa el mismo archivo. Una emisión pendiente se puede reintentar conservando su solicitud y ORD.
- Se puede registrar firma y despacho de documentos. El envío de correo continúa requiriendo confirmación del funcionario.
- El panel agrega licencias por retirar, causas listas para archivo, recursos y segundos avisos. La búsqueda incluye boleta, seguimiento, rol de origen y RUT sin puntuación.
- Ajustes permite comprobar las plantillas y elegir la carpeta de Word. Se mantiene el formato Legal y las plantillas existentes.
- Los formularios de ingreso, edición, sentencia, pago y recurso conservan borradores. Ctrl+N abre un exhorto; Ctrl+K abre la búsqueda; Ctrl+S guarda el formulario activo.

## Libro de correspondencia

La integración automática está preparada en `integrations/google-sheets`. Debe implementarse y autorizarse una vez desde la cuenta de Google con acceso al libro. Su URL y clave se configuran en Ajustes. Hasta activarla, el funcionario obtiene el ORD. en la planilla y lo ingresa al preparar el oficio.

Las pruebas de reserva, idempotencia y reintento utilizan simulaciones; la escritura en el libro real requiere comprobar la implementación autorizada. Los Word emitidos antes de esta versión permanecen en sus carpetas; el registro nuevo incorpora las emisiones realizadas desde 2.1.0.

## Validación

`npm test` comprueba las reglas anteriores, persistencia, reconsideraciones, cierre, licencia, los 20 modelos, reimpresión y recuperación de reservas. La prueba opcional `test/ui-workflow.js` usa Playwright con `test/ui-server.js` y datos ficticios. `test/electron-smoke.js` verifica SQLite con el ejecutable de Electron de distribución.

La actualización agrega columnas y tablas a la base existente, sin sustituir sus causas ni sus adjuntos. Los Word nuevos se incluyen en las copias de documentos del respaldo y pueden abrirse desde esa copia si desaparece su ubicación original.
