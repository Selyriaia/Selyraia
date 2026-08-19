// netlify/functions/scan.js
//
// SELYRAIA — passerelle IA + contrôle d'accès
// -----------------------------------------------------------------------------
// IMPORTANT : ce fichier utilise la syntaxe ES module (export default).
// Il faut donc un fichier netlify/functions/package.json contenant :
//   { "type": "module" }
// Sans lui, Netlify peut refuser de charger la fonction (erreur 500 silencieuse).
//
// Variables d'environnement Netlify :
//   MISTRAL_API_KEY        obligatoire — scan gratuit
//   SUPABASE_SERVICE_KEY   obligatoire — quotas côté serveur
//   ANTHROPIC_API_KEY      optionnel   — formules payantes
//   OPENAI_API_KEY         optionnel   — formules payantes
//   GEMINI_API_KEY         optionnel   — formules payantes
// -----------------------------------------------------------------------------

const SUPABASE_URL = 'https://ysafgvpeotvgpyswjgdu.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzYWZndnBlb3R2Z3B5c3dqZ2R1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NDQ4NTYsImV4cCI6MjEwMjEyMDg1Nn0.YCTLi3DmaWwDnRETcZscg1__hS9_kN7-xOZg-uAjF8E';

// Comptes à accès total : aucun quota, tous les moteurs, toutes les formules.
const ADMINS = ['selyriaia@gmail.com'];

const ENGINES = {
  mistral: { label: 'Mistral', env: 'MISTRAL_API_KEY',   model: 'mistral-small-latest',  free: true  },
  claude:  { label: 'Claude',  env: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5',       free: false },
  openai:  { label: 'GPT',     env: 'OPENAI_API_KEY',    model: 'gpt-5.6-luna',          free: false },
  gemini:  { label: 'Gemini',  env: 'GEMINI_API_KEY',    model: 'gemini-2.5-flash-lite', free: false }
};

const QUOTAS = { free: 1, plus: 40, pro: 200, agence: 2000, admin: 999999 };

const isAdminEmail = e => ADMINS.includes(String(e || '').trim().toLowerCase());

/* ─── Supabase par REST (aucune dépendance à installer) ─────────────────── */

async function getUser(token) {
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const svc = key => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

async function getProfile(id, email, key) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${id}&select=*`, { headers: svc(key) });
    if (!r.ok) return { _err: `lecture profiles ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const rows = await r.json();
    if (rows.length) return rows[0];

    const c = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
      method: 'POST',
      headers: { ...svc(key), Prefer: 'return=representation' },
      body: JSON.stringify({ id, email, plan: 'free', scans_used: 0 })
    });
    if (!c.ok) return { _err: `création profil ${c.status}: ${(await c.text()).slice(0, 200)}` };
    const made = await c.json();
    return made[0] || { id, email, plan: 'free', scans_used: 0 };
  } catch (e) {
    return { _err: 'Supabase injoignable : ' + e.message };
  }
}

async function bump(id, n, key) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${id}`, {
      method: 'PATCH', headers: svc(key),
      body: JSON.stringify({ scans_used: n + 1, last_scan_at: new Date().toISOString() })
    });
  } catch {}
}

/* ─── Garde-fou IP (secondaire) ─────────────────────────────────────────── */
const ipHits = new Map();
function ipBlocked(ip) {
  const now = Date.now(), rec = ipHits.get(ip);
  if (!rec || now - rec.t > 3600000) { ipHits.set(ip, { t: now, n: 1 }); return false; }
  rec.n++; return rec.n > 60;
}

/* ─── Fournisseurs ──────────────────────────────────────────────────────── */

async function callMistral(p, k, m) {
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
    body: JSON.stringify({ model: m, messages: [{ role: 'user', content: p }], max_tokens: 1100 })
  });
  if (!r.ok) throw new Error(`Mistral ${r.status} — ${(await r.text()).slice(0, 250)}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

async function callClaude(p, k, m) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: m, max_tokens: 1100, messages: [{ role: 'user', content: p }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status} — ${(await r.text()).slice(0, 250)}`);
  const d = await r.json();
  return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

async function callOpenAI(p, k, m) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
    body: JSON.stringify({ model: m, messages: [{ role: 'user', content: p }], max_tokens: 1100 })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status} — ${(await r.text()).slice(0, 250)}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

async function callGemini(p, k, m) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${k}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { maxOutputTokens: 1100 } })
  });
  if (!r.ok) throw new Error(`Gemini ${r.status} — ${(await r.text()).slice(0, 250)}`);
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.map(x => x.text).join('\n').trim() || '';
}

const AD = { mistral: callMistral, claude: callClaude, openai: callOpenAI, gemini: callGemini };

async function ask(name, prompt) {
  const e = ENGINES[name];
  const k = process.env[e.env];
  if (!k) throw new Error(`Clé ${e.env} absente des variables Netlify.`);
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const t = await AD[name](prompt, k, e.model);
      if (t) return t;
      throw new Error('Réponse vide du modèle');
    } catch (err) { last = err; if (i === 0) await new Promise(r => setTimeout(r, 700)); }
  }
  throw last;
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

export default async (request) => {
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

  let body = {};
  try { body = await request.json(); } catch {}

  // Diagnostic public : dit si les variables existent, sans jamais révéler leur valeur.
  if (body.action === 'diag') {
    return ok({
      fonction: 'en ligne',
      MISTRAL_API_KEY: !!process.env.MISTRAL_API_KEY,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      GEMINI_API_KEY: !!process.env.GEMINI_API_KEY
    });
  }

  const ip = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for') || 'x';
  if (ipBlocked(ip)) return fail('Trop de requêtes depuis ce réseau. Réessayez dans une heure.', 429);

  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return fail('Connectez-vous pour lancer un scan.', 401);

  const user = await getUser(token);
  if (!user || !user.id) return fail('Session expirée. Reconnectez-vous.', 401);

  const admin = isAdminEmail(user.email);
  const svcKey = process.env.SUPABASE_SERVICE_KEY;

  // L'admin fonctionne même si la base n'est pas encore configurée.
  let profile = { id: user.id, email: user.email, plan: 'free', scans_used: 0 };
  let dbError = null;
  if (svcKey) {
    const p = await getProfile(user.id, user.email, svcKey);
    if (p && p._err) dbError = p._err; else profile = p;
  } else if (!admin) {
    return fail("SUPABASE_SERVICE_KEY absente des variables Netlify. Ajoutez-la puis redéployez.", 500);
  }
  if (dbError && !admin) return fail('Base de données : ' + dbError, 500);

  const plan = admin ? 'admin' : (profile.plan || 'free');
  const quota = QUOTAS[plan] ?? 1;
  const used = admin ? 0 : (profile.scans_used || 0);

  if (body.action === 'me') {
    return ok({
      email: user.email, plan, isAdmin: admin,
      scansUsed: used, quota, canScan: admin || used < quota,
      dbError: admin ? dbError : null
    });
  }

  if (!admin && used >= quota) {
    return fail(plan === 'free'
      ? "Votre scan gratuit a déjà été utilisé sur ce compte. Choisissez une formule pour continuer."
      : "Vous avez atteint le quota de scans de votre formule.", 403);
  }

  const d = {
    brand:    String(body.brand || '').slice(0, 120).trim(),
    activity: String(body.activity || '').slice(0, 160).trim(),
    city:     String(body.city || '').slice(0, 80).trim(),
    price:    String(body.price || '').slice(0, 80).trim(),
    type:     String(body.type || 'default')
  };
  if (d.brand.length < 2 || d.activity.length < 2) return fail('Nom et activité requis.', 400);

  const engine = ENGINES[body.engine] ? body.engine : 'mistral';
  if (!ENGINES[engine].free && !admin && plan === 'free') {
    return fail('Ce moteur est réservé aux formules payantes.', 403);
  }
  if (!process.env[ENGINES[engine].env]) {
    return fail(`Clé ${ENGINES[engine].env} absente des variables Netlify.`, 500);
  }

  const qs = questions(d);
  const results = [];
  let firstErr = null;

  for (const it of qs) {
    const prompt =
      `Tu réponds à un particulier français qui te pose cette question : "${it.q}". ` +
      `Réponds naturellement en 4 à 6 phrases, en citant de vraies entreprises, marques ou personnes ` +
      `si c'est pertinent. N'invente rien : si tu ne sais pas, dis-le.`;
    let text = '';
    try { text = await ask(engine, prompt); }
    catch (e) { if (!firstErr) firstErr = e.message; }
    results.push({ ...it, text, mentioned: !!text && text.toLowerCase().includes(d.brand.toLowerCase()) });
  }

  if (!results.some(r => r.text)) {
    return fail("Aucune réponse obtenue du moteur. " + (firstErr || ''), 502);
  }

  const blind = results.filter(r => !r.named && r.text);
  const totalW = blind.reduce((s, r) => s + r.weight, 0) || 1;
  const gotW = blind.filter(r => r.mentioned).reduce((s, r) => s + r.weight, 0);
  const score = Math.round((gotW / totalW) * 100);
  const hits = blind.filter(r => r.mentioned).length;
  const margin = Math.max(5, Math.round(38 / Math.sqrt(blind.length || 1)));

  const corpus = results.filter(r => r.text)
    .map(r => `Q: ${r.q}\nR: ${r.text.slice(0, 800)}`).join('\n\n');

  const ap =
`Voici les réponses réelles d'une IA à des questions posées par des clients potentiels du marché "${d.activity}"${d.city ? ' à ' + d.city : ''}.

${corpus}

L'entité analysée est "${d.brand}". Elle apparaît dans ${hits} des ${blind.length} questions où son nom n'était PAS mentionné.${d.price ? ` Son tarif réel est : ${d.price}.` : ''}

Analyse avec rigueur et sévérité, comme un auditeur : le but est d'identifier précisément ce qui ne va pas, pas de rassurer. Ne minimise aucun problème, mais n'invente rien qui ne soit pas dans les réponses ci-dessus.

Réponds UNIQUEMENT en JSON valide, sans balise de code, sans texte avant ni après :
{
 "competitors":["nom1","nom2"],
 "verdict":"une phrase factuelle et directe",
 "problems":[{"title":"titre court","detail":"explication en une phrase","impact":"conséquence commerciale concrète en une phrase"}],
 "errors":[{"claim":"ce que l'IA affirme d'inexact","reality":"ce qui devrait être dit","gravity":"haute|moyenne|basse"}],
 "actions":[{"title":"action concrète","detail":"comment faire en une phrase","priority":"haute|moyenne|basse"}]
}

Règles : "competitors" = noms réellement cités à la place de ${d.brand}, max 5, vide si aucun. "problems" = 2 à 4. "errors" = uniquement les inexactitudes réellement visibles, vide si aucune. "actions" = exactement 2, les plus prioritaires.`;

  let analysis = null;
  try {
    let raw = (await ask(engine, ap)).replace(/```json|```/g, '').trim();
    const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) analysis = JSON.parse(raw.slice(a, b + 1));
  } catch {}

  if (!admin && svcKey) await bump(user.id, used, svcKey);

  return ok({
    brand: d.brand, score, margin, hits, blindTotal: blind.length,
    engine: ENGINES[engine].label, plan, isAdmin: admin,
    scansUsed: admin ? 0 : used + 1, quota,
    warning: firstErr && admin ? firstErr : null,
    results: results.map(r => ({ q: r.q, named: r.named, mentioned: r.mentioned, excerpt: (r.text || '').slice(0, 600) })),
    analysis
  });
};
