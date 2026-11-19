# Conectar el libro de correspondencia

La integración está preparada, pero la cuenta con acceso a la planilla debe autorizar e implementar la aplicación web una vez. No es necesario publicar la planilla.

1. En la planilla del tribunal, abre **Extensiones → Apps Script** y copia `Code.gs`. En Configuración, muestra el manifiesto `appsscript.json` y copia el incluido aquí.
2. En Propiedades del script, agrega `SIGEX_SPREADSHEET_ID` con `1ppESVdKz3d8JUCsFSgpJIyjdtH8KTTBOeRCXKzwmf2Q` y `SIGEX_TOKEN` con una clave aleatoria de al menos 32 caracteres. No guardes la clave en el código ni en GitHub.
3. Habilita Google Sheets API en el proyecto de Google Cloud asociado si Google indica que está desactivada.
4. Implementa como **Aplicación web**, ejecutando con la cuenta del propietario y acceso **Cualquier usuario**. Los POST se autentican con la clave; si la organización restringe ese acceso, su administrador debe habilitar una alternativa autorizada.
5. Copia la URL terminada en `/exec`. En **SIGEX → Ajustes → Libro de correspondencia**, pega la URL y la clave, guarda y prueba la conexión. Probar no reserva números.

Se utiliza la pestaña del año del documento. A:E deben ser Fecha, ORD., Causa Rol, Tipo de resolución notificada y Detalle. El sistema reserva la primera fila que tenga fecha y datos vacíos y un ORD. ya escrito en B; no calcula ni modifica la numeración.

Los clientes de SIGEX deben usar **la misma implementación** para compartir el bloqueo. Una emisión guarda su identificador en una nota de la fecha y reintentar utiliza ese mismo número. La fecha, nota y datos se escriben juntos mediante una operación atómica de Sheets. El bloqueo coordina las solicitudes de SIGEX; quienes asignan números manualmente deben evitar editar al mismo tiempo las filas que está reservando SIGEX. No borres las notas SIGEX de A.

Verifica primero con una copia del libro y dos clientes. El acceso a la planilla real no se ha probado sin la implementación autorizada. Una reimpresión abre el documento existente y no llama a Google.

Referencias oficiales: [aplicaciones web](https://developers.google.com/apps-script/guides/web), [bloqueo](https://developers.google.com/apps-script/reference/lock/lock), [operaciones atómicas de Sheets](https://developers.google.com/workspace/sheets/api/guides/batch).
