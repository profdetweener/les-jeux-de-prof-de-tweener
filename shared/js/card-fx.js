/**
 * Accueil : un effet de survol propre a chaque jeu (cartes avec data-fx).
 *
 *  - petitbac    : une lettre est tiree a la roulette, a cote du titre
 *  - sesame      : les lettres du titre se retournent en tuiles colorees
 *  - definitions : un mot et sa definition s'ecrivent a la machine
 *  - blindtest   : un egaliseur danse a cote du titre
 *  - pression    : la carte chauffe jusqu'au rouge puis tremble (CSS seul)
 *  - motsmeles   : les lettres du titre se melangent puis se remettent en place
 *
 * Rien ne se passe sur un ecran tactile (pas de survol), ni quand le systeme
 * demande de reduire les animations : les cartes restent comme avant.
 */
(function () {
  var canHover = window.matchMedia && matchMedia("(hover: hover) and (pointer: fine)").matches;
  var calm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!canHover || calm) return;

  // Carte Definitions : a chaque survol, un mot ou une expression et sa
  // definition, tapes a la machine (un autre a chaque fois).
  var DEFINITIONS = [
    ["Ultracrépidarianisme", "donner son avis sur un sujet qu'on ne connaît pas."],
    ["Sérendipité", "faire par hasard une découverte qu'on ne cherchait pas."],
    ["Procrastiner", "remettre à plus tard ce qu'on pourrait faire tout de suite."],
    ["Bayer aux corneilles", "rester bouche bée, le nez en l'air, à ne rien faire."],
    ["Tergiverser", "hésiter et chercher des détours pour éviter de décider."],
    ["Avoir le cafard", "avoir des idées noires, se sentir triste."],
    ["Pinailler", "chicaner sur des détails sans importance."],
    ["Poser un lapin", "ne pas venir à un rendez-vous."],
  ];
  var defLast = -1;
  // Lettres du Petit Bac (sans les lettres trop rares).
  var PB_LETTERS = "ABCDEFGHIJLMNOPRSTV";
  // Couleurs des tuiles de Sesame : bien placee, mal placee, absente.
  var SESAME_COLORS = ["g", "y", "g", "r", "g", "y"];

  function rnd(str) { return str[Math.floor(Math.random() * str.length)]; }

  function hover(card, enter, leave) {
    card.addEventListener("mouseenter", enter);
    card.addEventListener("mouseleave", leave);
  }

  // Petit element place juste apres le titre (ne pousse pas les plateformes).
  function afterTitle(card, el) {
    var title = card.querySelector(".game-card-title");
    title.insertAdjacentElement("afterend", el);
    return el;
  }

  var FX = {
    petitbac: function (card) {
      var box = afterTitle(card, document.createElement("span"));
      box.className = "fx-letter";
      box.setAttribute("aria-hidden", "true");
      var t = null;
      hover(card, function () {
        var n = 0;
        clearTimeout(t);
        box.classList.remove("done");
        (function spin() {
          box.textContent = rnd(PB_LETTERS);
          n++;
          if (n < 16) t = setTimeout(spin, 40 + n * n * 1.2);
          else box.classList.add("done");
        })();
      }, function () {
        clearTimeout(t);
        box.classList.remove("done");
        box.textContent = "";
      });
    },

    sesame: function (card) {
      var title = card.querySelector(".game-card-title");
      var word = title.textContent.trim();
      title.setAttribute("aria-label", word);
      title.innerHTML = "";
      Array.prototype.forEach.call(word, function (c, i) {
        var s = document.createElement("span");
        s.className = "fx-tile " + (SESAME_COLORS[i] || "g");
        s.style.setProperty("--i", i);
        s.setAttribute("aria-hidden", "true");
        s.textContent = c;
        title.appendChild(s);
      });
    },

    definitions: function (card) {
      var p = card.querySelector(".game-card-tagline");
      var orig = p.innerHTML;
      var t = null;
      hover(card, function () {
        var k;
        do { k = Math.floor(Math.random() * DEFINITIONS.length); } while (k === defLast && DEFINITIONS.length > 1);
        defLast = k;
        var word = DEFINITIONS[k][0], def = " : " + DEFINITIONS[k][1];
        var full = word + def;
        var i = 0;
        clearInterval(t);
        p.classList.add("fx-typing");
        p.textContent = "";
        var b = document.createElement("strong");
        var rest = document.createTextNode("");
        p.appendChild(b); p.appendChild(rest);
        t = setInterval(function () {
          i++;
          b.textContent = full.slice(0, Math.min(i, word.length));
          rest.textContent = i > word.length ? full.slice(word.length, i) : "";
          if (i >= full.length) clearInterval(t);
        }, 28);
      }, function () {
        clearInterval(t);
        p.classList.remove("fx-typing");
        p.innerHTML = orig;
      });
    },

    blindtest: function (card) {
      var eq = afterTitle(card, document.createElement("span"));
      eq.className = "fx-eq";
      eq.setAttribute("aria-hidden", "true");
      eq.innerHTML = "<i></i><i></i><i></i><i></i><i></i>";
    },

    pression: function () { /* tout est dans le CSS */ },

    motsmeles: function (card) {
      var title = card.querySelector(".game-card-title");
      var word = title.textContent;
      var t = null;
      // Les lettres du titre melangees entre elles (une anagramme), puis
      // remises en place une a une.
      function shuffled(fixed) {
        var free = [];
        for (var i = fixed; i < word.length; i++) if (word[i] !== " ") free.push(word[i]);
        for (var j = free.length - 1; j > 0; j--) {
          var k = Math.floor(Math.random() * (j + 1));
          var tmp = free[j]; free[j] = free[k]; free[k] = tmp;
        }
        var out = "";
        for (var m = 0; m < word.length; m++) {
          out += m < fixed || word[m] === " " ? word[m] : free.shift();
        }
        return out;
      }
      hover(card, function () {
        var f = 0;
        clearInterval(t);
        t = setInterval(function () {
          f++;
          var fixed = Math.floor(f / 3);
          title.textContent = fixed >= word.length ? word : shuffled(fixed);
          if (fixed >= word.length) clearInterval(t);
        }, 50);
      }, function () {
        clearInterval(t);
        title.textContent = word;
      });
    },
  };

  document.querySelectorAll(".game-card[data-fx]").forEach(function (card) {
    var fx = FX[card.dataset.fx];
    if (fx) { fx(card); card.classList.add("fx-on"); }
  });
})();
