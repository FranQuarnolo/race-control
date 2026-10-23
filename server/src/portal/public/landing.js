// La landing es HTML estático: no necesita JS para mostrarse, y eso es deliberado — es la página
// que ve alguien que todavía no es cliente, y tiene que cargar aunque algo falle.
//
// Lo único que hace este archivo es dos retoques que mejoran la visita sin ser imprescindibles.

(function () {
  // 1. La versión en el pie. Si la API no contesta, el hueco queda vacío y no pasa nada.
  fetch("/api/portal/me", { headers: { "X-RC-Request": "1" } })
    .then(function (res) { return res.json(); })
    .then(function (me) {
      var version = document.getElementById("version");
      if (version && me && me.version) version.textContent = me.version;

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
