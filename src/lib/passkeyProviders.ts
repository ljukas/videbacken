import providers from '~/data/passkeyAaguids.json'

type ProviderEntry = {
  name: string
  icon_light?: string
  icon_dark?: string
}

const registry = providers as Record<string, ProviderEntry>

export type PasskeyProvider = {
  name: string
  iconLight?: string
  iconDark?: string
}

export function getPasskeyProvider(aaguid: string | null | undefined): PasskeyProvider | null {
  if (!aaguid) return null
  const entry = registry[aaguid]
  if (!entry) return null
  return {
    name: entry.name,
    iconLight: entry.icon_light,
    iconDark: entry.icon_dark,
  }
}
