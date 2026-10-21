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
// Testato in dev mode (make dev) sul thread NasdaqPredictor il 2026-09-21/22.
// Il typecheck completo (tsc -b, eseguito da `yarn build`) NON e' stato
// verificato: va controllato sulla build release, il dev mode non lo esegue.

import { generateText } from 'ai'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { ulid } from 'ulidx'
import { ContentType, type ThreadMessage } from '@janhq/core'
import { ModelFactory } from '@/lib/model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { useMessages } from '@/hooks/useMessages'
import { getServiceHub } from '@/hooks/useServiceHub'

/**
 * Modello usato per comprimere. null = lo stesso modello del thread (il
 * modello principale della conversazione), che e' l'impostazione attuale.
 *
 * Storia: fino al 2026-09-23 si usava un modello piccolo separato
 * ({ id: 'Jan-v3_5-4B', provider: 'llamacpp' }, il motore interno di Jan).
 * Misurato su NasdaqPredictor: non seguiva l'istruzione "un decimo"
 * (lunghezza mediana dei riassunti ~2.8x il target) e in 11 blocchi su 52
 * produceva generazioni anomale da rigenerare. Per tornare a quel modello,
 * rimettere qui quell'oggetto.
 *
 * Con null, mentre la compressione gira il server del modello principale e'
 * occupato, e la sua cache di prompt del thread originale viene persa.
 */
const SUMMARY_MODEL_OVERRIDE: ThreadModel | null = null

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
 * Tetto del retry: il doppio del primo tentativo.
 */
const MAX_RETRY_TOKENS = 1600

/**
 * Tetto del primo tentativo. Fisso, non proporzionale alla lunghezza del
 * blocco. Misure fatte col modello 4B (vedi SUMMARY_MODEL_OVERRIDE), non
 * ancora col modello principale: Jan-v3_5-4B non rispetta un rapporto di compressione dato nel
 * prompt, e un tetto proporzionale (~1/10) lo tagliava a meta' frase
 * (run 2026-09-22: 45 retry, 33 blocchi su 52 marcati). Con 800 fisso
 * (run 2026-09-23): 41 blocchi su 52 finiti da soli (mediana 416 token),
 * 11 retry, 0 marcati, compressione complessiva del reasoning 5.9x.
 * 800 non e' ottimizzato: e' il valore testato. Resta basso abbastanza da
 * interrompere presto una generazione anomala (ripetizioni), che il retry
 * rigenera da capo.
 */
const FIRST_ATTEMPT_TOKENS = 800

/**
 * Appeso a un riassunto tagliato anche dopo il retry, perche' chi legge il
 * thread compresso sappia che quel blocco e' incompleto.
 */
const TRUNCATION_MARKER = ' [...troncato]'

/**
 * Rileva il taglio da maxOutputTokens confrontando i token generati col
 * tetto richiesto, NON leggendo finishReason: llama.cpp ha un bug noto e
 * aperto (ggml-org/llama.cpp issue #8856) per cui l'endpoint
 * OpenAI-compatibile puo' riportare "stop" anche quando ha tagliato per
 * max_tokens. Confronto esatto, senza margine di tolleranza: su 44 chiamate
 * reali (2026-09-21) ogni taglio aveva outputTokens identico al tetto, e
 * ogni fine naturale restava sotto. outputTokens mancante rende il taglio
 * non rilevabile: fail-fast invece di assumere che il blocco sia completo.
 */
function hitTokenCap(outputTokens: number | undefined, cap: number): boolean {
  if (outputTokens === undefined) {
    throw new Error(
      'usage.outputTokens non riportato dal provider di riepilogo: ' +
        'impossibile rilevare se il riassunto e\' stato troncato.'
    )
  }
  return outputTokens >= cap
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
async function compressProseBlock(
  prose: string,
  summaryModel: ThreadModel,
  stats: CompressStats,
  signal: AbortSignal
): Promise<string> {
  const provider = useModelProvider
    .getState()
    .getProviderByName(summaryModel.provider)
  if (!provider) {
    throw new Error(
      `Provider di riepilogo non trovato: ${summaryModel.provider}`
    )
  }
  // CAUSA VERA dei riassunti vuoti osservati nel test: Qwen3.5 è un modello
  // "pensante" - scrive un blocco <think>...</think> prima della risposta.
  // Con un tetto di token stretto, il
  // pensiero consuma tutto il budget e non resta nulla per il riassunto
  // vero. Stesso fix già usato da Jan in thread-title-summarizer.ts per lo
  // stesso tipo di modello, per lo stesso tipo di compito (poco testo in
  // uscita da un modello Qwen3).
  //
  // Inviato a qualunque provider, non solo 'llamacpp': anche il server del
  // modello principale (llama_local) e' llama.cpp mainline, che applica
  // chat_template_kwargs.enable_thinking per singola richiesta. Un provider
  // remoto che non conosce il campo potrebbe rifiutarlo: da rivedere se si
  // comprime un thread con un modello remoto.
  const parameters: Record<string, unknown> = {
    chat_template_kwargs: { enable_thinking: false },
  }
  // ModelFactory.createModel, per provider 'llamacpp', avvia il modello se
  // non è già in esecuzione (vedi createLlamaCppModel -> startModel) - non
  // serve gestirlo a mano qui.
  const model = await ModelFactory.createModel(
    summaryModel.id,
    provider,
    parameters
  )

  const generate = (maxOutputTokens: number) =>
    generateText({
      model,
      system: COMPRESSION_SYSTEM_PROMPT,
      prompt: prose,
      maxOutputTokens,
      // Interrompe anche la generazione in corso, non solo il ciclo: senza,
      // uno stop aspetterebbe la fine del blocco (fino a 1600 token).
      abortSignal: signal,
    })

  const cap = FIRST_ATTEMPT_TOKENS
  let result = await generate(cap)
  if (!hitTokenCap(result.usage.outputTokens, cap)) {
    return stripThinkingTags(result.text)
  }

  // Tetto colpito: un solo retry con tetto doppio. Se taglia anche quello il
  // blocco viene restituito con un marcatore visibile, mai spacciato per
  // completo, invece di rincorrere il tetto all'infinito.
  const retryCap = Math.min(MAX_RETRY_TOKENS, cap * 2)
  stats.retries++
  console.warn(`[compress] tetto colpito (cap=${cap}), retry con ${retryCap}`)
  result = await generate(retryCap)
  const summary = stripThinkingTags(result.text)
  if (!hitTokenCap(result.usage.outputTokens, retryCap)) {
    return summary
  }
  console.warn(
    `[compress] tetto colpito anche al retry (cap=${retryCap}), blocco marcato`
  )
  stats.marked++
  return summary ? summary + TRUNCATION_MARKER : ''
}

/**
 * Comprime un intero blocco di reasoning (prosa + eventuale codice): separa
 * il codice, comprime solo la prosa se abbastanza lunga, riattacca il
 * codice INTATTO in coda. Se non c'è prosa sopra soglia (blocco fatto quasi
 * solo di codice, o già corto), il testo originale non viene toccato.
 */
async function compressReasoningBlock(
  text: string,
  summaryModel: ThreadModel,
  stats: CompressStats,
  signal: AbortSignal
): Promise<string> {
  const { prose, codeBlocks } = splitCodeFromProse(text)

  if (prose.trim().length < MIN_PROSE_LENGTH) {
    return text
  }

  const compressedProse = await compressProseBlock(
    prose,
    summaryModel,
    stats,
    signal
  )

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
 * Lanciata quando la compressione viene interrotta: 'stop' = pulsante
 * Interrompi (il thread parziale viene eliminato qui), 'deleted' = l'utente
 * ha eliminato il thread in compressione dalla sidebar.
 */
export class CompressionCancelled extends Error {
  constructor(readonly reason: 'stop' | 'deleted') {
    super(`Compressione interrotta (${reason})`)
    this.name = 'CompressionCancelled'
  }
}

/** Retry e blocchi marcati durante una compressione. */
export type CompressStats = { retries: number; marked: number }

/**
 * Avanzamento riportato dopo ogni blocco di reasoning e dopo ogni messaggio
 * scritto. `doneChars/totalChars` pesa i blocchi per lunghezza: un blocco da
 * 36.000 caratteri richiede molto piu' tempo di uno da 400, quindi la
 * percentuale sui caratteri segue il tempo meglio del conteggio dei blocchi.
 * Resta un'approssimazione: il tempo per blocco non e' proporzionale ai
 * caratteri (tetto fisso di output, retry).
 */
export type CompressProgress = {
  doneBlocks: number
  totalBlocks: number
  doneMessages: number
  totalMessages: number
  doneChars: number
  totalChars: number
}

/**
 * Clona `thread` in un nuovo thread, comprimendo la prosa dei blocchi di
 * reasoning dei messaggi assistant (codice sempre lasciato intatto - vedi
 * splitCodeFromProse). Ritorna il nuovo Thread creato (già inserito nello
 * store useThreads, quindi visibile in sidebar).
 */
export async function compressThreadReasoning(
  thread: Thread,
  onProgress?: (progress: CompressProgress) => void,
  stopSignal?: AbortSignal
): Promise<{ thread: Thread; stats: CompressStats }> {
  if (!thread.model) {
    throw new Error('Il thread non ha un modello assegnato')
  }
  const summaryModel = SUMMARY_MODEL_OVERRIDE ?? thread.model

  const serviceHub = getServiceHub()

  // Legge dal disco, non dallo store in memoria: garantisce di avere la
  // conversazione completa anche se il thread non è quello attivo aperto.
  const originalMessages =
    (await serviceHub.messages().fetchMessages(thread.id)) ?? []

  const stats: CompressStats = { retries: 0, marked: 0 }
  const reasoningTexts = originalMessages.flatMap((m) =>
    m.content
      .filter((part) => part.type === ContentType.Reasoning && part.text)
      .map((part) => part.text!.value)
  )
  const progress: CompressProgress = {
    doneBlocks: 0,
    totalBlocks: reasoningTexts.length,
    doneMessages: 0,
    totalMessages: originalMessages.length,
    doneChars: 0,
    totalChars: reasoningTexts.reduce((sum, t) => sum + t.length, 0),
  }
  onProgress?.({ ...progress })

  // Preserva appartenenza al progetto e assistant personalizzato
  // dell'originale - createThread altrimenti crea il compresso fuori da
  // ogni progetto e con l'assistant di default, anche se l'originale
  // apparteneva a un progetto specifico o usava un assistant diverso.
  const newThread = await useThreads
    .getState()
    .createThread(
      thread.model,
      `[compressione in corso] ${thread.title ?? ''}`.trim(),
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

  // Un solo segnale interno, alimentato da due fonti: il pulsante
  // Interrompi (stopSignal) e l'eliminazione del thread in compressione
  // dalla sidebar (sottoscrizione allo store). Senza la seconda, eliminare
  // il thread lasciava il ciclo girare fino alla fine a vuoto (le scritture
  // su un thread inesistente falliscono in silenzio in createMessage) e
  // chiudeva con un falso "Thread compressed".
  const controller = new AbortController()
  const onStop = () => controller.abort(new CompressionCancelled('stop'))
  if (stopSignal?.aborted) onStop()
  stopSignal?.addEventListener('abort', onStop, { once: true })
  const unsubscribe = useThreads.subscribe((state) => {
    if (!state.threads[newThread.id]) {
      controller.abort(new CompressionCancelled('deleted'))
    }
  })
  const throwIfCancelled = () => {
    if (controller.signal.aborted) throw controller.signal.reason
  }

  // Raccolta dei messaggi clonati man mano che vengono scritti, per poterli
  // spingere di peso nello store React alla fine (vedi sotto perché serve).
  // Fuori dal try: serve anche dopo, per setMessages.
  const clonedMessages: ThreadMessage[] = []

  try {
    // Immagini incollate (21/10/2026): i messaggi copiati le nominano come
    // /immagini/<file>, che la sandbox cerca nella cartella del thread da cui
    // arriva la chiamata (lib/pastedImageCopies.ts). Vanno quindi anche nella
    // cartella del thread nuovo: collegamenti fissi (hard link), stessi file
    // sul disco senza spazio in più, ognuno resta finché esiste un thread che
    // lo ha. Subito, prima di copiare i messaggi: la compressione può durare
    // minuti, e se intanto il thread originale viene eliminato, o la
    // compressione si ferma a metà, le immagini restano nel thread nuovo. Se
    // il collegamento fallisce la compressione prosegue, con un avviso. Se
    // però nel frattempo è stata interrotta (Interrompi, o thread nuovo
    // eliminato) vale l'interruzione, come in ogni altro punto del ciclo.
    throwIfCancelled()
    try {
      await invoke<number>('link_thread_images', {
        fromThreadId: thread.id,
        toThreadId: newThread.id,
      })
    } catch (e) {
      throwIfCancelled()
      console.error('[compress] link_thread_images:', e)
      toast.error(
        `The images of this thread were not linked into its compressed copy: ${e instanceof Error ? e.message : String(e)}`
      )
    }
    throwIfCancelled()

    for (const message of originalMessages) {
      // Un blocco alla volta, MAI in parallelo (niente Promise.all): chiamate
      // concorrenti allo stesso modello hanno prodotto blocchi vuoti in modo
      // intermittente durante il test (pattern osservato: alcuni blocchi
      // riassunti correttamente, altri diventati stringhe vuote, senza un
      // errore visibile in console) - sequenziale è più lento ma affidabile.
      const compressedContent = []
      for (const part of message.content) {
        if (part.type === ContentType.Reasoning && part.text) {
          throwIfCancelled()
          const summary = await compressReasoningBlock(
            part.text.value,
            summaryModel,
            stats,
            controller.signal
          )
          compressedContent.push({ ...part, text: { ...part.text, value: summary } })
          progress.doneBlocks++
          progress.doneChars += part.text.value.length
          onProgress?.({ ...progress })
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

      throwIfCancelled()
      await serviceHub.messages().createMessage(clonedMessage)
      clonedMessages.push(clonedMessage)
      progress.doneMessages++
      onProgress?.({ ...progress })
    }
  } catch (error) {
    // Un abort durante generateText arriva come errore dell'SDK, non come
    // CompressionCancelled: il motivo vero e' nel segnale.
    const cause = controller.signal.aborted ? controller.signal.reason : error
    if (cause instanceof CompressionCancelled && cause.reason === 'stop') {
      unsubscribe()
      useThreads.getState().deleteThread(newThread.id)
    }
    throw cause
  } finally {
    unsubscribe()
    stopSignal?.removeEventListener('abort', onStop)
  }

  // createThread() sopra imposta subito currentThreadId sul thread nuovo
  // (ancora vuoto in quel momento) - questo fa navigare l'app sulla route
  // del thread compresso PRIMA che il ciclo qui sopra finisca di scrivere i
  // messaggi. $threadId.tsx fa un fetch immediato (vede 0-1 messaggi), lo
  // marca come già "visitato" con un ref interno, e quella guardia impedisce
  // un refetch quando l'utente ci torna dentro più tardi - anche se nel
  // frattempo il thread si è riempito su disco. Bug osservato empiricamente:
  // il thread compresso mostrava solo il primo messaggio anche dopo essere
  // uscito e rientrato, pur avendo tutti i messaggi corretti su disco
  // (verificato via messages.jsonl). Si spinge lo stato finale direttamente
  // nello store React in memoria: il componente già montato lo rilegge in
  // modo reattivo, a prescindere da quella guardia.
  useMessages.getState().setMessages(newThread.id, clonedMessages)

  // Rinomina solo ora che tutti i messaggi sono scritti: un thread
  // interrotto a meta' (errore, app chiusa, PC ibernato - successo il
  // 2026-09-21, rimasto a 21/28 messaggi senza alcun errore nel log) resta
  // riconoscibile dal titolo "[compressione in corso]" invece di sembrare
  // completo.
  const finalTitle = `[compresso] ${thread.title ?? ''}`.trim()
  useThreads.getState().updateThread(newThread.id, { title: finalTitle })

  return { thread: { ...newThread, title: finalTitle }, stats }
}