// Paso 1 del alta: elegir contraseña.
//
// No se pide el email (ya lo sabe la invitación), ni el nombre de la liga, ni el tipo de torneo,
// ni nada de red. Todo eso existía en el asistente del .exe y es justamente lo que hacía que la
// puesta en marcha fuera impracticable. El tipo de torneo arranca en "campeonato" y se cambia
// después desde Reglas, donde ya vive.

const TOKEN = window.location.pathname.split("/").pop();

async function iniciar() {
  let invitacion;
  try {
    invitacion = await api("/api/portal/invitacion/" + encodeURIComponent(TOKEN));
  } catch (err) {
    $("vencida").hidden = false;
    return;
  }

  $("nombre-liga").textContent = (invitacion.league && invitacion.league.name) || "tu liga";
  $("email-invitado").textContent = invitacion.email;
  $("form").hidden = false;

  alEnviar($("form"), async () => {
    const resultado = await api("/api/portal/invitacion/" + encodeURIComponent(TOKEN), {
      password: $("password").value,
    });
    // Directo a la pantalla de conexión: la cuenta ya quedó abierta, no hay un segundo login.
    window.location.href = "/conectar/" + resultado.slug;
  });
}

iniciar();
