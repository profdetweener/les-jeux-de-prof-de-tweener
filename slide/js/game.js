"use strict";
// Slide, proto solo. Plateau commun, decalage facon Dekal, groupes de meme valeur.
// La partie demarre depuis l'ecran de parametres (taille de grille, objectif).

// ---- Parametres reglables ----
let N = 5;                                  // taille de grille (choisie a l'ecran de setup)
let TARGET = 50;                            // objectif de score (choisi au setup)
const VALUES = [1,2,3,4,5,6,7,8,9,10];      // valeurs de cartes (moins de valeurs = groupes plus frequents)
const PER_VALUE = 10;                       // cartes par valeur dans le sac
const RIVER = 3;                            // taille de riviere (solo)

// Teinte par famille de chiffre, repartie sur la roue chromatique. S'adapte au nombre de valeurs.
function hues(v){
  const i = VALUES.indexOf(v), n = VALUES.length;
  const h = Math.round(i * 300 / n);
  return { base:`hsl(${h} 60% 48%)`, dark:`hsl(${h} 60% 37%)`, tint:`hsl(${h} 52% 92%)` };
}

// ---- Etat ----
let nextId = 1, bag = [], board = [], river = [], score = 0, turns = 0;
let phase = "select", selRiver = -1, litGroups = [];
const $ = id => document.getElementById(id);

function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function makeCard(v){ return { id: nextId++, value: v }; }
function rebuildValues(){ const a=[]; for(const v of VALUES) for(let k=0;k<PER_VALUE;k++) a.push(v); return a; }
function draw(){ if(bag.length===0) bag=shuffle(rebuildValues()); return makeCard(bag.shift()); }
function toBag(v){ bag.push(v); }

function newGame(){
  nextId=1; score=0; turns=0; phase="select"; selRiver=-1; litGroups=[];
  document.documentElement.style.setProperty("--n", N);
  document.documentElement.style.setProperty("--c",
    "clamp(38px," + Math.floor(86/N) + "vw," + (N<=4?64:N===5?56:48) + "px)");
  bag = shuffle(rebuildValues());
  while(bag.length < N*N + RIVER) bag = bag.concat(shuffle(rebuildValues()));
  board = [];
  for(let r=0;r<N;r++){ const row=[]; for(let c=0;c<N;c++) row.push(makeCard(bag.shift())); board.push(row); }
  river = []; while(river.length < RIVER) river.push(makeCard(bag.shift()));
  render(); setStatus("Choisis une carte dans la rivière.");
}

// ---- Voisinages, par identite de carte ----
function key(a,b){ return a<b ? a+"-"+b : b+"-"+a; }
function edgesOf(b){
  const e = new Set();
  for(let r=0;r<N;r++) for(let c=0;c<N;c++){
    const cur=b[r][c]; if(!cur) continue;
    if(c+1<N && b[r][c+1] && b[r][c+1].value===cur.value) e.add(key(cur.id,b[r][c+1].id));
    if(r+1<N && b[r+1][c] && b[r+1][c].value===cur.value) e.add(key(cur.id,b[r+1][c].id));
  }
  return e;
}
function components(b){
  const seen = Array.from({length:N}, ()=>Array(N).fill(false));
  const comps = [];
  for(let r=0;r<N;r++) for(let c=0;c<N;c++){
    if(seen[r][c] || !b[r][c]) continue;
    const val=b[r][c].value, st=[[r,c]], cells=[], es=new Set(); seen[r][c]=true;
    while(st.length){
      const p=st.pop(), cr=p[0], cc=p[1]; cells.push({r:cr,c:cc,value:val});
      const nb=[[cr-1,cc],[cr+1,cc],[cr,cc-1],[cr,cc+1]];
      for(const q of nb){
        const nr=q[0], nc=q[1];
        if(nr<0||nc<0||nr>=N||nc>=N||!b[nr][nc]||b[nr][nc].value!==val) continue;
        es.add(key(b[cr][cc].id,b[nr][nc].id));
        if(!seen[nr][nc]){ seen[nr][nc]=true; st.push([nr,nc]); }
      }
    }
    if(cells.length>=2) comps.push({cells,value:val,edges:es});
  }
  return comps;
}
function getLine(t,i){ const l=[]; for(let k=0;k<N;k++) l.push(t==="row"?board[i][k]:board[k][i]); return l; }
function setLine(t,i,a){ for(let k=0;k<N;k++){ if(t==="row") board[i][k]=a[k]; else board[k][i]=a[k]; } }

// ---- Le coup ----
function doPush(t,idx,fromStart){
  if(phase!=="aim" || selRiver<0) return;
  const before = edgesOf(board);
  const line = getLine(t,idx);
  const inserted = river[selRiver];
  let fallen, nl;
  if(fromStart){ fallen=line[N-1]; nl=[inserted].concat(line.slice(0,N-1)); }
  else{ fallen=line[0]; nl=line.slice(1).concat([inserted]); }
  setLine(t,idx,nl); toBag(fallen.value); river.splice(selRiver,1); selRiver=-1;
  const after = edgesOf(board);
  const isNew = k => after.has(k) && !before.has(k);
  litGroups = components(board).filter(cp => Array.from(cp.edges).some(isNew));
  turns++;
  if(litGroups.length===0){ render(); toast("Aucun groupe formé."); setTimeout(advanceTurn,650); }
  else { phase="claim"; render(); setStatus("Clique un groupe en couleur pour l'encaisser, ou termine le tour."); }
}
function scoreOf(g){ const n=g.cells.length, v=g.value; return v*n + n*(n-1); }
function claim(g){
  if(phase!=="claim") return;
  score += scoreOf(g);
  for(const cell of g.cells){ toBag(board[cell.r][cell.c].value); board[cell.r][cell.c]=draw(); }
  litGroups = litGroups.filter(x=>x!==g);
  toast("+" + scoreOf(g) + " points");
  if(score>=TARGET){ phase="won"; render(); setStatus("Objectif atteint en "+turns+" tours !"); toast("Gagné en "+turns+" tours"); return; }
  render();
  setStatus(litGroups.length ? "Encore un groupe à prendre, ou termine le tour." : "Termine le tour quand tu veux.");
}
function advanceTurn(){
  while(river.length < RIVER) river.push(draw());
  litGroups=[]; phase="select"; selRiver=-1;
  render(); setStatus("Choisis une carte dans la rivière.");
}

// ---- Rendu ----
function litSet(){ const s=new Set(); for(const g of litGroups) for(const c of g.cells) s.add(c.r+","+c.c); return s; }
function litGroupAt(r,c){ return litGroups.find(g => g.cells.some(x=>x.r===r&&x.c===c)); }
function cellsInComponents(){ const s=new Set(); for(const cp of components(board)) for(const c of cp.cells) s.add(c.r+","+c.c); return s; }
function arw(t,idx,fs,g){ return '<button class="arrow" data-type="'+t+'" data-idx="'+idx+'" data-fs="'+(fs?1:0)+'">'+g+'</button>'; }

function render(){
  $("score").textContent=score; $("goal").textContent=TARGET; $("turns").textContent=turns;
  const aim = phase==="aim";
  const latent = phase!=="claim" ? cellsInComponents() : new Set();
  const lit = litSet();
  const frame = $("frame"); frame.className = "frame" + (aim?" aim":"");

  let html = '<div class="arrow-row">';
  for(let c=0;c<N;c++) html += arw("col",c,true,"\u25BC");
  html += '</div><div class="mid"><div class="arrow-col">';
  for(let r=0;r<N;r++) html += arw("row",r,true,"\u25B6");
  html += '</div><div class="grid">';
  for(let r=0;r<N;r++) for(let c=0;c<N;c++){
    const v=board[r][c].value, col=hues(v); let cls="cell", style="";
    if(lit.has(r+","+c)){ cls+=" lit"; style="background:linear-gradient(160deg,"+col.base+","+col.dark+")"; }
    else if(latent.has(r+","+c)){ style="border-style:dashed;border-color:"+col.base+";background:"+col.tint; }
    html += '<div class="'+cls+'" data-r="'+r+'" data-c="'+c+'" style="'+style+'">'+v+'</div>';
  }
  html += '</div><div class="arrow-col">';
  for(let r=0;r<N;r++) html += arw("row",r,false,"\u25C0");
  html += '</div></div><div class="arrow-row">';
  for(let c=0;c<N;c++) html += arw("col",c,false,"\u25B2");
  html += '</div>';
  frame.innerHTML = html;

  frame.querySelectorAll(".arrow").forEach(btn=>{
    const t=btn.dataset.type, idx=+btn.dataset.idx, fs=btn.dataset.fs==="1";
    btn.onclick = () => { if(phase==="aim" && selRiver>=0) doPush(t,idx,fs); };
    btn.onmouseenter = () => { if(phase==="aim") showPreview(t,idx); };
    btn.onmouseleave = hidePreview;
  });
  if(phase==="claim"){
    frame.querySelectorAll(".cell.lit").forEach(cell=>{
      cell.onclick = () => { const g=litGroupAt(+cell.dataset.r,+cell.dataset.c); if(g) claim(g); };
    });
  }
  renderRiver();
  $("endTurn").style.display = phase==="claim" ? "" : "none";
}

// Apercu : on colore seulement, sans reconstruire le plateau (sinon le clic casse).
function showPreview(t,idx){
  hidePreview();
  document.querySelectorAll("#frame .cell").forEach(cell=>{
    const r=+cell.dataset.r, c=+cell.dataset.c;
    if((t==="row"&&r===idx)||(t==="col"&&c===idx)) cell.classList.add("preview");
  });
}
function hidePreview(){ document.querySelectorAll("#frame .cell.preview").forEach(c=>c.classList.remove("preview")); }

function renderRiver(){
  const rv=$("river"); rv.innerHTML="";
  river.forEach((card,i)=>{
    const d=document.createElement("button");
    d.className="river-card" + (i===selRiver?" sel":"");
    d.textContent=card.value;
    d.disabled = (phase!=="select" && phase!=="aim");
    d.onclick = () => { if(phase==="select"||phase==="aim"){ selRiver=i; phase="aim"; render(); setStatus("Clique une flèche pour insérer le "+card.value+"."); } };
    rv.appendChild(d);
  });
}

let toastT=null;
function toast(m){ const t=$("toast"); t.textContent=m; t.className="toast show"; clearTimeout(toastT); toastT=setTimeout(()=>t.className="toast",1400); }
function setStatus(m){ $("status").textContent=m; }

// ---- Ecran de parametres, puis partie ----
function startGame(){ $("setup").hidden=true; $("game").hidden=false; newGame(); }
function showSetup(){ $("game").hidden=true; $("setup").hidden=false; }

function wireSeg(segId, apply){
  const seg=$(segId); if(!seg) return;
  seg.querySelectorAll("button").forEach(b=>{
    b.onclick=()=>{ seg.querySelectorAll("button").forEach(x=>x.classList.remove("on")); b.classList.add("on"); apply(b); };
  });
}
wireSeg("sizeSeg", b => { N = +b.dataset.n; });
wireSeg("targetSeg", b => { TARGET = +b.dataset.t; });
$("launchBtn").onclick = startGame;
$("endTurn").onclick = () => { if(phase==="claim") advanceTurn(); };
$("reset").onclick = newGame;
$("backSetup").onclick = showSetup;
