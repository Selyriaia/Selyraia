// netlify/functions/scan.js
//
// SELYRAIA — passerelle vers les IA
// -----------------------------------------------------------------------------
// Rôle : le navigateur ne parle JAMAIS directement aux API des fournisseurs.
// Il parle à cette fonction, qui détient les clés et fait l'appel à sa place.
// Les clés vivent uniquement dans les variables d'environnement Netlify.
//
// Variables à créer dans Netlify (Site configuration → Environment variables) :
//   MISTRAL_API_KEY     (obligatoire — scan gratuit)
//   ANTHROPIC_API_KEY   (optionnel — formules payantes)
//   OPENAI_API_KEY      (optionnel — formules payantes)
//   GEMINI_API_KEY      (optionnel — formules payantes)
// -----------------------------------------------------------------------------

/* ─── Configuration des moteurs ───────────────────────────────────────────────
   Les identifiants de modèles changent souvent. Vérifiez-les dans la console de
   chaque fournisseur si un appel renvoie une erreur "model not found".          */
const ENGINES = {
  mistral: {
    label: 'Mistral',
    envKey: 'MISTRAL_API_KEY',
    model: 'mistral-small-latest',
    free: true                 // seul moteur autorisé sans abonnement
  },
  claude: {
    label: 'Claude',
    envKey: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-5',
    free: false
  },
  openai: {
    label: 'GPT',
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-5.6-luna',
    free: false
  },
  gemini: {
    label: 'Gemini',
    envKey: 'GEMINI_API_KEY',
    model: 'gemini-2.5-flash-lite',
    free: false
  }
};

/* ─── Limitation d'usage (protection anti-abus) ───────────────────────────────
   Garde-fou simple : X appels par IP et par heure.
   ATTENTION : la mémoire d'une fonction serverless n'est pas partagée entre
   toutes les instances ni conservée indéfiniment. C'est une protection de
   base, pas une garantie. Pour du sérieux, stockez les compteurs dans Supabase.
   La vraie protection reste : crédit prépayé + recharge auto désactivée.        */
const RATE_LIMIT = 30;             // appels autorisés
const WINDOW_MS = 60 * 60 * 1000;  // par heure
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_LIMIT;
}

/* ─── Adaptateurs : un par fournisseur ────────────────────────────────────────
   Chacun reçoit (prompt, apiKey, model) et renvoie du texte.
   Ajouter un moteur = ajouter une entrée dans ENGINES + une fonction ici.       */

async function callMistral(prompt, key, model) {
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 900
    })
  });
  if (!r.ok) throw new Error(`Mistral ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

async function callClaude(prompt, key, model) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      messages: [{ role: 'user', content: prompt }],
      // recherche web activée : indispensable pour refléter ce que voit un client
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return (d.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
}

async function callOpenAI(prompt, key, model) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 900
    })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

async function callGemini(prompt, key, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 900 }
    })
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n').trim() || '';
}

const ADAPTERS = {
  mistral: callMistral,
  claude:  callClaude,
  openai:  callOpenAI,
  gemini:  callGemini
};

/* ─── Point d'entrée ──────────────────────────────────────────────────────── */
export default async (request) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Méthode non autorisée' }), { status: 405, headers });
  }

  // Limitation par IP
  const ip = request.headers.get('x-nf-client-connection-ip')
          || request.headers.get('x-forwarded-for')
          || 'inconnu';
  if (rateLimited(ip)) {
    return new Response(
      JSON.stringify({ error: "Trop de scans lancés. Réessayez dans une heure." }),
      { status: 429, headers }
    );
  }

  try {
    const body = await request.json();
    const prompt = (body.prompt || '').toString();
    const engineName = (body.engine || 'mistral').toString();
    const isPaid = body.paid === true; // à remplacer par une vraie vérification (voir note bas de page)

    if (prompt.length < 5) {
      return new Response(JSON.stringify({ error: 'Question vide.' }), { status: 400, headers });
    }
    if (prompt.length > 4000) {
      return new Response(JSON.stringify({ error: 'Question trop longue.' }), { status: 400, headers });
    }

    const engine = ENGINES[engineName];
    if (!engine) {
      return new Response(JSON.stringify({ error: 'Moteur inconnu.' }), { status: 400, headers });
    }

    // Les moteurs premium sont réservés aux abonnés
    if (!engine.free && !isPaid) {
      return new Response(
        JSON.stringify({ error: 'Ce moteur est réservé aux formules payantes.' }),
        { status: 403, headers }
      );
    }

    const key = process.env[engine.envKey];
    if (!key) {
      return new Response(
        JSON.stringify({ error: `Clé ${engine.envKey} absente. Ajoutez-la dans les variables d'environnement Netlify.` }),
        { status: 500, headers }
      );
    }

    // Un seul réessai en cas d'échec réseau ponctuel
    let text = '', lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        text = await ADAPTERS[engineName](prompt, key, engine.model);
        if (text) break;
        throw new Error('Réponse vide');
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise(r => setTimeout(r, 700));
      }
    }

    if (!text) {
      console.error('Échec appel IA :', lastErr?.message);
      return new Response(
        JSON.stringify({ error: "L'IA n'a pas répondu. Réessayez." }),
        { status: 502, headers }
      );
    }

    return new Response(
      JSON.stringify({ text, engine: engine.label, model: engine.model }),
      { status: 200, headers }
    );

  } catch (err) {
    console.error('Erreur serveur :', err);
    return new Response(
      JSON.stringify({ error: 'Erreur serveur.' }),
      { status: 500, headers }
    );
  }
};

/* ─── NOTE IMPORTANTE SUR `paid` ──────────────────────────────────────────────
   Actuellement, `paid` vient du navigateur : n'importe qui peut l'envoyer à true
   et utiliser vos moteurs payants. Acceptable pour tester, PAS pour la production.

   Correction (à faire avant d'ouvrir au public) : le navigateur envoie le jeton
   de session Supabase, et cette fonction vérifie côté serveur la formule réelle
   de l'utilisateur dans la table `users` :

     const token = request.headers.get('authorization')?.replace('Bearer ', '');
     const { data: { user } } = await supabaseAdmin.auth.getUser(token);
     const { data } = await supabaseAdmin.from('users').select('plan').eq('id', user.id).single();
     const isPaid = data && data.plan !== 'free';

   Cela nécessite la clé service_role de Supabase, à mettre elle aussi en
   variable d'environnement — jamais dans le navigateur.
   ─────────────────────────────────────────────────────────────────────────── */
