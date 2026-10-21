import { describe, it, expect, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  appendImageCopies,
  IMAGE_COPY_LINES,
  imageCopyLine,
  imageCopyName,
} from '../pastedImageCopies'
import type { Attachment } from '@/types/attachment'

const image = (mimeType: string, base64 = 'iVBORw0KGgo='): Attachment => ({
  name: 'x',
  type: 'image',
  mimeType,
  base64,
  dataUrl: `data:${mimeType};base64,${base64}`,
})
const when = new Date(2026, 9, 20, 21, 47, 3) // local time
const thread = '72119d07-1403-4ab3-ba4f-14db831ad87d'
// what the Rust command does when the name is free: the file gets the name asked for
const saveAsAsked = async (_threadId: string, name: string) => name

describe('imageCopyName', () => {
  it('uses the local date and time and the position', () => {
    expect(imageCopyName(when, 1, 'image/png')).toBe('2026-10-20_214703_1.png')
    expect(imageCopyName(when, 2, 'image/jpeg')).toBe('2026-10-20_214703_2.jpg')
    expect(imageCopyName(when, 3, 'image/jpg')).toBe('2026-10-20_214703_3.jpg')
  })

  it('refuses a type ChatInput does not accept', () => {
    expect(() => imageCopyName(when, 1, 'image/gif')).toThrow('unsupported image type')
  })
})

describe('imageCopyLine', () => {
  it('names the file as the sandbox sees it', () => {
    expect(imageCopyLine(1, '2026-10-20_214703_1.png')).toBe(
      '[Immagine 1 salvata anche come file: /immagini/2026-10-20_214703_1.png (nella sandbox, sola lettura)]'
    )
  })
})

describe('IMAGE_COPY_LINES', () => {
  it('finds every line imageCopyLine writes, and nothing else', () => {
    const a = imageCopyLine(1, '2026-10-20_214703_1.png')
    const b = imageCopyLine(12, '2026-10-25_023015_2-3.jpg')
    const text = `che quadro è? [Immagine 1 è bella]\n\n${a}\n${b}\n\n[ATTACHED_FILES]\n- a.pdf\n[/ATTACHED_FILES]`
    expect(text.match(IMAGE_COPY_LINES)).toEqual([a, b])
    expect('nessuna immagine'.match(IMAGE_COPY_LINES)).toBeNull()
    // a global regex shared by callers: a second use starts from the beginning again
    expect(text.match(IMAGE_COPY_LINES)).toEqual([a, b])
  })
})

describe('appendImageCopies', () => {
  it('leaves the text alone when the message has no image', async () => {
    const save = vi.fn()
    const doc: Attachment = { name: 'a.pdf', type: 'document', path: 'C:\\a.pdf' }
    expect(await appendImageCopies('ciao', [doc], thread, when, save)).toBe('ciao')
    expect(save).not.toHaveBeenCalled()
  })

  it('saves every image in order in the thread and adds one line for each', async () => {
    const save = vi.fn(saveAsAsked)
    const out = await appendImageCopies(
      'che quadro è?',
      [image('image/png'), image('image/jpeg', 'AAAA')],
      thread,
      when,
      save
    )
    expect(save.mock.calls).toEqual([
      [thread, '2026-10-20_214703_1.png', 'iVBORw0KGgo='],
      [thread, '2026-10-20_214703_2.jpg', 'AAAA'],
    ])
    expect(out).toBe(
      'che quadro è?\n\n' +
        imageCopyLine(1, '2026-10-20_214703_1.png') +
        '\n' +
        imageCopyLine(2, '2026-10-20_214703_2.jpg')
    )
  })

  it('names the file the Rust command actually wrote when the name was taken', async () => {
    const save = vi.fn(async (_t: string, name: string) => name.replace('.png', '-2.png'))
    const out = await appendImageCopies('t', [image('image/png')], thread, when, save)
    expect(out).toBe('t\n\n' + imageCopyLine(1, '2026-10-20_214703_1-2.png'))
  })

  it('skips an image without a MIME type, which is not sent to the model either', async () => {
    const save = vi.fn(saveAsAsked)
    const noType: Attachment = { ...image('image/png'), mimeType: undefined }
    expect(await appendImageCopies('t', [noType], thread, when, save)).toBe('t')
    expect(save).not.toHaveBeenCalled()
  })

  it('writes no file when one of the images has a type it cannot name', async () => {
    const save = vi.fn(saveAsAsked)
    await expect(
      appendImageCopies('t', [image('image/png'), image('image/gif')], thread, when, save)
    ).rejects.toThrow('unsupported image type: image/gif')
    expect(save).not.toHaveBeenCalled()
  })

  it('gives only the lines for an image sent without text', async () => {
    const out = await appendImageCopies('', [image('image/png')], thread, when, saveAsAsked)
    expect(out).toBe(imageCopyLine(1, '2026-10-20_214703_1.png'))
  })

  it('calls the Rust command by default', async () => {
    invoke.mockResolvedValueOnce('2026-10-20_214703_1.png')
    const out = await appendImageCopies('t', [image('image/png')], thread, when)
    expect(invoke).toHaveBeenCalledWith('save_pasted_image', {
      threadId: thread,
      name: '2026-10-20_214703_1.png',
      dataBase64: 'iVBORw0KGgo=',
    })
    expect(out).toBe('t\n\n' + imageCopyLine(1, '2026-10-20_214703_1.png'))
  })

  it('throws when a copy cannot be written', async () => {
    await expect(
      appendImageCopies('t', [image('image/png')], thread, when, async () => {
        throw 'the thread folder C:\\x does not exist'
      })
    ).rejects.toBe('the thread folder C:\\x does not exist')
  })
})
