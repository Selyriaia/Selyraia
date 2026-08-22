// api/scan.js
//
// SELYRAIA — passerelle IA + contrôle d'accès
// -----------------------------------------------------------------------------
// POURQUOI CE DÉCOUPAGE : une fonction serverless est coupée au bout de quelques secondes.
// Enchaîner 9 appels IA dans une seule requête dépasse largement cette limite et
// la fonction est tuée avant de répondre. Chaque action ci-dessous ne fait donc
// qu'un seul appel IA, et c'est le navigateur qui enchaîne.
//
// Actions :
//   diag    → état de la configuration serveur (public)
//   me      → formule et quota de l'utilisateur
//   start   → valide le quota, le consomme, renvoie la liste des questions
//   ask     → pose UNE question à l'IA
//   analyze → produit le diagnostic à partir des réponses collectées
//
// Variables d'environnement Vercel :
//   MISTRAL_API_KEY (obligatoire) · SUPABASE_SERVICE_KEY (obligatoire)
//   ANTHROPIC_API_KEY · OPENAI_API_KEY · GEMINI_API_KEY (optionnelles)
// -----------------------------------------------------------------------------

const SUPABASE_URL = 'https://ysafgvpeotvgpyswjgdu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzYWZndnBlb3R2Z3B5c3dqZ2R1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NDQ4NTYsImV4cCI6MjEwMjEyMDg1Nn0.YCTLi3DmaWwDnRETcZscg1__hS9_kN7-xOZg-uAjF8E';

const ADMINS = ['selyriaia@gmail.com'];

const ENGINES = {
  mistral: { label: 'Mistral', env: 'MISTRAL_API_KEY',   model: 'mistral-small-latest',  free: true  },
  claude:  { label: 'Claude',  env: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5',       free: false },
  openai:  { label: 'GPT',     env: 'OPENAI_API_KEY',    model: 'gpt-5.6-luna',          free: false },
  gemini:  { label: 'Gemini',  env: 'GEMINI_API_KEY',    model: 'gemini-3.5-flash-lite', free: false }
};

// Grille des formules. Elle doit correspondre EXACTEMENT à la page tarifaire :
// toute capacité affichée commercialement se lit ici, et nulle part ailleurs.
const PLANS = {
  free: {
    label: 'Découverte', questions: 8,  engines: ['mistral'],
    competitors: 0, actions: 2,  everyHours: null, oneShot: true,
    history: false, alerts: false, pdf: false, agency: false
  },
  plus: {
    label: 'Plus', questions: 20, engines: ['mistral', 'claude', 'gemini'],
    competitors: 2, actions: 5,  everyHours: 48, oneShot: false,
    history: true,  alerts: false, pdf: false, agency: false
  },
  pro: {
    label: 'Pro', questions: 60, engines: ['mistral', 'claude', 'gemini', 'openai'],
    competitors: 5, actions: 10, everyHours: 24, oneShot: false,
    history: true,  alerts: true, pdf: true,  agency: false
  },
  agence: {
    label: 'Agence', questions: 60, engines: ['mistral', 'claude', 'gemini', 'openai'],
    competitors: 5, actions: 10, everyHours: 24, oneShot: false,
    history: true,  alerts: true, pdf: true,  agency: true
  }
};
const planOf = p => PLANS[p] || PLANS.free;

// Les quotas payants se rechargent tous les 30 jours. Le gratuit ne se recharge
// jamais : c'est « un scan offert par compte », pas un scan par mois.
const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const isAdminEmail = e => ADMINS.includes(String(e || '').trim().toLowerCase());

/* ─── Supabase REST ─────────────────────────────────────────────────────── */

async function getUser(token) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` }
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const svc = k => ({ apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' });

async function getProfile(id, email, key) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${id}&select=*`, { headers: svc(key) });
    if (!r.ok) return { _err: `lecture profiles ${r.status}: ${(await r.text()).slice(0, 180)}` };
    const rows = await r.json();
    if (rows.length) return rows[0];
    const c = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST',
      headers: { ...svc(key), Prefer: 'return=representation' },
      body: JSON.stringify({ id, email, plan: 'free', scans_used: 0 })
    });
    if (!c.ok) return { _err: `création profil ${c.status}: ${(await c.text()).slice(0, 180)}` };
    const made = await c.json();
    return made[0] || { id, email, plan: 'free', scans_used: 0 };
  } catch (e) { return { _err: 'Supabase injoignable : ' + e.message }; }
}

async function bump(id, n, key) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${id}`, {
      method: 'PATCH', headers: svc(key),
      body: JSON.stringify({ scans_used: n + 1, last_scan_at: new Date().toISOString() })
    });
  } catch {}
}

// Remet le compteur à zéro quand la période mensuelle est écoulée (formules payantes).
async function rollPeriod(profile, key) {
  if (!profile || !profile.id || (profile.plan || 'free') === 'free') return profile;
  const started = profile.period_start ? Date.parse(profile.period_start) : 0;
  if (started && Date.now() - started < PERIOD_MS) return profile;
  const now = new Date().toISOString();
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${profile.id}`, {
      method: 'PATCH', headers: key ? svc(key) : {},
      body: JSON.stringify({ scans_used: 0, period_start: now })
    });
    return { ...profile, scans_used: 0, period_start: now };
  } catch { return profile; }
}

// Enregistre un scan termine. Ecriture reservee au serveur (cle service).
async function saveScan(row, key) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/scans`, {
      method: 'POST',
      headers: { ...svc(key), Prefer: 'return=representation' },
      body: JSON.stringify(row)
    });
    if (!r.ok) return { _err: `enregistrement ${r.status}: ${(await r.text()).slice(0, 180)}` };
    const made = await r.json();
    return made[0] || null;
  } catch (e) { return { _err: 'Enregistrement impossible : ' + e.message }; }
}

/* ─── Fournisseurs ──────────────────────────────────────────────────────── */

async function callMistral(p, k, m, mx, json) {
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
    body: JSON.stringify(Object.assign({ model: m, messages: [{ role: 'user', content: p }], max_tokens: mx },
      json ? { response_format: { type: 'json_object' } } : {}))
  });
  if (!r.ok) throw new Error(`Mistral ${r.status} — ${(await r.text()).slice(0, 220)}`);
  return (await r.json()).choices?.[0]?.message?.content?.trim() || '';
}

async function callClaude(p, k, m, mx, json) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(Object.assign(
      { model: m, max_tokens: mx, messages: [{ role: 'user', content: p }] },
      json ? { system: "Tu reponds exclusivement par un objet JSON valide, sans aucun texte autour et sans balise de code." } : {}))
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status} — ${(await r.text()).slice(0, 220)}`);
  const d = await r.json();
  return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function callOpenAI(p, k, m, mx, json) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
    body: JSON.stringify(Object.assign({ model: m, messages: [{ role: 'user', content: p }], max_completion_tokens: mx },
      json ? { response_format: { type: 'json_object' } } : {}))
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status} — ${(await r.text()).slice(0, 220)}`);
  return (await r.json()).choices?.[0]?.message?.content?.trim() || '';
}

async function callGemini(p, k, m, mx, json) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${k}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: Object.assign({ maxOutputTokens: mx }, json ? { responseMimeType: 'application/json' } : {}) })
  });
  if (!r.ok) throw new Error(`Gemini ${r.status} — ${(await r.text()).slice(0, 220)}`);
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.map(x => x.text).join('\n').trim() || '';
}

const AD = { mistral: callMistral, claude: callClaude, openai: callOpenAI, gemini: callGemini };

async function ask(name, prompt, mx, json) {
  const e = ENGINES[name];
  const k = process.env[e.env];
  if (!k) throw new Error(`Clé ${e.env} absente des variables d'environnement Vercel.`);
  let last = null;
  for (let essai = 0; essai < 3; essai++) {
    try {
      const t = await AD[name](prompt, k, e.model, mx || 900, json);
      if (t) return t;
      last = new Error('Réponse vide du modèle');
    } catch (err) {
      last = err;
      // 429 = limite de débit, 5xx = incident passager : on repasse après une pause.
      if (!/(^|\D)(429|500|502|503|529)(\D|$)/.test(String(err.message))) break;
      await new Promise(r => setTimeout(r, 900 * (essai + 1)));
    }
  }
  throw last || new Error('Appel impossible');
}

/* ─── Questions par secteur ─────────────────────────────────────────────── */

// Extrait un objet JSON d'une reponse de modele, en reparant les defauts courants.
function looseParse(raw) {
  if (!raw) return null;
  let t = String(raw).replace(/```json|```/g, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch {}
  const fixed = t.replace(/[\u0000-\u001F]+/g, ' ').replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(fixed); } catch {}
  return null;
}

// Banque d'intentions d'achat par secteur : ce sont les vraies questions que
// pose un client, jamais le nom de la marque. Croisée avec les variantes, elle
// fournit 8, 20 ou 60 questions distinctes selon la formule.
const INTENTS = {
  default: [
    [3.0, (a, w) => `Quel est le meilleur ${a}${w} ? Cite des noms précis.`],
    [3.0, (a, w) => `Où faire du ${a}${w} ? Quels prestataires recommandes-tu ?`],
    [2.6, (a, w) => `Quels professionnels du ${a} sont les plus recommandés${w} ?`],
    [2.5, (a, w) => `Je cherche un ${a} sérieux${w}, lequel choisir et pourquoi ?`],
    [2.2, (a, w) => `Quel ${a} offre le meilleur rapport qualité-prix${w} ?`],
    [2.0, (a, w) => `Quels sont les ${a} les mieux notés${w} ?`],
    [1.8, (a, w) => `Vers qui se tourner pour du ${a}${w} quand on débute ?`],
    [1.7, (a, w) => `Quelles sont les alternatives connues en ${a}${w} ?`],
    [1.5, (a, w) => `Comment bien choisir son ${a}${w} ? Donne des exemples concrets.`],
    [1.4, (a, w) => `Quel ${a}${w} pour une demande exigeante ?`],
    [1.2, (a, w) => `Quels ${a}${w} évitent les mauvaises surprises ?`],
    [1.1, (a, w) => `Quel ${a}${w} conseillerais-tu à un proche ?`]
  ],
  school: [
    [3.0, (a, w) => `Quelle école ou quel organisme choisir pour se former en ${a}${w} ? Cite des noms.`],
    [3.0, (a, w) => `Quelle est la meilleure formation en ${a}${w} ?`],
    [2.6, (a, w) => `Quels établissements ${a} sont les mieux reconnus par les employeurs${w} ?`],
    [2.5, (a, w) => `Je veux me reconvertir en ${a}${w}, quelle école choisir et pourquoi ?`],
    [2.2, (a, w) => `Quelle formation ${a} offre le meilleur taux d'insertion professionnelle${w} ?`],
    [2.0, (a, w) => `Quelles écoles ${a} sont éligibles au CPF ou à une alternance${w} ?`],
    [1.8, (a, w) => `Quelle formation ${a}${w} pour un débutant complet ?`],
    [1.7, (a, w) => `Quelles alternatives aux grandes écoles pour ${a}${w} ?`],
    [1.5, (a, w) => `Comment comparer les formations ${a}${w} ? Donne des exemples.`],
    [1.4, (a, w) => `Quelle formation ${a}${w} a la meilleure réputation ?`],
    [1.2, (a, w) => `Quelles écoles ${a}${w} sont à éviter et lesquelles privilégier ?`],
    [1.1, (a, w) => `Quel diplôme en ${a}${w} vaut vraiment l'investissement ?`]
  ],
  creator: [
    [3.0, (a, w) => `Quels créateurs de contenu français suivre en ${a} ? Cite des noms précis.`],
    [3.0, (a, w) => `Quelle chaîne ou quel compte suivre pour du ${a} en français ?`],
    [2.6, (a, w) => `Quels créateurs ${a} sont les plus recommandés ?`],
    [2.5, (a, w) => `Je débute et je cherche du contenu ${a} de qualité, qui me conseilles-tu ?`],
    [2.2, (a, w) => `Quels créateurs ${a} francophones ont le plus d'influence ?`],
    [2.0, (a, w) => `Où trouver du bon contenu ${a} en français ?`],
    [1.8, (a, w) => `Quels créateurs ${a} sont les plus fiables et les mieux documentés ?`],
    [1.7, (a, w) => `Quelles alternatives aux gros créateurs ${a} francophones ?`],
    [1.5, (a, w) => `Quels comptes ${a} suivre pour progresser vraiment ?`],
    [1.4, (a, w) => `Quels créateurs ${a} montent le plus en ce moment ?`],
    [1.2, (a, w) => `Quels créateurs ${a} conseillerais-tu à un ami ?`],
    [1.1, (a, w) => `Quels créateurs ${a} produisent le contenu le plus sérieux ?`]
  ],
  media: [
    [3.0, (a, w) => `Quels médias suivre pour du ${a}${w} ? Cite des noms.`],
    [3.0, (a, w) => `Quel média est la référence en ${a} en France ?`],
    [2.6, (a, w) => `Quels sont les médias ${a} les plus fiables ?`],
    [2.5, (a, w) => `Où s'informer sérieusement sur ${a} ?`],
    [2.2, (a, w) => `Quels médias français traitent le mieux de ${a} ?`],
    [2.0, (a, w) => `Quelles alternatives aux grands médias pour ${a} ?`],
    [1.8, (a, w) => `Quels médias ${a} pour un lecteur exigeant ?`],
    [1.7, (a, w) => `Quels médias ${a} sont les plus indépendants ?`],
    [1.5, (a, w) => `Comment choisir sa source d'information en ${a} ?`],
    [1.4, (a, w) => `Quels médias ${a} sont les plus consultés ?`],
    [1.2, (a, w) => `Quels médias ${a} recommanderais-tu à un proche ?`],
    [1.1, (a, w) => `Quels médias ${a} évitent les approximations ?`]
  ]
};

// Nuances ajoutées au complément de lieu : elles changent réellement la réponse
// de l'IA sans dénaturer l'intention, et permettent de monter jusqu'à 60 questions.
const VARIANTS = ['', ' en 2026', ' avec de très bons retours', ' pour un budget serré', ' pour un projet exigeant'];

function questions(d, count) {
  const { brand, activity, city, type } = d;
  const base = city ? ` à ${city}` : ' en France';
  const bank = INTENTS[type] || INTENTS.default;
  const target = Math.max(6, Number(count) || 8) - 2;   // 2 questions de contrôle
  const out = [];
  for (let v = 0; v < VARIANTS.length && out.length < target; v++) {
    for (let i = 0; i < bank.length && out.length < target; i++) {
      const [weight, tpl] = bank[i];
      out.push({ q: tpl(activity, base + VARIANTS[v]), named: false,
                 weight: Math.round(weight * (1 - v * 0.12) * 100) / 100 });
    }
  }
  // Questions de contrôle : le nom est cité, elles ne comptent pas dans le score.
  out.push({ q: `Que vaut ${brand} ? Que proposent-ils exactement et à quel prix ?`, named: true, weight: 0 });
  out.push({ q: `Quels sont les tarifs, les conditions et la réputation de ${brand} ?`, named: true, weight: 0 });
  return out;
}

/* ─── Entrée ────────────────────────────────────────────────────────────── */

export default { async fetch(request) {
  const H = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  const fail = (m, c) => new Response(JSON.stringify({ error: m }), { status: c, headers: H });
  const ok = o => new Response(JSON.stringify(o), { status: 200, headers: H });

  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: H });
  if (request.method !== 'POST') return fail('Méthode non autorisée', 405);

  let b = {};
  try { b = await request.json(); } catch {}
  const action = b.action || 'me';

  if (action === 'diag') {
    return ok({
      fonction: 'en ligne',
      MISTRAL_API_KEY: !!process.env.MISTRAL_API_KEY,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY
    });
  }

  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return fail('Connectez-vous pour lancer un scan.', 401);
  const user = await getUser(token);
  if (!user || !user.id) return fail('Session expirée. Reconnectez-vous.', 401);

  const admin = isAdminEmail(user.email);
  const svcKey = process.env.SUPABASE_SERVICE_KEY;

  let profile = { id: user.id, email: user.email, plan: 'free', scans_used: 0 };
  let dbError = null;
  if (svcKey) {
    const p = await getProfile(user.id, user.email, svcKey);
    if (p && p._err) dbError = p._err; else profile = p;
  } else if (!admin) {
    return fail("SUPABASE_SERVICE_KEY absente des variables d'environnement Vercel.", 500);
  }
  if (dbError && !admin) return fail('Base de données : ' + dbError, 500);

  if (!admin && svcKey && !dbError) profile = await rollPeriod(profile, svcKey);

  // L'admin peut endosser n'importe quelle formule pour la parcourir comme un client.
  const realPlan = profile.plan || 'free';
  const sim = (admin && PLANS[b.simulate]) ? b.simulate : null;
  const plan = sim || (admin ? 'agence' : realPlan);
  const cap = planOf(plan);
  const used = profile.scans_used || 0;

  // Fréquence réelle : le gratuit est un scan à vie, les payants un scan toutes les N heures.
  const lastAt = profile.last_scan_at ? Date.parse(profile.last_scan_at) : 0;
  const nextAt = (cap.everyHours && lastAt) ? lastAt + cap.everyHours * 3600000 : 0;
  const waiting   = !admin && !!cap.everyHours && Date.now() < nextAt;
  const exhausted = !admin && cap.oneShot && used >= 1;

  // Un moteur n'est proposé que si sa clé est réellement présente.
  const allowed = cap.engines.filter(e => !!process.env[ENGINES[e].env]);

  /* ── me ── */
  if (action === 'me') {
    return ok({
      email: user.email, isAdmin: admin, plan, realPlan, simulating: sim, label: cap.label,
      engines: allowed, questions: cap.questions, competitors: cap.competitors,
      actions: cap.actions, history: cap.history, alerts: cap.alerts,
      pdf: cap.pdf, agency: cap.agency, everyHours: cap.everyHours, oneShot: cap.oneShot,
      scansUsed: used, nextScanAt: nextAt || null,
      canScan: admin || (!waiting && !exhausted),
      plans: Object.keys(PLANS).map(k => ({ key: k, label: PLANS[k].label })),
      dbError: admin ? dbError : null
    });
  }

  if (b.engine && !allowed.includes(b.engine)) {
    return fail("Ce moteur n'est pas inclus dans votre formule.", 403);
  }
  const engine = (ENGINES[b.engine] && allowed.includes(b.engine)) ? b.engine : (allowed[0] || 'mistral');
  if (!process.env[ENGINES[engine].env]) {
    return fail(`Clé ${ENGINES[engine].env} absente des variables d'environnement Vercel.`, 500);
  }

  /* ── start : valide, consomme le quota, renvoie les questions ── */
  if (action === 'start') {
    if (exhausted) {
      return fail("Votre scan gratuit a déjà été utilisé sur ce compte. Choisissez une formule pour continuer.", 403);
    }
    if (waiting) {
      const h = Math.max(1, Math.ceil((nextAt - Date.now()) / 3600000));
      return fail(`La formule ${cap.label} autorise un scan toutes les ${cap.everyHours} h. Prochain scan possible dans ${h} h.`, 403);
    }
    if (!allowed.length) return fail("Aucun moteur disponible : clé API manquante.", 500);
    const d = {
      brand: String(b.brand || '').slice(0, 120).trim(),
      activity: String(b.activity || '').slice(0, 160).trim(),
      city: String(b.city || '').slice(0, 80).trim(),
      type: String(b.type || 'default')
    };
    if (d.brand.length < 2 || d.activity.length < 2) return fail('Nom et activité requis.', 400);

    if (!admin && svcKey) await bump(user.id, used, svcKey);

    return ok({
      questions: questions(d, cap.questions),
      engines: allowed,
      engineLabels: allowed.reduce((o, e) => (o[e] = ENGINES[e].label, o), {}),
      plan, label: cap.label, isAdmin: admin, simulating: sim,
      competitors: cap.competitors, actionsMax: cap.actions,
      scansUsed: admin ? used : used + 1
    });
  }

  /* ── ask : une seule question ── */
  if (action === 'ask') {
    const q = String(b.q || '').slice(0, 600).trim();
    if (q.length < 5) return fail('Question vide.', 400);
    const prompt =
      `Tu réponds à un particulier français qui te pose cette question : "${q}". ` +
      `Réponds naturellement en 4 à 6 phrases, en citant de vraies entreprises, marques ou personnes ` +
      `si c'est pertinent. N'invente rien : si tu ne sais pas, dis-le.`;
    try {
      const text = await ask(engine, prompt);
      return ok({ text });
    } catch (e) {
      return fail(String(e.message || e).slice(0, 300), 502);
    }
  }

  /* ── analyze : diagnostic final ── */
  if (action === 'analyze') {
    const brand = String(b.brand || '').slice(0, 120).trim();
    const activity = String(b.activity || '').slice(0, 160).trim();
    const city = String(b.city || '').slice(0, 80).trim();
    const price = String(b.price || '').slice(0, 80).trim();
    const corpus = String(b.corpus || '').slice(0, 9000);
    const hits = Number(b.hits) || 0;
    const total = Number(b.total) || 0;
    const nbActions = cap.actions;                          // 2 / 5 / 10 selon la formule
    const nbConcurrents = Math.max(3, cap.competitors || 3);

    const p =
`Voici les réponses réelles d'une IA à des questions posées par des clients potentiels du marché "${activity}"${city ? ' à ' + city : ''}.

${corpus}

L'entité analysée est "${brand}". Elle apparaît dans ${hits} des ${total} questions où son nom n'était PAS mentionné.${price ? ` Son tarif réel est : ${price}.` : ''}

Analyse avec rigueur et sévérité, comme un auditeur : identifie précisément ce qui ne va pas, ne cherche pas à rassurer. Ne minimise aucun problème, mais n'invente rien qui ne soit pas dans les réponses ci-dessus.

Réponds UNIQUEMENT en JSON valide, sans balise de code, sans texte avant ni après :
{"competitors":["nom1","nom2"],
"verdict":"une phrase factuelle et directe",
"problems":[{"title":"titre court","detail":"explication en une phrase","impact":"conséquence commerciale concrète"}],
"errors":[{"claim":"ce que l'IA affirme d'inexact","reality":"ce qui devrait être dit","gravity":"haute|moyenne|basse"}],
"actions":[{"title":"action concrète","detail":"comment faire en une phrase","priority":"haute|moyenne|basse"}]}

Règles : "competitors" = noms réellement cités à la place de ${brand}, max ${nbConcurrents}, vide si aucun. "problems" = 2 à 4. "errors" = uniquement les inexactitudes réellement visibles, vide si aucune. "actions" = exactement ${nbActions}, de la plus urgente à la moins urgente.`;

    const RETRY = "\n\nTa reponse precedente n'etait pas du JSON valide. Renvoie UNIQUEMENT l'objet JSON, "
      + "en echappant tout guillemet double place a l'interieur d'une valeur texte.";
    let analysis = null, warn = null;
    for (let i = 0; i < 2 && !analysis; i++) {
      try {
        analysis = looseParse(await ask(engine, i ? p + RETRY : p, 2200, true));
        if (!analysis) warn = "Le moteur n'a pas renvoye de JSON exploitable.";
      } catch (e) { warn = String(e.message || e).slice(0, 300); break; }
    }
    return ok({ analysis, warning: analysis ? null : warn });
  }

  /* ── save : conserve le scan termine pour l historique ── */
  if (action === 'save') {
    if (!svcKey) return fail('Base de donnees indisponible.', 500);
    const d = b.data || {};
    const txt = (v, n) => String(v == null ? '' : v).slice(0, n);
    const row = {
      user_id: user.id,
      brand: txt(d.brand, 120).trim(),
      activity: txt(d.activity, 160).trim(),
      city: txt(d.city, 80).trim() || null,
      price: txt(d.price, 80).trim() || null,
      sector: txt(d.sector || 'default', 40),
      plan,
      engines: Array.isArray(d.engines) ? d.engines.slice(0, 4).map(e => txt(e, 20)) : [],
      question_count: Number(d.questionCount) || 0,
      score: Number.isFinite(+d.score) ? Math.round(+d.score) : null,
      margin: Number.isFinite(+d.margin) ? Math.round(+d.margin) : null,
      hits: Number(d.hits) || 0,
      blind_total: Number(d.blindTotal) || 0,
      per_engine: (d.perEngine && typeof d.perEngine === 'object') ? d.perEngine : {},
      competitors: Array.isArray(d.competitors) ? d.competitors.slice(0, 10).map(c => txt(c, 80)) : [],
      verdict: d.verdict ? txt(d.verdict, 600) : null,
      answers: Array.isArray(d.answers) ? d.answers.slice(0, 80) : [],
      problems: Array.isArray(d.problems) ? d.problems.slice(0, 20) : [],
      actions: Array.isArray(d.actions) ? d.actions.slice(0, 20) : [],
      errors: Array.isArray(d.errors) ? d.errors.slice(0, 20) : []
    };
    if (row.brand.length < 2) return fail('Scan incomplet.', 400);
    const saved = await saveScan(row, svcKey);
    if (saved && saved._err) return fail(saved._err, 500);
    return ok({ id: saved ? saved.id : null });
  }

  /* ── history : uniquement les scans de l appelant ── */
  if (action === 'history') {
    if (!svcKey) return ok({ scans: [] });
    try {
      const q = `${SUPABASE_URL}/rest/v1/scans?user_id=eq.${user.id}`
        + `&select=id,created_at,brand,activity,city,score,margin,hits,blind_total,engines,plan`
        + `&order=created_at.desc&limit=50`;
      const r = await fetch(q, { headers: svc(svcKey) });
      return ok({ scans: r.ok ? await r.json() : [] });
    } catch { return ok({ scans: [] }); }
  }

  /* ── detail : filtre sur id ET user_id, donc jamais le scan d autrui ── */
  if (action === 'detail') {
    if (!svcKey) return fail('Base de donnees indisponible.', 500);
    const id = String(b.id || '');
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return fail('Identifiant invalide.', 400);
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/scans?id=eq.${id}&user_id=eq.${user.id}&select=*`,
                            { headers: svc(svcKey) });
      const rows = r.ok ? await r.json() : [];
      if (!rows.length) return fail('Scan introuvable.', 404);
      return ok({ scan: rows[0] });
    } catch (e) { return fail('Lecture impossible : ' + e.message, 500); }
  }

  return fail("Action inconnue.", 400);
} };
