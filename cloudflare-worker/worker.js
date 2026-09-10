// Proxy do "Agora Eu Sei" pra API da Groq.
//
// Por que isso existe: o board é um site estático (GitHub Pages), sem servidor próprio. Se o
// navegador chamasse a Groq direto, a chave da API ficaria visível pra qualquer um que abrisse
// o código-fonte da página — e essa chave é o que controla o uso gratuito (e o custo, se um dia
// passar a pagar). Este Worker fica no meio: guarda a chave da Groq como segredo do lado do
// Cloudflare (nunca chega ao navegador) e só repassa o pedido depois de confirmar que quem está
// chamando tem uma sessão válida no Firebase Auth do board — assim só gente logada na
// plataforma consegue usar, não qualquer visitante da internet.
//
// Troca de dados: navegador -> este Worker -> Groq -> este Worker -> navegador. O conteúdo da
// pergunta passa pela Groq (processamento) mas nunca é salvo por eles pra treino, e este Worker
// não grava nada em lugar nenhum (sem log de conteúdo, sem banco de dados).

const ALLOWED_ORIGIN = "https://nlcorrea-ops.github.io";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

function corsHeaders(){
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// Confirma que o idToken é de uma sessão de verdade do Firebase Auth do projeto do board —
// usa a própria API do Firebase pra validar (assinatura, expiração, projeto certo), em vez de
// reimplementar verificação de JWT aqui.
async function isValidFirebaseSession(idToken, env){
  if(!idToken) return false;
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    }
  );
  if(!resp.ok) return false;
  const data = await resp.json();
  return !!(data && Array.isArray(data.users) && data.users.length > 0);
}

export default {
  async fetch(request, env){
    if(request.method === "OPTIONS"){
      return new Response(null, { headers: corsHeaders() });
    }
    if(request.method !== "POST"){
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }

    let body;
    try{
      body = await request.json();
    }catch(e){
      return new Response("Invalid JSON", { status: 400, headers: corsHeaders() });
    }

    const { idToken, messages, model, stream, temperature, max_tokens } = body || {};
    if(!Array.isArray(messages) || !model){
      return new Response("Missing fields", { status: 400, headers: corsHeaders() });
    }

    const authorized = await isValidFirebaseSession(idToken, env);
    if(!authorized){
      return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
    }

    const groqResp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: !!stream,
        temperature: typeof temperature === "number" ? temperature : 0.6,
        max_tokens: typeof max_tokens === "number" ? max_tokens : 500,
      }),
    });

    const headers = new Headers(corsHeaders());
    headers.set("Content-Type", groqResp.headers.get("Content-Type") || "application/json");
    return new Response(groqResp.body, { status: groqResp.status, headers });
  },
};
