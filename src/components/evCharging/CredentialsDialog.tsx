import { isDefinedError } from '@orpc/client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangleIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '~/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '~/components/ui/alert-dialog'
import { Button } from '~/components/ui/button'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '~/components/ui/responsive-dialog'
import { useAppForm, useStore } from '~/hooks/form'
import {
  CREDENTIAL_FIELDS,
  type CredentialFieldName,
  type CredentialOrigin,
  type CredentialSource,
  credentialFieldKind,
  isCredentialField,
} from '~/lib/integrationCredentials'
import {
  credentialFieldHint,
  credentialFieldLabel,
  credentialsTitle,
  invalidFieldMessage,
} from '~/lib/integrationCredentialsMessage'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import { orpc, type RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import { formatDate } from './format'

export type CredentialStatus = RouterOutputs['credentials']['status']
type SourceStatus = CredentialStatus['sources'][CredentialSource]

const SKODA_KEYS_URL = 'https://go.skoda.eu/api-keys'

type Props = {
  source: CredentialSource | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  status: CredentialStatus | undefined
  /** Current suspect fields of the source (health.adminDetail.suspectFields), if any. */
  suspectFields: readonly string[] | null | undefined
  /** After a successful save or remove: the page runs that source's sync. */
  onChanged: (source: CredentialSource) => void
  onCloseAutoFocus?: (event: Event) => void
}

// One source's credentials (ADR-0026), opened by URL state (ADR-0013). Never
// shows a value: each field says where its value comes from, and a blank input
// keeps what is stored. Saving or removing runs that source's sync through
// `onChanged`, so the tile's health shows whether the new values work.
export function CredentialsDialog({
  source,
  open,
  onOpenChange,
  status,
  suspectFields,
  onChanged,
  onCloseAutoFocus,
}: Props) {
  // Keep the last source while the close animation runs (the URL clears first).
  const [shown, setShown] = useState(source)
  if (source && source !== shown) setShown(source)
  const current = source ?? shown
  // Counts opens, so each one starts a fresh form (empty inputs, no stale
  // errors) — even one that interrupts the close animation — while the form
  // stays rendered as the dialog fades out.
  const [opens, setOpens] = useState(0)
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setOpens((n) => n + 1)
  }

  return (
    <ResponsiveDialog open={open && current !== undefined} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        {current ? (
          <>
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>{credentialsTitle(current)}</ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                {m.charging_credentials_description()}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            <CredentialsForm
              key={`${current}-${opens}`}
              source={current}
              status={status}
              suspectFields={suspectFields ?? []}
              onDone={(changed) => {
                if (changed) onChanged(current)
                onOpenChange(false)
              }}
            />
          </>
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function originLine(sourceStatus: SourceStatus | undefined, field: string): string | null {
  if (!sourceStatus) return null // status not loaded: say nothing rather than guess
  const origin = (sourceStatus.fields as Record<string, { origin: CredentialOrigin }>)[field]
    ?.origin
  switch (origin) {
    case 'stored':
      return sourceStatus.updatedAt
        ? m.charging_credentials_origin_stored({ date: formatDate(sourceStatus.updatedAt) })
        : null
    case 'env':
      return m.charging_credentials_origin_env()
    case 'missing':
      return m.charging_credentials_origin_missing()
    default:
      return null
  }
}

// The source's name inside a sentence; the grid "source" is the agreement itself.
const sourceName = (source: CredentialSource) =>
  source === 'gridTariff' ? m.charging_grid_title() : integrationSourceName(source)

/** A field error the server reported, held until that field's value changes. */
type ServerError = { value: string; message: string }

function CredentialsForm({
  source,
  status,
  suspectFields,
  onDone,
}: {
  source: CredentialSource
  status: CredentialStatus | undefined
  suspectFields: readonly string[]
  onDone: (changed: boolean) => void
}) {
  const queryClient = useQueryClient()
  const fields: readonly CredentialFieldName[] = CREDENTIAL_FIELDS[source]
  const sourceStatus = status?.sources[source]
  const keyMissing = status?.encryptionKeyConfigured === false
  const stored = sourceStatus
    ? Object.values(sourceStatus.fields).some((f) => f.origin === 'stored') ||
      sourceStatus.unreadable
    : false

  // Field errors from the server, kept as state and checked by each field's
  // validator (not written into the error map, which TanStack clears on every
  // change/blur), so an error stays until that field's value actually changes.
  const [serverErrors, setServerErrors] = useState<Record<string, ServerError>>({})
  // Set on that rejection; a field can only take focus once the submit has
  // ended (inputs are disabled while submitting).
  const focusAfterSubmit = useRef(false)

  // A rejected field is shown on the field itself (the dialog stays open so it
  // can be fixed); any other failure is a toast.
  const showFieldErrors = (
    code: 'INVALID_FIELD' | 'REENTER_ALL_FIELDS',
    rejected: readonly string[],
  ) => {
    const errors: Record<string, ServerError> = {}
    for (const f of rejected) {
      if (!isCredentialField(source, f)) continue
      errors[f] = {
        // The value the server saw (blank for REENTER_ALL_FIELDS); inputs are
        // disabled while submitting, so the form still holds it.
        value: form.getFieldValue(f) ?? '',
        message:
          code === 'INVALID_FIELD'
            ? invalidFieldMessage(source, f)
            : m.charging_credentials_reenter_field(),
      }
    }
    if (Object.keys(errors).length === 0) {
      toast.error(m.charging_credentials_save_error())
      return
    }
    for (const f of Object.keys(errors))
      form.setFieldMeta(f, (meta) => ({ ...meta, isTouched: true }))
    focusAfterSubmit.current = true
    setServerErrors(errors)
  }

  // Saved credentials change what every sync uses and the sources' health.
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.credentials.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.evCharging.key() }),
    ])
  const set = useMutation(
    orpc.credentials.set.mutationOptions({
      onError: (err) => {
        if (
          isDefinedError(err) &&
          (err.code === 'INVALID_FIELD' || err.code === 'REENTER_ALL_FIELDS')
        )
          showFieldErrors(err.code, err.data.fields)
        else toast.error(m.charging_credentials_save_error())
      },
      onSettled: invalidate,
    }),
  )
  const clear = useMutation(orpc.credentials.clear.mutationOptions({ onSettled: invalidate }))

  const form = useAppForm({
    defaultValues: Object.fromEntries(fields.map((f) => [f, ''])) as Record<string, string>,
    validators: {
      onSubmit: ({ value }) =>
        Object.values(value).every((v) => v.trim() === '')
          ? m.charging_credentials_nothing_to_save()
          : undefined,
    },
    onSubmit: async ({ value }) => {
      // Blank means "keep what is stored": send only what was filled in.
      const filled = Object.fromEntries(Object.entries(value).filter(([, v]) => v.trim() !== ''))
      try {
        // The input is a union discriminated by `source`; `filled` holds only its fields.
        await set.mutateAsync({ source, fields: filled } as never)
      } catch {
        return // reported by onError; keep the dialog open to fix the input
      }
      toast.success(m.charging_credentials_saved())
      onDone(true)
    },
  })

  const isSubmitting = useStore(form.store, (st) => st.isSubmitting)
  useEffect(() => {
    // Surface the server's errors now that the field validators know them…
    for (const f of Object.keys(serverErrors)) form.validateField(f, 'change')
  }, [serverErrors, form])
  useEffect(() => {
    // …and move focus to the first one once the submit has finished.
    if (isSubmitting || !focusAfterSubmit.current) return
    focusAfterSubmit.current = false
    const first = fields.find((f) => serverErrors[f])
    if (first) document.getElementById(first)?.focus()
  }, [isSubmitting, fields, serverErrors])

  // Change-only: raised via validateField('change'), cleared by the next edit;
  // a blur never touches this slot, so the message stays put.
  const serverError =
    (field: string) =>
    ({ value }: { value: string }) => {
      const error = serverErrors[field]
      return error && error.value === value ? { message: error.message } : undefined
    }

  const remove = () =>
    clear.mutate(
      { source },
      {
        onSuccess: () => {
          toast.success(m.charging_credentials_removed())
          onDone(true)
        },
        onError: () => toast.error(m.charging_credentials_remove_error()),
      },
    )

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <div className="flex flex-col gap-5">
        {keyMissing ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertDescription>{m.charging_credentials_key_missing()}</AlertDescription>
          </Alert>
        ) : sourceStatus?.unreadable ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertDescription>{m.charging_credentials_unreadable()}</AlertDescription>
          </Alert>
        ) : null}
        {source === 'skoda' ? (
          <div className="flex flex-col items-start gap-1 text-muted-foreground text-sm">
            <p>{m.charging_credentials_skoda_help()}</p>
            <a
              href={SKODA_KEYS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex pointer-coarse:min-h-11 items-center gap-1 underline underline-offset-4 hover:text-foreground"
            >
              {m.charging_credentials_skoda_link()}
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </a>
          </div>
        ) : null}
        {fields.map((f, i) => {
          // Under the input, each on its own line: where the value comes from,
          // the format hint, and whether the last sync rejected it.
          const origin = originLine(sourceStatus, f)
          const hint = credentialFieldHint(source, f)
          const suspect = suspectFields.includes(f)
          const description =
            origin || hint || suspect ? (
              <>
                {origin ? <span className="block">{origin}</span> : null}
                {hint ? <span className="block">{hint}</span> : null}
                {suspect ? (
                  <span className="block text-destructive">
                    {m.charging_credentials_field_suspect()}
                  </span>
                ) : null}
              </>
            ) : undefined
          return (
            <form.AppField
              key={f}
              name={f}
              validators={{ onChange: serverError(f) }}
              children={(field) => (
                <field.TextField
                  label={credentialFieldLabel(source, f)}
                  type={credentialFieldKind(source, f) === 'secret' ? 'password' : 'text'}
                  autoComplete="off"
                  autoFocus={i === 0 && !keyMissing}
                  disabled={keyMissing}
                  description={description}
                />
              )}
            />
          )
        })}
        <form.Subscribe
          selector={(st) => st.errorMap.onSubmit}
          children={(error) =>
            error ? (
              <p role="alert" className="text-destructive text-sm">
                {String(error)}
              </p>
            ) : null
          }
        />
      </div>

      <ResponsiveDialogFooter className="mt-6 flex-wrap">
        {stored ? (
          <div className="basis-full sm:mr-auto sm:basis-auto">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="pointer-coarse:h-11 w-full text-destructive hover:text-destructive sm:w-auto"
                  disabled={clear.isPending}
                >
                  {m.charging_credentials_remove()}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{m.charging_credentials_remove_title()}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {m.charging_credentials_remove_confirm({
                      source: sourceName(source),
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
                  {/* Closes the confirm; the credentials dialog closes once the remove succeeds. */}
                  <AlertDialogAction variant="destructive" onClick={remove}>
                    {m.charging_credentials_remove()}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : null}
        <form.AppForm>
          <form.CancelButton onClick={() => onDone(false)}>{m.common_cancel()}</form.CancelButton>
          <form.SubmitButton label={m.common_save()} disabled={keyMissing} />
        </form.AppForm>
      </ResponsiveDialogFooter>
    </form>
  )
}
