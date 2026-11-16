import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import { getServiceHub } from '@/hooks/useServiceHub'
import { ExtensionManager } from '@/lib/extension'
import { VERIFY_MAX_OUTPUT_TOKENS } from '@/lib/verifyReply'

export const HUGGINGFACE_TOKEN_SECRET_KEY = 'huggingface'
type GeneralSettingState = {
  currentLanguage: Language
  spellCheckChatInput: boolean
  tokenCounterCompact: boolean
  autoUpdateCheck: boolean
  stripReasoningFromContext: boolean
  // Fork: the output cap of the verifier of a reply (see verifyReply).
  verifyMaxOutputTokens: number
  // Fork: how many times a reply is verified at each click (see verifySeries).
  verifyRepetitions: number
  huggingfaceToken?: string
  setHuggingfaceToken: (token: string) => void
  setSpellCheckChatInput: (value: boolean) => void
  setTokenCounterCompact: (value: boolean) => void
  setAutoUpdateCheck: (value: boolean) => void
  setStripReasoningFromContext: (value: boolean) => void
  setVerifyMaxOutputTokens: (value: number) => void
  setVerifyRepetitions: (value: number) => void
  setCurrentLanguage: (value: Language) => void
}

export const useGeneralSetting = create<GeneralSettingState>()(
  persist(
    (set) => ({
      currentLanguage: 'en',
      spellCheckChatInput: true,
      tokenCounterCompact: true,
      autoUpdateCheck: true,
      stripReasoningFromContext: false,
      verifyMaxOutputTokens: VERIFY_MAX_OUTPUT_TOKENS,
      verifyRepetitions: 1,
      huggingfaceToken: undefined,
      setSpellCheckChatInput: (value) => set({ spellCheckChatInput: value }),
      setTokenCounterCompact: (value) => set({ tokenCounterCompact: value }),
      setAutoUpdateCheck: (value) => set({ autoUpdateCheck: value }),
      setStripReasoningFromContext: (value) =>
        set({ stripReasoningFromContext: value }),
      setVerifyMaxOutputTokens: (value) =>
        set({ verifyMaxOutputTokens: value }),
      setVerifyRepetitions: (value) => set({ verifyRepetitions: value }),
      setCurrentLanguage: (value) => set({ currentLanguage: value }),
      setHuggingfaceToken: (token) => {
        set({ huggingfaceToken: token })
        // Canonical secret store is the OS keyring, not settings storage.
        getServiceHub()
          .core()
          .invoke('set_secret', {
            key: HUGGINGFACE_TOKEN_SECRET_KEY,
            value: token,
          })
          .catch((err) =>
            console.warn('Failed to persist huggingface token to keyring:', err)
          )
        ExtensionManager.getInstance()
          .getByName('@janhq/download-extension')
          ?.getSettings()
          .then((settings) => {
            if (settings) {
              const newSettings = settings.map((e) => {
                if (e.key === 'hf-token') {
                  e.controllerProps.value = token
                }
                return e
              })
              ExtensionManager.getInstance()
                .getByName('@janhq/download-extension')
                ?.updateSettings(newSettings)
            }
          })
          .catch((err) => {
            console.warn('Failed to persist huggingface token:', err)
          })
      },
    }),
    {
      name: localStorageKey.settingGeneral,
      storage: createJSONStorage(() => backendStorage),
      skipHydration: true,
      // huggingfaceToken is a secret — kept in the OS keyring, never persisted here.
      partialize: (state) => ({
        currentLanguage: state.currentLanguage,
        spellCheckChatInput: state.spellCheckChatInput,
        tokenCounterCompact: state.tokenCounterCompact,
        autoUpdateCheck: state.autoUpdateCheck,
        stripReasoningFromContext: state.stripReasoningFromContext,
        verifyMaxOutputTokens: state.verifyMaxOutputTokens,
        verifyRepetitions: state.verifyRepetitions,
      }),
    }
  )
)


