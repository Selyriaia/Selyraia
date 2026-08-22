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
  gemini:  { label: 'Gemini',  env: 'GEMINI_API_KEY',    model: 'gemini-2.5-flash-lite', free: false }
};

const QUOTAS = { free: 1, plus: 40, pro: 200, agence: 2000, admin: 999999 };

// Moteurs inclus dans chaque formule. Le gratuit reste sur Mistral (coût quasi nul).
const ENGINE_ACCESS = {
  free:   ['mistral'],
  plus:   ['mistral', 'claude', 'gemini'],
  pro:    ['mistral', 'claude', 'gemini', 'openai'],
  agence: ['mistral', 'claude', 'gemini', 'openai'],
  admin:  ['mistral', 'claude', 'gemini', 'openai']
};
const enginesFor = p => ENGINE_ACCESS[p] || ENGINE_ACCESS.free;

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

/* ─── Fournisseurs ──────────────────────────────────────────────────────── */

async function callMistral(p, k, m, mx) {
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
    body: JSON.stringify({ model: m, messages: [{ role: 'user', content: p }], max_tokens: mx })
  });
  if (!r.ok) throw new Error(`Mistral ${r.status} — ${(await r.text()).slice(0, 220)}`);
  return (await r.json()).choices?.[0]?.message?.content?.trim() || '';
}

async function callClaude(p, k, m, mx) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: m, max_tokens: mx, messages: [{ role: 'user', content: p }] })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status} — ${(await r.text()).slice(0, 220)}`);
  const d = await r.json();
  return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function callOpenAI(p, k, m, mx) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
    body: JSON.stringify({ model: m, messages: [{ role: 'user', content: p }], max_tokens: mx })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status} — ${(await r.text()).slice(0, 220)}`);
  return (await r.json()).choices?.[0]?.message?.content?.trim() || '';
}

async function callGemini(p, k, m, mx) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${k}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { maxOutputTokens: mx } })
  });
  if (!r.ok) throw new Error(`Gemini ${r.status} — ${(await r.text()).slice(0, 220)}`);
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.map(x => x.text).join('\n').trim() || '';
}

const AD = { mistral: callMistral, claude: callClaude, openai: callOpenAI, gemini: callGemini };

async function ask(name, prompt, mx) {
  const e = ENGINES[name];
  const k = process.env[e.env];
  if (!k) throw new Error(`Clé ${e.env} absente des variables d'environnement Vercel.`);
  const t = await AD[name](prompt, k, e.model, mx || 900);
  if (!t) throw new Error('Réponse vide du modèle');
  return t;
}

/* ─── Questions par secteur ─────────────────────────────────────────────── */

function questions(d) {
  const { brand, activity, city, type } = d;
  const w = city ? ` à ${city}` : ' en France';
  const sets = {
    creator: [
      { q: `Quels créateurs de contenu français suivre en ${activity} ? Cite des noms précis.`, named: false, weight: 3 },
      { q: `Quelle chaîne ou quel compte suivre pour du ${activity} en français ?`, named: false, weight: 3 },
      { q: `Quels créateurs ${activity} sont les plus recommandés en 2026 ?`, named: false, weight: 2.5 },
      { q: `Je débute et je cherche du contenu ${activity} de qualité, qui me conseilles-tu ?`, named: false, weight: 2.5 },
      { q: `Quels créateurs ${activity} francophones ont le plus d'influence ?`, named: false, weight: 2 },
      { q: `Où trouver du bon contenu ${activity} en français ?`, named: false, weight: 1.5 },
      { q: `Que vaut ${brand} ? Que fait cette chaîne ou cette personne exactement ?`, named: true, weight: 0 },
      { q: `Quelle est l'audience, la notoriété et la réputation de ${brand} ?`, named: true, weight: 0 }
    ],
    media: [
      { q: `Quels médias suivre pour du ${activity}${w} ? Cite des noms.`, named: false, weight: 3 },
      { q: `Quel média est la référence en ${activity} en France ?`, named: false, weight: 3 },
      { q: `Quels sont les médias ${activity} les plus fiables en 2026 ?`, named: false, weight: 2.5 },
      { q: `Où s'informer sérieusement sur ${activity} ?`, named: false, weight: 2.5 },
      { q: `Quels médias français traitent le mieux de ${activity} ?`, named: false, weight: 2 },
      { q: `Quelles alternatives aux grands médias pour ${activity} ?`, named: false, weight: 1.5 },
      { q: `Que vaut ${brand} comme média ? Quelle est sa ligne éditoriale ?`, named: true, weight: 0 },
      { q: `Quelle est l'audience de ${brand} et sa réputation ?`, named: true, weight: 0 }
    ],
    school: [
      { q: `Quelle école ou quel organisme choisir pour se former en ${activity}${w} ? Cite des noms.`, named: false, weight: 3 },
      { q: `Quelle est la meilleure formation en ${activity}${w} ? Laquelle recommandes-tu ?`, named: false, weight: 3 },
      { q: `Quels établissements ${activity} sont les mieux reconnus par les employeurs${w} ?`, named: false, weight: 2.5 },
      { q: `Je veux me reconvertir en ${activity}${w}, quelle école choisir et pourquoi ?`, named: false, weight: 2.5 },
      { q: `Quelle formation ${activity} offre le meilleur taux d'insertion professionnelle${w} ?`, named: false, weight: 2 },
      { q: `Quelles écoles ${activity} sont éligibles au CPF ou à une alternance${w} ?`, named: false, weight: 1.5 },
      { q: `Que vaut ${brand} ? Quels diplômes délivre cet établissement et à quel prix ?`, named: true, weight: 0 },
      { q: `Quels sont les frais de scolarité, la reconnaissance et la réputation de ${brand} ?`, named: true, weight: 0 }
    ],
    default: [
      { q: `Quel est le meilleur ${activity}${w} ? Cite des noms précis.`, named: false, weight: 3 },
      { q: `Où faire du ${activity}${w} ? Quels prestataires recommandes-tu ?`, named: false, weight: 3 },
      { q: `Quels organismes ou entreprises de ${activity} sont les plus recommandés${w} en 2026 ?`, named: false, weight: 2.5 },
      { q: `Je cherche un ${activity} sérieux${w}, lequel choisir et pourquoi ?`, named: false, weight: 2.5 },
      { q: `Quel ${activity} offre le meilleur rapport qualité-prix${w} ?`, named: false, weight: 2 },
      { q: `Comment bien choisir son ${activity}${w} ? Donne des exemples concrets.`, named: false, weight: 1.5 },
      { q: `Que vaut ${brand} ? Est-ce sérieux ? Que proposent-ils et à quel prix ?`, named: true, weight: 0 },
      { q: `Quels sont les tarifs, conditions et la réputation de ${brand} ?`, named: true, weight: 0 }
    ]
  };
  return sets[type] || sets.default;
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

  const plan = admin ? 'admin' : (profile.plan || 'free');
  const quota = QUOTAS[plan] ?? 1;
  const used = admin ? 0 : (profile.scans_used || 0);
  const allowed = enginesFor(plan);

  /* ── me ── */
  if (action === 'me') {
    return ok({ email: user.email, plan, isAdmin: admin, scansUsed: used, quota,
                canScan: admin || used < quota, engines: allowed,
                dbError: admin ? dbError : null });
  }

  if (b.engine && !allowed.includes(b.engine)) {
    return fail("Ce moteur n'est pas inclus dans votre formule.", 403);
  }
  const engine = (ENGINES[b.engine] && allowed.includes(b.engine)) ? b.engine : 'mistral';
  if (!process.env[ENGINES[engine].env]) {
    return fail(`Clé ${ENGINES[engine].env} absente des variables d'environnement Vercel.`, 500);
  }

  /* ── start : valide, consomme le quota, renvoie les questions ── */
  if (action === 'start') {
    if (!admin && used >= quota) {
      return fail(plan === 'free'
        ? "Votre scan gratuit a déjà été utilisé sur ce compte. Choisissez une formule pour continuer."
        : "Vous avez atteint le quota de scans de votre formule.", 403);
    }
    const d = {
      brand: String(b.brand || '').slice(0, 120).trim(),
      activity: String(b.activity || '').slice(0, 160).trim(),
      city: String(b.city || '').slice(0, 80).trim(),
      type: String(b.type || 'default')
    };
    if (d.brand.length < 2 || d.activity.length < 2) return fail('Nom et activité requis.', 400);

    if (!admin && svcKey) await bump(user.id, used, svcKey);

    return ok({
      questions: questions(d),
      engine, engineLabel: ENGINES[engine].label,
      plan, isAdmin: admin,
      scansUsed: admin ? 0 : used + 1, quota
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

Règles : "competitors" = noms réellement cités à la place de ${brand}, max 5, vide si aucun. "problems" = 2 à 4. "errors" = uniquement les inexactitudes réellement visibles, vide si aucune. "actions" = exactement 2, les plus prioritaires.`;

    try {
      let raw = (await ask(engine, p, 2200)).replace(/```json|```/g, '').trim();
      const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
      const analysis = (s >= 0 && e > s) ? JSON.parse(raw.slice(s, e + 1)) : null;
      return ok({ analysis });
    } catch (e) {
      return ok({ analysis: null, warning: String(e.message || e).slice(0, 300) });
    }
  }

  return fail("Action inconnue.", 400);
} };
