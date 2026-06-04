/**
 * Banque de mots / expressions difficiles + leur vraie definition, embarquee
 * "en dur" dans le worker (cf. demande : la vraie definition est codee, puis
 * revelee en fin de manche).
 *
 * Regles de redaction des definitions :
 *   - concises (1 a 2 propositions), style dictionnaire
 *   - pas le mot lui-meme dans sa definition
 *   - francais courant, sens principal du terme
 *
 * Le tirage evite les repetitions au sein d'une meme partie (cf. drawWord).
 */

export interface WordEntry {
  /** Le mot ou l'expression a definir (affiche tel quel aux joueurs). */
  word: string;
  /** La vraie definition, revelee a la fin de la phase d'ecriture. */
  definition: string;
}

export const WORD_BANK: WordEntry[] = [
  // --- Mots rares ---
  { word: "acariâtre", definition: "D'un caractère désagréable, hargneux et grincheux." },
  { word: "abscons", definition: "Difficile à comprendre, obscur." },
  { word: "ataraxie", definition: "Tranquillité de l'âme, absence totale de trouble et d'inquiétude." },
  { word: "atavisme", definition: "Réapparition chez un individu de caractères hérités d'ancêtres éloignés." },
  { word: "atrabilaire", definition: "D'humeur sombre, chagrine et irritable." },
  { word: "cacochyme", definition: "D'une constitution faible et maladive ; languissant." },
  { word: "circonlocution", definition: "Manière détournée et longue d'exprimer une pensée ; périphrase." },
  { word: "concupiscence", definition: "Penchant vif vers les plaisirs des sens." },
  { word: "déliquescent", definition: "En pleine décadence ; qui se décompose, se délite." },
  { word: "diaphane", definition: "Qui laisse passer la lumière sans être tout à fait transparent ; translucide." },
  { word: "ésotérique", definition: "Réservé aux seuls initiés ; difficile à comprendre pour le profane." },
  { word: "fallacieux", definition: "Trompeur, fondé sur une apparence mensongère." },
  { word: "fuligineux", definition: "Qui a la couleur sombre de la suie ; par extension, obscur, confus." },
  { word: "génuflexion", definition: "Action de fléchir le genou, notamment en signe de respect ou de soumission." },
  { word: "hagiographie", definition: "Biographie d'un saint ; par extension, récit excessivement élogieux." },
  { word: "idoine", definition: "Qui convient parfaitement à un usage ; approprié." },
  { word: "incoercible", definition: "Qu'on ne peut ni réprimer ni contenir." },
  { word: "ineffable", definition: "Qui ne peut être exprimé par des mots, tant il est intense." },
  { word: "jérémiade", definition: "Plainte sans fin, lamentation importune." },
  { word: "kafkaïen", definition: "Qui rappelle l'absurdité oppressante et bureaucratique des récits de Kafka." },
  { word: "lénifiant", definition: "Qui apaise, adoucit ; parfois péjoratif : mièvre, rassurant à l'excès." },
  { word: "logorrhée", definition: "Flux de paroles abondant, intarissable et souvent confus." },
  { word: "mansuétude", definition: "Disposition à pardonner ; douceur, indulgence et bonté." },
  { word: "nyctalope", definition: "Qui voit bien dans l'obscurité." },
  { word: "obvier", definition: "Parer à un inconvénient, prévenir un mal (obvier à quelque chose)." },
  { word: "oblong", definition: "Plus long que large ; de forme allongée et arrondie." },
  { word: "palinodie", definition: "Changement complet d'opinion ; rétractation de ce qu'on avait soutenu." },
  { word: "prolixe", definition: "Trop long, qui s'étend exagérément en paroles ou en écrits." },
  { word: "pusillanime", definition: "Qui manque de courage et de fermeté ; craintif, timoré." },
  { word: "quintessence", definition: "Ce qu'il y a de plus pur, de plus raffiné et d'essentiel dans une chose." },
  { word: "rébarbatif", definition: "D'aspect rebutant, désagréable et peu engageant." },
  { word: "sibyllin", definition: "Dont le sens est obscur, énigmatique, à double entente." },
  { word: "thaumaturge", definition: "Personne qui accomplit, ou prétend accomplir, des miracles." },
  { word: "ubuesque", definition: "D'une absurdité grotesque et cruelle, à la manière du personnage d'Ubu." },
  { word: "velléité", definition: "Intention faible et passagère qui ne se traduit pas en acte." },
  { word: "vespéral", definition: "Qui se rapporte au soir, au crépuscule." },
  { word: "zygomatique", definition: "Qui se rapporte à la pommette ; se dit du muscle qui sert à sourire." },
  { word: "alacrité", definition: "Vivacité enjouée, entrain joyeux." },
  { word: "byzantin", definition: "Se dit d'une discussion d'un raffinement excessif et oiseux." },
  { word: "déhiscent", definition: "(Botanique) Qui s'ouvre de lui-même à maturité pour libérer ses graines." },
  { word: "épigone", definition: "Successeur ou imitateur sans originalité de quelqu'un." },
  { word: "factotum", definition: "Personne employée à toutes sortes de tâches diverses." },
  { word: "matois", definition: "Rusé sous une apparence de bonhomie." },
  { word: "obséquieux", definition: "Qui pousse la politesse et l'empressement jusqu'à la servilité." },
  { word: "pérorer", definition: "Discourir longuement et avec emphase, d'un air important." },
  { word: "sycophante", definition: "Délateur, dénonciateur ; flatteur servile." },
  { word: "turpitude", definition: "Conduite honteuse, ignominie morale." },

  // --- Expressions ---
  { word: "tomber en quenouille", definition: "Passer aux mains d'une femme faute d'héritier mâle ; par extension, péricliter, tomber à l'abandon." },
  { word: "battre la campagne", definition: "Divaguer, déraisonner, tenir des propos sans suite." },
  { word: "tenir la dragée haute à quelqu'un", definition: "Lui faire payer cher ce qu'il désire ; lui résister, ne pas céder facilement." },
  { word: "faire chou blanc", definition: "Échouer complètement, ne rien obtenir." },
  { word: "ménager la chèvre et le chou", definition: "Tenter de contenter deux partis opposés sans froisser ni l'un ni l'autre." },
  { word: "courir sur le haricot", definition: "Importuner, agacer fortement quelqu'un." },
  { word: "prendre des vessies pour des lanternes", definition: "Se tromper grossièrement, se laisser abuser par de fausses apparences." },
  { word: "avoir maille à partir", definition: "Avoir un différend, une querelle avec quelqu'un." },
  { word: "être au four et au moulin", definition: "Devoir s'occuper de plusieurs choses à la fois, être partout en même temps." },
  { word: "se perdre en conjectures", definition: "Multiplier les suppositions sans parvenir à une certitude." },
];

/**
 * Tire une entree (mot + definition) dans la banque, en evitant celles deja
 * tirees dans la partie (par index). Si tout a ete tire, on repart de zero.
 *
 * @param alreadyDrawn liste des index deja tires durant la partie
 * @returns l'index tire et l'entree correspondante
 */
export function drawWord(
  alreadyDrawn: number[]
): { index: number; entry: WordEntry } {
  const allIndices = WORD_BANK.map((_, i) => i);
  const remaining = allIndices.filter((i) => !alreadyDrawn.includes(i));
  const candidates = remaining.length > 0 ? remaining : allIndices;
  const buf = new Uint8Array(1);
  crypto.getRandomValues(buf);
  const index = candidates[buf[0] % candidates.length];
  return { index, entry: WORD_BANK[index] };
}
