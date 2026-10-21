// Fork (21/10/2026): every image sent in a chat message is also saved as a file in the thread's own folder,
// threads/<thread id>/immagini/ (Rust command save_pasted_image, src-tauri/src/core/pasted_images.rs), and the
// message gets one line per image naming the file as the code sandbox sees it. The model sees a pasted image only as
// image tokens; with the file, the sandbox can open it: for a tool call from this thread it mounts that folder
// read-only as /immagini (Jan sends the thread id in the call's _meta, src-tauri/src/core/mcp/thread_meta.rs), so the
// model can crop and enlarge a detail. The files go with the thread when it is deleted. The lines are part of the
// message text, so the prompt prefix stays the same on later turns.
import { invoke } from '@tauri-apps/api/core'
import type { Attachment } from '@/types/attachment'

/** Where the code sandbox mounts the images of the thread a tool call comes from, read-only. */
export const SANDBOX_IMAGES_DIR = '/immagini'

// The image types ChatInput accepts (processImageFiles)
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `2026-10-20_214733_1.png`: local date and time of sending, then the image's position in the message (from 1). */
export function imageCopyName(date: Date, position: number, mimeType: string): string {
  const ext = EXTENSIONS[mimeType]
  if (!ext) throw new Error(`unsupported image type: ${mimeType}`)
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${day}_${time}_${position}.${ext}`
}

/** The line added to the message for the image at `position`, saved under the file name `name`. */
export function imageCopyLine(position: number, name: string): string {
  return `[Immagine ${position} salvata anche come file: ${SANDBOX_IMAGES_DIR}/${name} (nella sandbox, sola lettura)]`
}

/**
 * Every line imageCopyLine writes, as found in a message text. custom-chat-transport.ts uses it to keep the lines of
 * an unanswered turn together with that turn's images. Global and shared: use it only with String.prototype.match,
 * which starts from the beginning every time (test and exec carry lastIndex over from one call to the next, and
 * matchAll starts from where they left it).
 */
export const IMAGE_COPY_LINES =
  /^\[Immagine \d+ salvata anche come file: \/immagini\/[A-Za-z0-9_.-]+ \(nella sandbox, sola lettura\)\]$/gm

/**
 * Saves in the folder of thread `threadId` the images the message sends to the model (type image with a data URL
 * and a MIME type: processAndSendMessage sends no other) and returns `text` followed by one line per image, or `text`
 * unchanged when there is none. Throws if a copy cannot be written. `save` returns the name the file got: the one
 * asked for, or a variant of it when that name is taken (two images in the same second, or in the hour that repeats
 * when clocks go back).
 */
export async function appendImageCopies(
  text: string,
  attachments: Attachment[],
  threadId: string,
  now: Date = new Date(),
  save: (threadId: string, name: string, dataBase64: string) => Promise<string> = (
    threadId,
    name,
    dataBase64
  ) => invoke<string>('save_pasted_image', { threadId, name, dataBase64 })
): Promise<string> {
  const images = attachments.filter((a) => a.type === 'image' && a.dataUrl && a.mimeType)
  if (images.length === 0) return text
  // every name first: a type that cannot be named stops the copies before any file is written
  const wanted = images.map((image, i) => imageCopyName(now, i + 1, image.mimeType as string))
  const lines: string[] = []
  for (let i = 0; i < images.length; i++) {
    const dataUrl = images[i].dataUrl as string
    const saved = await save(threadId, wanted[i], dataUrl.slice(dataUrl.indexOf(',') + 1))
    lines.push(imageCopyLine(i + 1, saved))
  }
  return text ? `${text}\n\n${lines.join('\n')}` : lines.join('\n')
}
