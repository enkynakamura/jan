// web-app/src/lib/compressThread.ts
//
// Comprime solo il contenuto di tipo "reasoning" dei messaggi assistant di un
// thread, lasciando intatti content/tool call/allegati, e scrive il risultato
// in un NUOVO thread (stesso modello, titolo prefissato "[compresso]").
// Il thread originale non viene toccato: la cancellazione resta una scelta
// manuale dell'utente dal menu, dopo aver verificato il risultato.
//
// Verificato contro il sorgente reale di janhq/jan (branch dev, letto il
// 2026-09-19): ModelFactory.createModel, getProviderByName, useThreads,
// getServiceHub().messages(), il tipo ThreadContent/ContentType.Reasoning.
// NON eseguito/compilato in questo ambiente: nessun Tauri/build locale
// disponibile qui. Va buildato e testato sul tuo PC prima di fidarsene.

import { generateText } from 'ai'
import { ulid } from 'ulidx'
import { ContentType, type ThreadMessage } from '@janhq/core'
import { ModelFactory } from '@/lib/model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { getServiceHub } from '@/hooks/useServiceHub'

/**
 * Modello usato SOLO per comprimere i blocchi di reasoning - deliberatamente
 * diverso da thread.model (il modello principale della conversazione).
 * Un compito di puro riassunto non ha bisogno della potenza del modello
 * principale, e usare un modello piccolo separato evita di dover
 * scaricare/ricaricare il modello principale ad ogni compressione.
 *
 * `id` deve corrispondere esattamente al Model.id come appare nella lista
 * modelli di Jan per il provider indicato (verificabile nell'icona
 * ingranaggio del modello, o nel file di config del provider su disco).
 * `provider` è il nome provider così come appare in useModelProvider
 * (per un modello scaricato dall'Hub di Jan è quasi certamente 'llamacpp' -
 * il motore interno di Jan, DIVERSO dal provider custom che punta al tuo
 * server ik_llama.cpp su cui gira il modello principale).
 *
 * Consiglio pratico: nell'icona ingranaggio di QUESTO modello, imposta
 * GPU Layers a 0 (esecuzione CPU-only) - un 1-3B su un compito di
 * riassunto testuale corto è comunque veloce su CPU, e non contende VRAM
 * col modello principale che probabilmente la occupa già quasi tutta.
 */
const SUMMARY_MODEL_ID = 'Qwen3_5-4B-Q3_K_M'
const SUMMARY_MODEL_PROVIDER = 'llamacpp'

/**
 * Sotto questa lunghezza (caratteri), la PROSA di un blocco di reasoning
 * (cioè il reasoning al netto dei blocchi di codice, vedi sotto) viene
 * lasciata intatta - non vale la chiamata al modello. Un blocco fatto quasi
 * solo di codice ha prosa residua sotto soglia e salta la compressione,
 * anche se il testo complessivo (codice incluso) è lungo.
 */
const MIN_PROSE_LENGTH = 250

const COMPRESSION_SYSTEM_PROMPT = [
  'Compress the following reasoning trace to roughly one tenth of its',
  'original length, in the same language as the original text. Keep the',
  'essential decisions, intermediate results, and conclusions that a later',
  'turn of the same conversation might still depend on; discard exploration,',
  'dead ends, and restated context.',
  'If the text contains a numbered or bulleted list (steps taken, items',
  'verified, items still to check, findings), preserve every single item as',
  'its own list entry in the output. Shorten each item\'s wording if needed,',
  'but never merge, drop, or fold multiple items into one summary sentence -',
  'a list of 6 items must produce an output list of 6 items.',
  'Output only the compressed text, no preamble, no quotation marks.',
].join(' ')

/**
 * Rileva righe di lista numerata o puntata (1. / - / * / •) nel blocco di
 * prosa, per garantire nel budget di token qui sotto uno spazio minimo per
 * voce. Senza questo, un blocco con molte voci brevi ("ho verificato:
 * 1,2,3,4,5,6") veniva ridotto dal modello a una frase generica che ne
 * cancellava la maggior parte - misurato su due thread di test reali: 182
 * voci di lista nell'originale, 9 sopravvissute alla compressione (5%).
 */
const LIST_ITEM_REGEX = /^\s*(\d+\.|[-*•])\s+\S/gm

/**
 * Stima grezza dei token del blocco di prosa in ingresso, per calcolare un
 * tetto massimo di output PROPORZIONALE (target ~10x di compressione,
 * coerente con il rapporto già misurato e validato sulla versione per la
 * webui di llama.cpp - non un numero fisso indipendente dalla lunghezza).
 * ~4 caratteri per token è una stima approssimativa (testo misto
 * italiano/inglese/codice), non una misura esatta - usata solo per
 * dimensionare il tetto di sicurezza, non per un conteggio preciso.
 *
 * Se il blocco contiene una lista, il target proporzionale da solo non basta
 * mai a contenere tutte le voci (8 voci in ~40 token è impossibile anche
 * accorciate all'osso): listFloor alza il tetto in proporzione al numero di
 * voci rilevate, indipendentemente dal ratio 1/10 generale. 12 token/voce è
 * una stima empirica (frase breve + numerazione), non misurata sul tuo
 * modello specifico - da rivedere se le voci escono troncate nel retest.
 */
function estimateMaxSummaryTokens(prose: string): number {
  const estimatedInputTokens = Math.ceil(prose.length / 4)
  const target = Math.round(estimatedInputTokens / 10)
  const listItemCount = (prose.match(LIST_ITEM_REGEX) || []).length
  const listFloor = listItemCount > 0 ? listItemCount * 12 + 20 : 0
  // Pavimento: anche un blocco piccolo merita almeno una frase compiuta.
  // Soffitto: rete di sicurezza tecnica contro un'altra fuga come quella da
  // 5360 token osservata - un blocco da decine di migliaia di token non deve
  // MAI generare un output che si avvicina a quella cifra, qualunque cosa
  // dica il prompt.
  return Math.min(800, Math.max(40, target, listFloor))
}

/**
 * Blocchi di codice recintati (```...```) dentro un reasoning trace. Non
 * vengono MAI mandati al modello di compressione e non vengono MAI
 * parafrasati: un modello piccolo che riscrive codice può cambiare sintassi
 * o numeri senza che sia visibile a colpo d'occhio. Vengono tolti prima
 * della chiamata e riattaccati verbatim dopo, sempre, indipendentemente da
 * cosa il modello genera per la prosa - nessuna dipendenza da un placeholder
 * che il modello potrebbe alterare o omettere.
 */
const CODE_FENCE_REGEX = /```[\s\S]*?```/g

function splitCodeFromProse(text: string): {
  prose: string
  codeBlocks: string[]
} {
  const codeBlocks: string[] = []
  const prose = text.replace(CODE_FENCE_REGEX, (match) => {
    codeBlocks.push(match)
    return ''
  })
  return { prose, codeBlocks }
}

/**
 * Rimuove un blocco di "pensiero" residuo (<think>...</think> o varianti)
 * se il modello lo emette comunque nonostante enable_thinking: false - stessa
 * precauzione usata da Jan in thread-title-summarizer.ts per lo stesso tipo
 * di modello. Se resta solo un tag di apertura senza chiusura (il pensiero
 * ha consumato tutto il budget di token), il risultato è inutilizzabile.
 */
function stripThinkingTags(raw: string): string {
  let text = raw.trim()
  text = text
    .replace(/<(think|thinking|reasoning|analysis)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .trim()
  if (/<(think|thinking|reasoning|analysis)[^>]*>/i.test(text)) return ''
  return text
}

/**
 * Comprime la sola prosa di un blocco di reasoning; il codice (se presente)
 * è già stato tolto da splitCodeFromProse e viene riattaccato dal chiamante,
 * verbatim, dopo. Una chiamata al modello per blocco - più semplice da
 * verificare correttamente senza un ambiente di test rispetto al pattern
 * batched (un'unica chiamata con label [[ID:xxx]] per tutto il thread) che
 * avevi nella versione per la webui di llama.cpp, ma più richieste HTTP per
 * thread con molti turni di reasoning lungo. Se il numero di chiamate
 * diventa un problema pratico, tornare al pattern batched è il prossimo
 * passo naturale.
 */
async function compressProseBlock(prose: string): Promise<string> {
  const provider = useModelProvider
    .getState()
    .getProviderByName(SUMMARY_MODEL_PROVIDER)
  if (!provider) {
    throw new Error(
      `Provider di riepilogo non trovato: ${SUMMARY_MODEL_PROVIDER}`
    )
  }
  // CAUSA VERA dei riassunti vuoti osservati nel test: Qwen3.5 è un modello
  // "pensante" - scrive un blocco <think>...</think> prima della risposta.
  // Con un tetto di token stretto (vedi estimateMaxSummaryTokens), il
  // pensiero consuma tutto il budget e non resta nulla per il riassunto
  // vero. Stesso fix già usato da Jan in thread-title-summarizer.ts per lo
  // stesso tipo di modello, per lo stesso tipo di compito (poco testo in
  // uscita da un modello Qwen3).
  const parameters: Record<string, unknown> = {}
  if (SUMMARY_MODEL_PROVIDER === 'llamacpp') {
    parameters.chat_template_kwargs = { enable_thinking: false }
  }
  // ModelFactory.createModel, per provider 'llamacpp', avvia il modello se
  // non è già in esecuzione (vedi createLlamaCppModel -> startModel) - non
  // serve gestirlo a mano qui.
  const model = await ModelFactory.createModel(
    SUMMARY_MODEL_ID,
    provider,
    parameters
  )

  const { text: summary } = await generateText({
    model,
    system: COMPRESSION_SYSTEM_PROMPT,
    prompt: prose,
    // Tetto proporzionale alla lunghezza del blocco (vedi
    // estimateMaxSummaryTokens), non un numero fisso: previene un'altra fuga
    // come quella da 5360 token osservata, senza tagliare ingiustamente i
    // blocchi grandi a una manciata di parole indipendentemente dal contenuto.
    maxOutputTokens: estimateMaxSummaryTokens(prose),
  })

  return stripThinkingTags(summary)
}

/**
 * Comprime un intero blocco di reasoning (prosa + eventuale codice): separa
 * il codice, comprime solo la prosa se abbastanza lunga, riattacca il
 * codice INTATTO in coda. Se non c'è prosa sopra soglia (blocco fatto quasi
 * solo di codice, o già corto), il testo originale non viene toccato.
 */
async function compressReasoningBlock(text: string): Promise<string> {
  const { prose, codeBlocks } = splitCodeFromProse(text)

  if (prose.trim().length < MIN_PROSE_LENGTH) {
    return text
  }

  const compressedProse = await compressProseBlock(prose)

  // Ultima rete di sicurezza, non più la protezione principale ora che la
  // causa vera (thinking mode non disattivato) è corretta sopra: un
  // riassunto vuoto non deve comunque MAI sostituire il testo originale.
  if (!compressedProse.trim()) {
    return text
  }

  if (codeBlocks.length === 0) {
    return compressedProse
  }

  return [compressedProse, ...codeBlocks].join('\n\n')
}

/**
 * Clona `thread` in un nuovo thread, comprimendo la prosa dei blocchi di
 * reasoning dei messaggi assistant (codice sempre lasciato intatto - vedi
 * splitCodeFromProse). Ritorna il nuovo Thread creato (già inserito nello
 * store useThreads, quindi visibile in sidebar).
 */
export async function compressThreadReasoning(thread: Thread): Promise<Thread> {
  if (!thread.model) {
    throw new Error('Il thread non ha un modello assegnato')
  }
  // Fail-fast esplicito: niente fallback silenzioso sul modello principale
  // se il modello di riepilogo non è configurato - un fallback silenzioso
  // vanificherebbe lo scopo (velocità) senza che l'utente se ne accorga.
  if (!SUMMARY_MODEL_ID) {
    throw new Error(
      'SUMMARY_MODEL_ID non configurato in compressThread.ts: scarica il ' +
        'modello di riepilogo dall\'Hub di Jan e imposta il suo id esatto ' +
        'nella costante in cima al file.'
    )
  }

  const serviceHub = getServiceHub()

  // Legge dal disco, non dallo store in memoria: garantisce di avere la
  // conversazione completa anche se il thread non è quello attivo aperto.
  const originalMessages =
    (await serviceHub.messages().fetchMessages(thread.id)) ?? []

  // Preserva appartenenza al progetto e assistant personalizzato
  // dell'originale - createThread altrimenti crea il compresso fuori da
  // ogni progetto e con l'assistant di default, anche se l'originale
  // apparteneva a un progetto specifico o usava un assistant diverso.
  const newThread = await useThreads
    .getState()
    .createThread(
      thread.model,
      `[compresso] ${thread.title ?? ''}`.trim(),
      thread.assistants?.[0],
      thread.metadata?.project
    )

  // Jan collega i messaggi in catena/albero tramite metadata (non una
  // semplice lista in ordine) - usato per le conversazioni che si ramificano
  // (es. "Rigenera"): metadata.parentId punta al genitore, metadata.activeChildId
  // sul genitore dice quale figlio mostrare di default tra più versioni.
  // Ogni messaggio clonato riceve un id nuovo, quindi entrambi i riferimenti
  // vanno riscritti per puntare ai nuovi id corrispondenti - altrimenti Jan
  // vede i messaggi dopo il primo come "orfani" (parentId punta a un id del
  // thread vecchio) e la selezione di ramo attiva torna al default.
  //
  // Due giri necessari: activeChildId punta a un FIGLIO, il cui nuovo id non
  // è ancora noto quando si scrive il genitore in un giro solo in avanti.
  const oldIdToNewId = new Map<string, string>()
  for (const message of originalMessages) {
    oldIdToNewId.set(message.id, ulid())
  }

  for (const message of originalMessages) {
    // Un blocco alla volta, MAI in parallelo (niente Promise.all): chiamate
    // concorrenti allo stesso modello hanno prodotto blocchi vuoti in modo
    // intermittente durante il test (pattern osservato: alcuni blocchi
    // riassunti correttamente, altri diventati stringhe vuote, senza un
    // errore visibile in console) - sequenziale è più lento ma affidabile.
    const compressedContent = []
    for (const part of message.content) {
      if (part.type === ContentType.Reasoning && part.text) {
        const summary = await compressReasoningBlock(part.text.value)
        compressedContent.push({ ...part, text: { ...part.text, value: summary } })
      } else {
        compressedContent.push(part)
      }
    }

    const oldMeta = message.metadata as
      | { parentId?: string; activeChildId?: string }
      | undefined

    const newMetadata: Record<string, unknown> = { ...message.metadata }
    if (oldMeta?.parentId) {
      newMetadata.parentId = oldIdToNewId.get(oldMeta.parentId)
    }
    if (oldMeta?.activeChildId) {
      newMetadata.activeChildId = oldIdToNewId.get(oldMeta.activeChildId)
    }

    const clonedMessage: ThreadMessage = {
      ...message,
      id: oldIdToNewId.get(message.id)!,
      thread_id: newThread.id,
      content: compressedContent,
      metadata: newMetadata,
    }

    await serviceHub.messages().createMessage(clonedMessage)
  }

  return newThread
}