// Modules texte : wrangler importe les fichiers .txt comme une chaine (regle
// "Text" par defaut). Declaration pour tsc.
declare module "*.txt" {
  const content: string;
  export default content;
}
