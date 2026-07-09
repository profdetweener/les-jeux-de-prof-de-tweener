/**
 * DefinitionVotes — Durable Object unique (singleton) qui agrege les votes
 * de difficulte emis par les joueurs en mode chill.
 *
 * Pourquoi un Durable Object plutot qu'un formulaire de contact (comme sur le
 * Blind Test) : le Blind Test est un site statique, sans serveur. Ici, le worker
 * existe deja. On ecrit donc directement cote serveur : pas de mail, pas de
 * service tiers, pas de donnee personnelle.
 *
 * Stockage : cle-valeur (comme les autres DO du projet), une entree par mot.
 *   "v:<mot>" -> { sum: number, count: number }
 * On ne stocke QUE des agregats. Aucun identifiant de joueur, aucune IP,
 * aucun horodatage individuel.
 *
 * Routes internes (appelees par le worker) :
 *   POST /vote    { word, score }   -> incremente l'agregat
 *   GET  /export                    -> CSV de tous les agregats
 *   GET  /stats                     -> compteurs globaux (diagnostic)
 */

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

interface VoteAggregate {
  sum: number;
  count: number;
}

export class DefinitionVotes {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/vote") {
      return this.handleVote(request);
    }
    if (request.method === "GET" && url.pathname === "/export") {
      return this.handleExport();
    }
    if (request.method === "GET" && url.pathname === "/stats") {
      return this.handleStats();
    }
    return new Response("Not Found", { status: 404 });
  }

  /** Enregistre un vote. Le score est borne et arrondi au dixieme. */
  private async handleVote(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "JSON invalide" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    const { word, score } = (body ?? {}) as { word?: unknown; score?: unknown };

    if (typeof word !== "string" || word.length === 0 || word.length > 80) {
      return new Response(JSON.stringify({ error: "Mot invalide" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const s = typeof score === "number" ? score : Number(score);
    if (!Number.isFinite(s) || s < 1 || s > 5) {
      return new Response(JSON.stringify({ error: "Note hors de 1..5" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }
    const rounded = Math.round(s * 10) / 10;

    const key = `v:${word}`;
    // blockConcurrencyWhile garantit un increment atomique : deux votes
    // simultanes sur le meme mot ne peuvent pas s'ecraser.
    let agg: VoteAggregate = { sum: 0, count: 0 };
    await this.state.blockConcurrencyWhile(async () => {
      const cur = await this.state.storage.get<VoteAggregate>(key);
      agg = cur ?? { sum: 0, count: 0 };
      agg.sum += rounded;
      agg.count += 1;
      await this.state.storage.put(key, agg);
    });

    return new Response(
      JSON.stringify({
        ok: true,
        count: agg.count,
        moyenne: Math.round((agg.sum / agg.count) * 100) / 100,
      }),
      { headers: JSON_HEADERS }
    );
  }

  /** Lit tous les agregats, en paginant (storage.list plafonne a 1000 cles). */
  private async readAll(): Promise<Array<[string, VoteAggregate]>> {
    const out: Array<[string, VoteAggregate]> = [];
    let startAfter: string | undefined = undefined;
    for (;;) {
      const page: Map<string, VoteAggregate> = await this.state.storage.list<VoteAggregate>({
        prefix: "v:",
        limit: 1000,
        startAfter,
      });
      if (page.size === 0) break;
      for (const [k, v] of page) out.push([k.slice(2), v]);
      startAfter = [...page.keys()][page.size - 1];
      if (page.size < 1000) break;
    }
    return out;
  }

  /** Export CSV : mot ; moyenne ; nb_votes. Trie par nombre de votes decroissant. */
  private async handleExport(): Promise<Response> {
    const rows = await this.readAll();
    rows.sort((a, b) => b[1].count - a[1].count);

    const esc = (s: string) => (/[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = ["mot;moyenne_votee;nb_votes"];
    for (const [word, agg] of rows) {
      const moy = Math.round((agg.sum / agg.count) * 100) / 100;
      lines.push(`${esc(word)};${String(moy).replace(".", ",")};${agg.count}`);
    }
    // BOM UTF-8 pour qu'Excel affiche correctement les accents.
    return new Response("\uFEFF" + lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="votes_difficulte.csv"',
      },
    });
  }

  private async handleStats(): Promise<Response> {
    const rows = await this.readAll();
    const totalVotes = rows.reduce((n, [, a]) => n + a.count, 0);
    return new Response(
      JSON.stringify({ mots_votes: rows.length, votes_total: totalVotes }),
      { headers: JSON_HEADERS }
    );
  }
}
