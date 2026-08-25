/* -----------------------------------------------------------------------------
   Suite de tests hors ligne. Aucun appel réseau, aucune clé d'API :
   on vérifie les règles métier qui, si elles cassent, font perdre de l'argent
   ou trompent le client.

   Lancement :  node --test
   ----------------------------------------------------------------------------- */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PLANS, ENGINES, INTENTS, VARIANTS, questions, looseParse, isAdminEmail }
  from '../api/scan.js';

/* ═══ 1. Conformité à la grille tarifaire publiée ═══════════════════════════
   Ces valeurs sont celles annoncées sur la page Tarifs. Si l'une change ici
   sans changer là-bas, on vend autre chose que ce qui est facturé.        */

const GRILLE = {
  free:   { questions: 8,  moteurs: 1, competitors: 0, actions: 0,
            everyHours: null, oneShot: true,
            fixes: false, history: false, alerts: false, pdf: false, agency: false },
  plus:   { questions: 20, moteurs: 3, competitors: 2, actions: 5,
            everyHours: 48, oneShot: false,
            fixes: true, history: true, alerts: false, pdf: false, agency: false },
  pro:    { questions: 60, moteurs: 4, competitors: 5, actions: 10,
            everyHours: 24, oneShot: false,
            fixes: true, history: true, alerts: true, pdf: true, agency: false },
  agence: { questions: 60, moteurs: 4, competitors: 5, actions: 10,
            everyHours: 24, oneShot: false,
            fixes: true, history: true, alerts: true, pdf: true, agency: true }
};

test('les formules exposées sont exactement celles de la grille', () => {
  assert.deepEqual(Object.keys(PLANS).sort(), Object.keys(GRILLE).sort());
});

for (const [nom, attendu] of Object.entries(GRILLE)) {
  test(`formule « ${nom} » conforme à la grille`, () => {
    const p = PLANS[nom];
    assert.ok(p, `formule ${nom} absente`);
    assert.equal(p.questions, attendu.questions, 'nombre de questions');
    assert.equal(p.engines.length, attendu.moteurs, 'nombre de moteurs');
    assert.equal(p.competitors, attendu.competitors, 'concurrents suivis');
    assert.equal(p.actions, attendu.actions, 'actions correctives');
    assert.equal(p.everyHours, attendu.everyHours, 'cadence de scan');
    assert.equal(!!p.oneShot, attendu.oneShot, 'scan unique');
    for (const droit of ['fixes', 'history', 'alerts', 'pdf', 'agency']) {
      assert.equal(!!p[droit], attendu[droit], `droit « ${droit} »`);
    }
  });
}

/* ═══ 2. Le verrou de la formule gratuite ═══════════════════════════════════
   C'est la règle qui protège le modèle : le gratuit montre le problème,
   jamais la correction.                                                   */

test('le gratuit n\'ouvre aucune fonction payante', () => {
  const f = PLANS.free;
  assert.equal(f.fixes, false, 'le gratuit ne doit jamais livrer les correctifs');
  assert.equal(f.history, false);
  assert.equal(f.alerts, false);
  assert.equal(f.pdf, false);
  assert.equal(f.agency, false);
  assert.equal(f.actions, 0);
  assert.equal(f.competitors, 0);
});

test('le gratuit n\'interroge qu\'un moteur hébergé en Europe', () => {
  assert.deepEqual(PLANS.free.engines, ['mistral']);
  assert.equal(ENGINES.mistral.free, true);
});

test('les moteurs payants ne sont jamais marqués gratuits', () => {
  for (const cle of ['claude', 'openai', 'gemini']) {
    assert.equal(ENGINES[cle].free, false, `${cle} ne doit pas être gratuit`);
  }
});

test('chaque moteur cité par une formule existe vraiment', () => {
  for (const [nom, p] of Object.entries(PLANS)) {
    for (const m of p.engines) {
      assert.ok(ENGINES[m], `formule ${nom} : moteur « ${m} » inconnu`);
    }
  }
});

/* ═══ 3. Génération des questions ═══════════════════════════════════════════ */

const MARQUE = { brand: 'Institut Lumen', activity: 'formation data',
                 city: 'Paris', type: 'default' };

test('le nombre de questions correspond à la formule', () => {
  for (const [nom, p] of Object.entries(PLANS)) {
    const qs = questions(MARQUE, p.questions);
    assert.equal(qs.length, p.questions,
      `formule ${nom} : ${qs.length} questions au lieu de ${p.questions}`);
  }
});

test('aucune question n\'est posée deux fois', () => {
  for (const p of Object.values(PLANS)) {
    const qs = questions(MARQUE, p.questions).map(x => x.q);
    assert.equal(new Set(qs).size, qs.length,
      'doublon : ' + qs.filter((q, i) => qs.indexOf(q) !== i).join(' | '));
  }
});

test('aucun modèle ne fuit dans le texte envoyé aux IA', () => {
  for (const qs of Object.values(PLANS).map(p => questions(MARQUE, p.questions))) {
    for (const { q } of qs) {
      assert.ok(!q.includes('${'), 'interpolation non résolue : ' + q);
      assert.ok(!q.includes('undefined'), 'valeur manquante : ' + q);
      assert.ok(q.trim().length > 10, 'question trop courte : ' + q);
    }
  }
});

test('seules les deux questions de contrôle citent la marque', () => {
  const qs = questions(MARQUE, 20);
  const nommees = qs.filter(x => x.named);
  assert.equal(nommees.length, 2, 'il doit y avoir exactement 2 questions de contrôle');
  for (const x of nommees) {
    assert.ok(x.q.includes(MARQUE.brand), 'la question de contrôle doit citer la marque');
    assert.equal(x.weight, 0, 'une question de contrôle ne pèse rien dans le score');
  }
  for (const x of qs.filter(x => !x.named)) {
    assert.ok(!x.q.includes(MARQUE.brand),
      'une question à l\'aveugle ne doit jamais citer la marque : ' + x.q);
  }
});

test('la ville apparaît quand elle est fournie, « en France » sinon', () => {
  const avec = questions(MARQUE, 8).filter(x => !x.named);
  assert.ok(avec.some(x => x.q.includes('Paris')), 'la ville doit apparaître');
  const sans = questions({ ...MARQUE, city: '' }, 8).filter(x => !x.named);
  assert.ok(sans.some(x => x.q.includes('en France')), '« en France » doit servir de repli');
  assert.ok(!sans.some(x => x.q.includes('Paris')));
});

test('un type de secteur inconnu ne fait pas planter la génération', () => {
  for (const type of ['inexistant', 'hasOwnProperty', 'constructor', '__proto__', '', null]) {
    const qs = questions({ ...MARQUE, type }, 20);
    assert.equal(qs.length, 20, `type « ${type} » : génération cassée`);
  }
});

test('chaque secteur fournit assez de modèles pour la formule Pro', () => {
  const besoin = Math.ceil((PLANS.pro.questions - 2) / VARIANTS.length);
  for (const [secteur, banque] of Object.entries(INTENTS)) {
    assert.ok(Array.isArray(banque), `secteur ${secteur} : la banque doit être un tableau`);
    assert.ok(banque.length >= besoin,
      `secteur ${secteur} : ${banque.length} modèles, il en faut ${besoin}`);
    for (const [poids, tpl] of banque) {
      assert.equal(typeof poids, 'number', `secteur ${secteur} : poids invalide`);
      assert.equal(typeof tpl, 'function', `secteur ${secteur} : modèle invalide`);
    }
  }
});

test('tous les secteurs produisent 60 questions distinctes', () => {
  for (const secteur of Object.keys(INTENTS)) {
    const qs = questions({ ...MARQUE, type: secteur }, 60).map(x => x.q);
    assert.equal(new Set(qs).size, 60,
      `secteur ${secteur} : seulement ${new Set(qs).size} questions distinctes`);
  }
});

/* ═══ 4. Lecture des réponses des IA ════════════════════════════════════════
   Les moteurs encadrent souvent le JSON de texte ou de balises. Un échec
   de lecture se traduisait par un diagnostic vide côté client.           */

test('le JSON est lu même entouré de texte ou de balises', () => {
  const cas = [
    ['{"a":1}', { a: 1 }],
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['Voici le résultat :\n{"a":1}\nBonne journée.', { a: 1 }],
    ['{"a":1,}', { a: 1 }],
    ['{"a":[1,2,],}', { a: [1, 2] }]
  ];
  for (const [brut, attendu] of cas) {
    assert.deepEqual(looseParse(brut), attendu, 'lecture ratée : ' + brut);
  }
});

test('une réponse illisible renvoie null plutôt qu\'une exception', () => {
  for (const brut of ['', null, undefined, 'pas de json ici', '{', '}{']) {
    assert.equal(looseParse(brut), null, 'devrait être null : ' + brut);
  }
});

/* ═══ 5. Administration ════════════════════════════════════════════════════ */

test('la reconnaissance d\'administrateur ignore casse et espaces', () => {
  assert.equal(isAdminEmail('selyriaia@gmail.com'), true);
  assert.equal(isAdminEmail('  SelyriaIA@Gmail.com  '), true);
  assert.equal(isAdminEmail('autre@gmail.com'), false);
  assert.equal(isAdminEmail(''), false);
  assert.equal(isAdminEmail(null), false);
  assert.equal(isAdminEmail(undefined), false);
});

/* ═══ 6. Cohérence entre le serveur et la page ══════════════════════════════
   Les codes de catégorie servent à repérer un problème d'un scan à l'autre.
   Si le serveur en propose un que la page ne sait pas afficher, l'évolution
   devient illisible.                                                      */

const CODES = ['absence_citations', 'prix_errone', 'info_contradictoire',
  'reconnaissance', 'differenciation', 'presence_web', 'avis_reputation',
  'donnees_structurees', 'couverture_geo', 'offre_illisible'];

test('le serveur impose exactement les dix codes de catégorie prévus', async () => {
  const src = await readFile(new URL('../api/scan.js', import.meta.url), 'utf8');
  const ligne = src.split('\n').find(l => l.includes('"code" est OBLIGATOIRE'));
  assert.ok(ligne, 'la consigne sur les codes a disparu du prompt');
  for (const c of CODES) {
    assert.ok(ligne.includes(c), `code « ${c} » absent de la consigne`);
  }
  const cites = [...ligne.matchAll(/\b([a-z]+_[a-z_]+)\b/g)].map(m => m[1]);
  for (const c of new Set(cites)) {
    assert.ok(CODES.includes(c), `code inattendu dans la consigne : « ${c} »`);
  }
});

test('la page sait afficher les quatre niveaux de gravité', async () => {
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const niveau of ['critique', 'important', 'ameliorer', 'optimise']) {
    assert.ok(page.includes(niveau + ':'), `niveau « ${niveau} » absent de la page`);
  }
});

/* ═══ 7. Informations légales ══════════════════════════════════════════════
   Leur absence est sanctionnée avant même la première vente.             */

test('les trois pages légales sont présentes et reliées au pied de page', async () => {
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const vue of ['v-legal', 'v-privacy', 'v-cookies']) {
    assert.ok(page.includes(`id="${vue}"`), `vue ${vue} absente`);
  }
  for (const lien of ['#mentions-legales', '#confidentialite', '#cookies']) {
    assert.ok(page.includes(lien), `lien ${lien} absent du pied de page`);
  }
  assert.ok(page.includes('Vercel Inc.'), 'l\'hébergeur doit être nommé');
  assert.ok(page.includes('cnil.fr'), 'le recours CNIL doit être indiqué');
});

test('toutes les vues déclarées existent dans la page', async () => {
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const m = page.match(/var VIEWS=\[([^\]]+)\]/);
  assert.ok(m, 'la liste des vues est introuvable');
  for (const v of m[1].split(',').map(x => x.trim().replace(/['"]/g, ''))) {
    assert.ok(page.includes(`id="v-${v}"`), `la vue « ${v} » est déclarée mais absente`);
  }
});
