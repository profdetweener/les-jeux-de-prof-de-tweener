# Les jeux du Prof de Tweener

Plateforme multi-jeux multijoueur en ligne, sans inscription, sans pub.

URL : https://profdetweener.github.io/les-jeux-de-prof-de-tweener/

## Jeux disponibles

- **Petit Bac** — Le classique, en multijoueur temps réel avec validation collaborative.
- **Motus** — Mode chill (stream, solo) et mode compétitif multijoueur.
- **Définitions** — Un mot difficile, chacun écrit sa définition, la vraie est révélée, puis tout le monde se note dans une grille (matrice de votes, moyenne tronquée).

## Jeux à venir

- Modération des votes par l'hôte et notation par IA pour **Définitions** (reportées après la v1).

## Architecture

```
les-jeux-de-prof-de-tweener/
├── index.html                  Page d'accueil multi-jeux
├── shared/                     Code partagé entre tous les jeux
│   ├── css/landing.css         Styles de la page d'accueil
│   └── js/
│       ├── config.js           URL du Worker (auto-detect dev/prod)
│       ├── api.js              Client HTTP (createRoom, roomExists, ping)
│       ├── toast.js            Notifications transitoires
│       └── ws.js               Wrapper WebSocket avec reconnexion auto
├── petitbac/                   Jeu Petit Bac (frontend)
│   ├── *.html                  Pages : index, room, regles, mentions
│   ├── css/style.css           Styles du jeu
│   └── js/                     Modules JS (vanilla, ES modules)
└── worker/                     Backend Cloudflare Workers
    ├── wrangler.toml           Config du worker (nom, DOs, migrations)
    ├── package.json
    └── src/
        ├── index.ts            Routeur HTTP/WS multi-jeux
        ├── shared/             Code partagé entre les DOs
        │   ├── types.ts        ROOM_CONFIG, PlayerInfo, SharedErrorCode
        │   └── moderation.ts   Validation de pseudo
        └── petitbac/           Implementation Petit Bac
            ├── messages.ts     Types du protocole (Client/ServerMessage)
            ├── room.ts         Durable Object PetitBacRoom
            └── scoring.ts      Logique de scoring + validation
```

## Routes du Worker

- `GET  /` — sante (texte)
- `GET  /ping` — sante (JSON)
- `POST /petitbac/rooms` — cree une room Petit Bac
- `GET  /petitbac/rooms/:code/exists` — verifie l'existence
- `GET  /petitbac/room/:code` — upgrade WebSocket vers PetitBacRoom (Durable Object)

Les anciennes routes `/rooms`, `/rooms/:code/exists`, `/room/:code` sont aussi
acceptees et redirigees vers Petit Bac (retrocompat pendant la transition).

Le jeu **Définitions** suit le même schéma sous le préfixe `/definitions/`
(`POST /definitions/rooms`, `GET /definitions/rooms/:code/exists`,
`GET /definitions/room/:code` → Durable Object `DefinitionRoom`).

## Deploiement

### Frontend (GitHub Pages)

Push sur `main` → GitHub Pages publie automatiquement le contenu racine.

### Worker (Cloudflare)

```bash
cd worker
npm install
npx wrangler deploy
```
