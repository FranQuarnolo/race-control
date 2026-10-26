// La landing es HTML estático: no necesita JS para mostrarse, y eso es deliberado — es la página
// que ve alguien que todavía no es cliente, y tiene que cargar aunque algo falle.
//
// Lo único que hace este archivo son retoques que mejoran la visita sin ser imprescindibles.

(function () {
  // 0. El año del pie. Escrito acá y no en el HTML para que no haya un año a mano que quede
  //    viejo el 1 de enero sin que nadie se dé cuenta.
  var anio = document.getElementById("anio");
  if (anio) anio.textContent = String(new Date().getFullYear());

  // La flecha de volver arriba aparece recién cuando hay algo arriba a donde volver. Un umbral
  // de una pantalla y media: antes de eso el botón solo taparía contenido.
  var arriba = document.getElementById("btn-arriba");
  if (arriba) {
    var revisar = function () {
      arriba.classList.toggle("visible", window.scrollY > window.innerHeight * 1.5);
    };
    // `passive`: el handler no cancela nada, y decírselo al navegador le deja hacer el scroll
    // sin esperar a que este código termine.
    window.addEventListener("scroll", revisar, { passive: true });
    revisar();
    arriba.addEventListener("click", function () {
      // `behavior: "auto"` y no `"smooth"`: así manda el `scroll-behavior` de la hoja, que está
      // dentro de un `prefers-reduced-motion`. Forzarlo acá le pasaría por encima a alguien que
      // pidió explícitamente que las cosas no se deslicen.
      window.scrollTo({ top: 0, behavior: "auto" });
    });
  }

  // 1. La versión en el pie. Si la API no contesta, el hueco queda vacío y no pasa nada.
  fetch("/api/portal/me", { headers: { "X-RC-Request": "1" } })
    .then(function (res) { return res.json(); })
    .then(function (me) {
      var version = document.getElementById("version");
      if (version && me && me.version) version.textContent = me.version;

      // 1b. El botón de contacto del cierre. Solo se muestra con una dirección configurada, y solo
      //     se aceptan los tres esquemas esperables: el valor lo pone quien despliega, pero un
      //     `javascript:` acá se ejecutaría en la página pública de todos.
      var cta = document.getElementById("cta-contacto");
      var contacto = me && typeof me.contact === "string" ? me.contact : "";
      var valido = /^(mailto:|https:\/\/|http:\/\/)/.test(contacto);
      if (cta && valido) {
        cta.href = contacto;
        if (contacto.indexOf("http") === 0) {
          cta.target = "_blank";
          cta.rel = "noopener";
        }
        cta.hidden = false;
      }

      // 2. Quien ya tiene la sesión abierta no quiere ver un botón que dice "Ingresar": lo manda
      //    a donde iba. El destino lo decide el mismo criterio que usa el login.
      if (!me || !me.authenticated) return;
      var destino = me.role === "operador"
        ? "/operador"
        : me.leagues && me.leagues.length === 1
          ? "/l/" + me.leagues[0].slug + "/"
          : "/mis-ligas";
      var enlaces = document.querySelectorAll('a[href="/login"]');
      for (var i = 0; i < enlaces.length; i++) {
        enlaces[i].href = destino;
        enlaces[i].textContent = "Ir a mi panel";
      }
    })
    .catch(function () {
      // Sin red o con la API caída la landing se lee igual. No hay nada que avisar.
    });
})();
