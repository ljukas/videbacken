import { z } from 'zod'
import { CREDENTIAL_SOURCES } from '~/lib/integrationCredentials'
import { INTEGRATION_SOURCES } from '~/lib/integrationHealth'

// The settings page's URL state, apart from the page so the old
// /charging/settings redirect can carry it without loading the page's code.
// The `-` prefix keeps this file out of the route tree.
export const settingsSearchSchema = z.object({
  // Dialogs (ADR-0013): tariff new (pre-filled from the newest period), edit,
  // delete; the car's log import; one data source's sync history or credentials.
  dialog: z
    .enum(['tariffNew', 'tariffEdit', 'tariffDelete', 'vehicleImport', 'syncRuns', 'credentials'])
    .optional()
    .catch(undefined),
  tariffId: z.string().optional().catch(undefined),
  // The source whose sync history (`dialog=syncRuns`, an integration source) or
  // credentials (`dialog=credentials`, a credential source) are open.
  source: z
    .union([z.enum(INTEGRATION_SOURCES), z.enum(CREDENTIAL_SOURCES)])
    .optional()
    .catch(undefined),
})
export type SettingsSearch = z.infer<typeof settingsSearchSchema>
