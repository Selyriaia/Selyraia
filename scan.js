// netlify/functions/scan.js
//
// SELYRAIA — passerelle IA + contrôle d'accès
// -----------------------------------------------------------------------------
// Tout passe par ici : le navigateur ne parle jamais aux API des fournisseurs,
// et ne décide jamais lui-même de son quota ou de sa formule.
//
// Variables d'environnement à créer dans Netlify :
//   MISTRAL_API_KEY        (obligatoire — scan gratuit)
//   SUPABASE_SERVICE_KEY   (obligatoire — vérification des quotas côté serveur)
//   ANTHROPIC_API_KEY      (optionnel — formules payantes)
//   OPENAI_API_KEY         (optionnel — formules payantes)
//   GEMINI_API_KEY         (optionnel — formules payantes)
// -----------------------------------------------------------------------------

const SUPABASE_URL = 'https://ysafgvpeotvgpyswjgdu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzYWZndnBlb3R2Z3B5c3dqZ2R1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NDQ4NTYsImV4cCI6MjEwMjEyMDg1Nn0.YCTLi3DmaWwDnRETcZscg1__hS9_kN7-xOZg-uAjF8E';

// Comptes avec accès total, sans quota ni paiement.
const ADMINS = ['selyriaia@gmail.com'];

const ENGINES = {
  mistral: { label: 'Mistral', env: 'MISTRAL_API_KEY',   model: 'mistral-small-latest', free: true  },
  claude:  { label: 'Claude',  env: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5',      free: false },
  openai:  { label: 'GPT',     env: 'OPENAI_API_KEY',    model: 'gpt-5.6-luna',         free: false },
  gemini:  { label: 'Gemini',  env: 'GEMINI_API_KEY',    model: 'gemini-2.5-flash-lite',free: false }
};

// Quotas de scans par cycle, par formule.
const QUOTAS = { free: 1, plus: 40, pro: 200, agence: 2000, admin: 99999 };

/* ─── Supabase via REST : aucune dépendance à installer ─────────────────── */

async function getUser(token) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` }
  });
  if (!r.ok) return null;
  return r.json();
}

function svcHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  };
}

async function getProfile(userId, email, key) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=*`,
    { headers: svcHeaders(key) }
  );
  const rows = r.ok ? await r.json() : [];
  if (rows.length) return rows[0];

  // Premier passage : on crée la fiche.
  const c = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
    method: 'POST',
    headers: { ...svcHeaders(key), Prefer: 'return=representation' },
    body: JSON.stringify({ id: userId, email, plan: 'free', scans_used: 0 })
  });
  const created = c.ok ? await c.json() : [];
  return created[0] || { id: userId, email, plan: 'free', scans_used: 0 };
}

async function bumpScans(userId, current, key) {
  await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH',
    headers: svcHeaders(key),
    body: JSON.stringify({ scans_used: current + 1, last_scan_at: new Date().toISOString() })
  });
}

/* ─── Garde-fou IP (secondaire — la vraie limite est le compte) ─────────── */
const ipHits = new Map();
const IP_MAX = 40, IP_WINDOW = 60 * 60 * 1000;

function ipBlocked(ip) {
  const now = Date.now();
  const rec = ipHits.get(ip);
  if (!rec || now - rec.t > IP_WINDOW) { ipHits.set(ip, { t: now, n: 1 }); return false; }
  rec.n += 1;
  return rec.n > IP_MAX;
}

/* ─── Adaptateurs fournisseurs ──────────────────────────────────────────── */

async function callMistral(prompt, key, model) {
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1100 })
  });
  if (!r.ok) throw new Error(`Mistral ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

async function callClaude(prompt, key, model) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 1100,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function callOpenAI(prompt, key, model) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1100 })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

async function callGemini(prompt, key, model) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1100 }
      })
    }
  );
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n').trim() || '';
}

const ADAPTERS = { mistral: callMistral, claude: callClaude, openai: callOpenAI, gemini: callGemini };

async function ask(engineName, prompt) {
  const eng = ENGINES[engineName];
  const key = process.env[eng.env];
  if (!key) throw new Error(`Clé ${eng.env} absente dans les variables Netlify.`);
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const t = await ADAPTERS[engineName](prompt, key, eng.model);
      if (t) return t;
      throw new Error('Réponse vide');
    } catch (e) { last = e; if (i === 0) await new Promise(r => setTimeout(r, 700)); }
  }
  throw last;
}

/* ─── Génération des questions selon le secteur ─────────────────────────── */

function buildQuestions(d) {
  const { brand, activity, city, type } = d;
  const where = city ? ` à ${city}` : ' en France';

  // 6 questions anonymes (la marque n'est jamais nommée) → base du score
  // 2 questions nommées → servent à la vérification factuelle, pas au score
  const sets = {
    creator: [
      { q: `Quels créateurs de contenu français suivre en ${activity} ? Cite des noms précis.`, named: false, weight: 3 },
      { q: `Quelle chaîne ou quel compte suivre pour du ${activity} en français ?`, named: false, weight: 3 },
      { q: `Quels sont les créateurs ${activity} les plus recommandés en 2026 ?`, named: false, weight: 2.5 },
      { q: `Je débute et je cherche du contenu ${activity} de qualité, qui me conseilles-tu ?`, named: false, weight: 2.5 },
      { q: `Quels créateurs ${activity} francophones ont le plus d'influence ?`, named: false, weight: 2 },
      { q: `Où trouver du bon contenu ${activity} en français ?`, named: false, weight: 1.5 },
      { q: `Que vaut ${brand} ? Que fait cette personne ou cette chaîne exactement ?`, named: true, weight: 0 },
      { q: `Quelle est l'audience et la notoriété de ${brand} ?`, named: true, weight: 0 }
    ],
    media: [
      { q: `Quels médias suivre pour du ${activity}${where} ? Cite des noms.`, named: false, weight: 3 },
      { q: `Quelle chaîne ou quel média est la référence en ${activity} en France ?`, named: false, weight: 3 },
      { q: `Quels sont les médias ${activity} les plus fiables en 2026 ?`, named: false, weight: 2.5 },
      { q: `Où s'informer sérieusement sur ${activity} ?`, named: false, weight: 2.5 },
      { q: `Quels médias français traitent le mieux de ${activity} ?`, named: false, weight: 2 },
      { q: `Quelles sont les alternatives aux grands médias pour ${activity} ?`, named: false, weight: 1.5 },
      { q: `Que vaut ${brand} comme média ? Quelle est sa ligne éditoriale ?`, named: true, weight: 0 },
      { q: `Quelle est l'audience de ${brand} et sa réputation ?`, named: true, weight: 0 }
    ],
    default: [
      { q: `Quel est le meilleur ${activity}${where} ? Cite des noms précis.`, named: false, weight: 3 },
      { q: `Où faire du ${activity}${where} ? Quels prestataires recommandes-tu ?`, named: false, weight: 3 },
      { q: `Quels sont les organismes ou entreprises de ${activity} les plus recommandés${where} en 2026 ?`, named: false, weight: 2.5 },
      { q: `Je cherche un ${activity} sérieux${where}, lequel choisir et pourquoi ?`, named: false, weight: 2.5 },
      { q: `Quel ${activity} offre le meilleur rapport qualité-prix${where} ?`, named: false, weight: 2 },
      { q: `Comment bien choisir son ${activity}${where} ? Donne des exemples concrets.`, named: false, weight: 1.5 },
      { q: `Que vaut ${brand} ? Est-ce sérieux ? Que proposent-ils exactement et à quel prix ?`, named: true, weight: 0 },
      { q: `Quels sont les tarifs, les conditions et la réputation de ${brand} ?`, named: true, weight: 0 }
    ]
  };

  return sets[type] || sets.default;
}

/* ─── Point d'entrée ────────────────────────────────────────────────────── */

export default async (request) => {
  const H = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  const fail = (msg, code) => new Response(JSON.stringify({ error: msg }), { status: code, headers: H });

  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: H });
  if (request.method !== 'POST')    return fail('Méthode non autorisée', 405);

  const ip = request.headers.get('x-nf-client-connection-ip')
          || request.headers.get('x-forwarded-for') || 'x';
  if (ipBlocked(ip)) return fail('Trop de requêtes depuis ce réseau. Réessayez dans une heure.', 429);

  // 1. Authentification obligatoire
  const token = (request.headers.get('authorization') || '').replace(/^Bearer /i, '');
  if (!token) return fail('Connectez-vous pour lancer un scan.', 401);

  const user = await getUser(token);
  if (!user || !user.id) return fail('Session expirée. Reconnectez-vous.', 401);

  const svcKey = process.env.SUPABASE_SERVICE_KEY;
  if (!svcKey) return fail('SUPABASE_SERVICE_KEY absente dans les variables Netlify.', 500);

  const isAdmin = ADMINS.includes((user.email || '').toLowerCase());
  const profile = await getProfile(user.id, user.email, svcKey);
  const plan = isAdmin ? 'admin' : (profile.plan || 'free');

  let body;
  try { body = await request.json(); } catch { return fail('Requête invalide.', 400); }

  // 2. Route "état du compte" — utilisée par le site au chargement
  if (body.action === 'me') {
    const quota = QUOTAS[plan] ?? 1;
    return new Response(JSON.stringify({
      email: user.email,
      plan,
      isAdmin,
      scansUsed: profile.scans_used || 0,
      quota,
      canScan: isAdmin || (profile.scans_used || 0) < quota
    }), { status: 200, headers: H });
  }

  // 3. Lancement d'un scan
  const quota = QUOTAS[plan] ?? 1;
  const used = profile.scans_used || 0;
  if (!isAdmin && used >= quota) {
    return fail(
      plan === 'free'
        ? "Votre scan gratuit a déjà été utilisé sur ce compte. Choisissez une formule pour continuer."
        : "Vous avez atteint le quota de scans de votre formule.",
      403
    );
  }

  const d = {
    brand:    (body.brand || '').toString().slice(0, 120).trim(),
    activity: (body.activity || '').toString().slice(0, 160).trim(),
    city:     (body.city || '').toString().slice(0, 80).trim(),
    price:    (body.price || '').toString().slice(0, 80).trim(),
    type:     (body.type || 'default').toString()
  };
  if (d.brand.length < 2 || d.activity.length < 2) return fail('Nom et activité requis.', 400);

  const engine = ENGINES[body.engine] ? body.engine : 'mistral';
  if (!ENGINES[engine].free && plan === 'free') {
    return fail('Ce moteur est réservé aux formules payantes.', 403);
  }

  const questions = buildQuestions(d);
  const results = [];

  try {
    for (const item of questions) {
      const prompt =
        `Tu réponds à un particulier français qui te pose cette question : "${item.q}". ` +
        `Réponds naturellement en 4 à 6 phrases, comme tu le ferais normalement, en citant de vraies ` +
        `entreprises, marques ou personnes si c'est pertinent. N'invente rien : si tu ne sais pas, dis-le.`;
      let text = '';
      try { text = await ask(engine, prompt); } catch (e) { text = ''; }
      const mentioned = text.toLowerCase().includes(d.brand.toLowerCase());
      results.push({ ...item, text, mentioned });
    }
  } catch (e) {
    return fail("Le scan n'a pas pu aboutir. Réessayez dans un instant.", 502);
  }

  // 4. Score pondéré sur les seules questions anonymes
  const blind = results.filter(r => !r.named && r.text);
  const totalW = blind.reduce((s, r) => s + r.weight, 0) || 1;
  const gotW   = blind.filter(r => r.mentioned).reduce((s, r) => s + r.weight, 0);
  const score  = Math.round((gotW / totalW) * 100);
  const hits   = blind.filter(r => r.mentioned).length;
  // Marge d'incertitude : une seule exécution par question, l'échantillon est petit.
  const margin = Math.max(5, Math.round(38 / Math.sqrt(blind.length || 1)));

  // 5. Analyse : concurrents cités, diagnostic, conséquences, actions
  let analysis = null;
  const corpus = results
    .filter(r => r.text)
    .map(r => `Q: ${r.q}\nR: ${r.text.slice(0, 800)}`)
    .join('\n\n');

  const analysisPrompt =
`Voici les réponses réelles d'une IA à des questions posées par des clients potentiels du marché "${d.activity}"${d.city ? ' à ' + d.city : ''}.

${corpus}

L'entité analysée est "${d.brand}". Elle apparaît dans ${hits} des ${blind.length} questions où son nom n'était PAS mentionné.${d.price ? ` Son tarif réel annoncé est : ${d.price}.` : ''}

Analyse ces réponses avec rigueur et sévérité, comme un auditeur : le but est d'identifier précisément ce qui ne va pas, pas de rassurer. Ne minimise aucun problème, mais n'invente rien qui ne soit pas dans les réponses ci-dessus.

Réponds UNIQUEMENT en JSON valide, sans balise de code, sans texte avant ni après, avec cette structure exacte :
{
  "competitors": ["nom1","nom2","nom3"],
  "verdict": "une phrase factuelle et directe résumant la situation",
  "problems": [
    {"title":"titre court du problème","detail":"explication factuelle en une phrase","impact":"conséquence commerciale concrète en une phrase"}
  ],
  "errors": [
    {"claim":"ce que l'IA affirme d'inexact ou d'obsolète","reality":"ce qui devrait être dit","gravity":"haute|moyenne|basse"}
  ],
  "actions": [
    {"title":"action concrète","detail":"comment la mettre en oeuvre en une phrase","priority":"haute|moyenne|basse"}
  ]
}

Règles : "competitors" = les noms réellement cités à la place de ${d.brand}, maximum 5, tableau vide si aucun. "problems" = 2 à 4 entrées. "errors" = uniquement des inexactitudes réellement visibles dans les réponses, tableau vide si aucune. "actions" = exactement 2 entrées pour cette version gratuite, les plus prioritaires.`;

  try {
    let raw = await ask(engine, analysisPrompt);
    raw = raw.replace(/```json|```/g, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) analysis = JSON.parse(raw.slice(s, e + 1));
  } catch (e) { analysis = null; }

  // 6. Consommation du quota (jamais pour l'admin)
  if (!isAdmin) { try { await bumpScans(user.id, used, svcKey); } catch (e) {} }

  return new Response(JSON.stringify({
    brand: d.brand,
    score, margin, hits,
    blindTotal: blind.length,
    engine: ENGINES[engine].label,
    plan,
    isAdmin,
    scansUsed: isAdmin ? 0 : used + 1,
    quota,
    results: results.map(r => ({
      q: r.q, named: r.named, mentioned: r.mentioned,
      excerpt: (r.text || '').slice(0, 600)
    })),
    analysis
  }), { status: 200, headers: H });
};
