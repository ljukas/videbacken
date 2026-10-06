import { isDefinedError } from '@orpc/client'
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangleIcon, ExternalLinkIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
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
  isOptionalCredentialField,
} from '~/lib/integrationCredentials'
import {
  credentialFieldHint,
  credentialFieldList,
  credentialsTitle,
  invalidFieldMessage,
} from '~/lib/integrationCredentialsMessage'
import { integrationSourceName } from '~/lib/integrationHealthMessage'
import { orpc, type RouterInputs, type RouterOutputs } from '~/lib/orpc/client'
import { m } from '~/paraglide/messages'
import {
  CredentialFieldRow,
  type CredentialFieldState,
  credentialBadgeId,
  credentialLabelId,
  credentialRevealId,
  credentialSuspectId,
  credentialInputId as inputId,
  isClosableState,
} from './CredentialFieldRow'

export type CredentialStatus = RouterOutputs['credentials']['status']
type SourceStatus = CredentialStatus['sources'][CredentialSource]
type SetCredentialsInput = RouterInputs['credentials']['set']

// The input is a union discriminated by `source`, which TypeScript can't tie to
// a runtime `source`; the form only ever holds that source's fields.
const setInput = (source: CredentialSource, fields: Record<string, string>) =>
  ({ source, fields }) as SetCredentialsInput

const SKODA_KEYS_URL = 'https://go.skoda.eu/api-keys'

const cancelId = (source: CredentialSource) => `credential-${source}-cancel`
const keyMissingId = (source: CredentialSource) => `credential-${source}-key-missing`

// Password managers ignore autocomplete="off" on password inputs; these opt-outs
// (1Password, LastPass, Bitwarden, Dashlane) keep a saved login from being
// filled in and silently resubmitted.
const NO_PASSWORD_MANAGER = {
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-form-type': 'other',
} as const

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
// shows a value: each field says where its value comes from, and a field that
// has one stays closed until the admin chooses to replace it. Saving or removing
// runs that source's sync through `onChanged`, so the tile's health shows
// whether the new values work.
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
  // A save or remove in flight: Escape, the overlay, the X and Cancel are
  // ignored until it settles, so its result never lands on a closed (or
  // reopened) form.
  const busy = useIsMutating({ mutationKey: orpc.credentials.key() }) > 0
  const keyMissing = status?.encryptionKeyConfigured === false
  const dismiss = () => {
    if (!busy) onOpenChange(false)
  }

  return (
    <ResponsiveDialog
      open={open && current !== undefined}
      onOpenChange={(next) => (next ? onOpenChange(true) : dismiss())}
    >
      <ResponsiveDialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(e) => {
          if (!current) return
          // Nothing can be saved without the key: start on Cancel, never on the
          // destructive Remove (the first tabbable once the inputs are disabled).
          if (keyMissing) {
            e.preventDefault()
            document.getElementById(cancelId(current))?.focus()
            return
          }
          // Every field closed (no input to autofocus): start on the first reveal
          // button, not on the external MyŠkoda link above it.
          const fields = CREDENTIAL_FIELDS[current]
          const sourceStatus = status?.sources[current]
          if (!fields.every((f) => isClosableState(fieldState(sourceStatus, f)))) return
          e.preventDefault()
          document.getElementById(credentialRevealId(current, fields[0]))?.focus()
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {current ? (
          <>
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>{credentialsTitle(current)}</ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                {current === 'gridTariff'
                  ? m.charging_credentials_dialog_description_grid()
                  : m.charging_credentials_dialog_description({
                      source: integrationSourceName(current),
                    })}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            <CredentialsForm
              key={`${current}-${opens}`}
              source={current}
              status={status}
              suspectFields={suspectFields ?? []}
              onDone={(changed) => {
                if (!changed) return dismiss()
                onChanged(current)
                onOpenChange(false)
              }}
            />
          </>
        ) : null}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function fieldState(sourceStatus: SourceStatus | undefined, field: string): CredentialFieldState {
  if (!sourceStatus) return 'unknown' // status not loaded: say nothing rather than guess
  // An unreadable row fails the whole source closed: no field falls back to env (ADR-0026).
  if (sourceStatus.unreadable) return 'unreadable'
  const fields = sourceStatus.fields as Record<string, { origin: CredentialOrigin }>
  return fields[field]?.origin ?? 'unknown'
}

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
  // What the remove confirm says: which saved fields go (unknown for an
  // unreadable row) and whether the env vars then cover the source's required fields.
  const statusFields = (sourceStatus?.fields ?? {}) as Record<
    string,
    { origin: CredentialOrigin; envSet: boolean } | undefined
  >
  const storedFields = fields.filter((f) => statusFields[f]?.origin === 'stored')
  const requiredFields = fields.filter((f) => !isOptionalCredentialField(source, f))
  const envCount = requiredFields.filter((f) => statusFields[f]?.envSet).length
  const isGrid = source === 'gridTariff'
  const afterRemove =
    envCount === requiredFields.length
      ? isGrid
        ? m.charging_credentials_remove_falls_back_one()
        : m.charging_credentials_remove_falls_back()
      : envCount > 0
        ? m.charging_credentials_remove_env_incomplete()
        : isGrid
          ? m.charging_credentials_remove_stops_grid()
          : m.charging_credentials_remove_stops()
  const removeConfirm = isGrid
    ? m.charging_credentials_remove_confirm_grid()
    : sourceStatus?.unreadable
      ? m.charging_credentials_remove_confirm_unreadable({ source: integrationSourceName(source) })
      : m.charging_credentials_remove_confirm({
          source: integrationSourceName(source),
          fields: credentialFieldList(source, storedFields),
        })
  const states = Object.fromEntries(fields.map((f) => [f, fieldState(sourceStatus, f)])) as Record<
    CredentialFieldName,
    CredentialFieldState
  >

  // Which fields show their input (UI state, not a value). A field without a
  // value (missing, unreadable, status unknown) is always open; one with a value
  // opens on its reveal button or a server error. A field joins the set as soon
  // as it has no value (on a status refetch too) and leaves only on "Avbryt", so
  // a refetch that gives it a value never hides an input that may hold typing.
  const [opened, setOpened] = useState<ReadonlySet<CredentialFieldName>>(
    () => new Set(fields.filter((f) => !isClosableState(states[f]))),
  )
  const newlyUnclosable = fields.filter((f) => !isClosableState(states[f]) && !opened.has(f))
  if (newlyUnclosable.length > 0) setOpened((prev) => new Set([...prev, ...newlyUnclosable]))
  const isOpen = (f: CredentialFieldName) => opened.has(f) || !isClosableState(states[f])
  const anyOpen = fields.some(isOpen)
  // The first open input takes focus when the dialog opens.
  const [autoFocusField] = useState(() => fields.find(isOpen))
  // What a save sends: open inputs only, and blank means "keep what is there".
  const toSend = (value: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(value).filter(([f, v]) => isOpen(f as CredentialFieldName) && v.trim() !== ''),
    )

  // Field errors from the server, kept as state and checked by each field's
  // validator (not written into the error map, which TanStack clears on every
  // change/blur), so an error stays until that field's value actually changes.
  // An entry (holding the rejected, possibly secret value) is dropped as soon
  // as its field changes.
  const [serverErrors, setServerErrors] = useState<Record<string, ServerError>>({})
  // The input to focus once the submit has ended (inputs are disabled while
  // submitting, so they can't take focus before).
  const [focusTarget, setFocusTarget] = useState<string | null>(null)

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
    const first = fields.find((f) => errors[f])
    if (!first) {
      toast.error(m.charging_credentials_save_error())
      return
    }
    // A closed field opens to show its error (marked touched once it has mounted, below).
    setOpened((prev) => new Set([...prev, ...(Object.keys(errors) as CredentialFieldName[])]))
    setServerErrors(errors)
    setFocusTarget(inputId(source, first))
  }

  // Saved credentials change what every sync uses and the sources' health.
  // Not awaited: the dialog closes on success without waiting for the refetches.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.credentials.key() })
    void queryClient.invalidateQueries({ queryKey: orpc.evCharging.key() })
  }
  const set = useMutation(
    orpc.credentials.set.mutationOptions({
      // The variables hold the plaintext values: don't keep them in the
      // MutationCache once the mutation has settled.
      gcTime: 0,
      onError: (err) => {
        if (
          isDefinedError(err) &&
          (err.code === 'INVALID_FIELD' || err.code === 'REENTER_ALL_FIELDS')
        )
          showFieldErrors(err.code, err.data.fields)
        // The status read failed (so the dialog didn't know) and the key is missing.
        else if (isDefinedError(err) && err.code === 'ENCRYPTION_KEY_MISSING')
          toast.error(m.charging_credentials_key_missing())
        else toast.error(m.charging_credentials_save_error())
      },
      onSettled: invalidate,
    }),
  )
  const clear = useMutation(
    orpc.credentials.clear.mutationOptions({ gcTime: 0, onSettled: invalidate }),
  )
  const busy = set.isPending || clear.isPending

  const form = useAppForm({
    defaultValues: Object.fromEntries(fields.map((f) => [f, ''])) as Record<string, string>,
    validators: {
      onSubmit: ({ value }) =>
        Object.keys(toSend(value)).length === 0
          ? m.charging_credentials_nothing_to_save()
          : undefined,
    },
    // Refused before reaching the server (nothing filled in, or a field still
    // shows the server's error): focus where the fix goes.
    onSubmitInvalid: ({ formApi }) => {
      const first =
        fields.find((f) => (formApi.getFieldMeta(f)?.errors.length ?? 0) > 0) ?? fields.find(isOpen)
      if (first) setFocusTarget(inputId(source, first))
    },
    onSubmit: async ({ value }) => {
      const filled = toSend(value)
      try {
        await set.mutateAsync(setInput(source, filled))
      } catch {
        return // reported by onError; keep the dialog open to fix the input
      }
      toast.success(m.charging_credentials_saved())
      onDone(true)
    },
  })

  const isSubmitting = useStore(form.store, (st) => st.isSubmitting)
  useEffect(() => {
    // Surface the server's errors now that the field validators know them (and
    // a field opened for its error has mounted)…
    for (const f of Object.keys(serverErrors)) {
      form.setFieldMeta(f, (meta) => ({ ...meta, isTouched: true }))
      form.validateField(f, 'change')
    }
  }, [serverErrors, form])
  useEffect(() => {
    // …and move focus once the submit has finished.
    if (isSubmitting || !focusTarget) return
    document.getElementById(focusTarget)?.focus()
    setFocusTarget(null)
  }, [isSubmitting, focusTarget])

  // Change-only: raised via validateField('change'), cleared by the next edit;
  // a blur never touches this slot, so the message stays put.
  const serverError =
    (field: string) =>
    ({ value }: { value: string }) => {
      const error = serverErrors[field]
      return error && error.value === value ? { message: error.message } : undefined
    }
  const forgetServerError = (field: string) =>
    setServerErrors((prev) => {
      if (!(field in prev)) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })

  // A reveal always starts empty, whatever the form still holds for the field.
  const openField = (f: CredentialFieldName) => {
    form.resetField(f)
    setOpened((prev) => new Set(prev).add(f))
    setFocusTarget(inputId(source, f))
  }
  // Back to "keep what is there": the typed value, its errors and its server
  // error go, and focus returns to the reveal button that replaces the input.
  // Without the key the reveal button is disabled, so focus goes to Cancel instead.
  const closeField = (f: CredentialFieldName) => {
    form.resetField(f)
    forgetServerError(f)
    // A "fill in at least one field" refusal is about the inputs as they were.
    form.setErrorMap({ onSubmit: undefined })
    setOpened((prev) => {
      const next = new Set(prev)
      next.delete(f)
      return next
    })
    setFocusTarget(keyMissing ? cancelId(source) : credentialRevealId(source, f))
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
    // method="post": should the handler ever miss, a native submit never puts the values in a URL.
    <form
      method="post"
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <div className="flex flex-col gap-5">
        {keyMissing ? (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertDescription id={keyMissingId(source)}>
              {m.charging_credentials_key_missing()}
            </AlertDescription>
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
              <span className="sr-only"> {m.common_opens_in_new_tab()}</span>
            </a>
          </div>
        ) : null}
        {fields.map((f) => {
          const state = states[f]
          const closable = isClosableState(state)
          const suspect = suspectFields.includes(f)
          // Above the input, each on its own line: the format hint, then what
          // saving does to a value the field already has.
          const hint = credentialFieldHint(source, f)
          const description =
            hint || closable ? (
              <>
                {hint ? <span className="block">{hint}</span> : null}
                {closable ? (
                  <span className="block">{m.charging_credentials_keeps_current()}</span>
                ) : null}
                {state === 'env' ? (
                  <span className="block">{m.charging_credentials_overrides_env()}</span>
                ) : null}
              </>
            ) : undefined
          // The badge first: tabbing into the input says where its value stands.
          const describedBy =
            [
              state === 'unknown' ? null : credentialBadgeId(source, f),
              keyMissing ? keyMissingId(source) : null,
              suspect ? credentialSuspectId(source, f) : null,
            ]
              .filter(Boolean)
              .join(' ') || undefined
          const secret = credentialFieldKind(source, f) === 'secret'
          return (
            <CredentialFieldRow
              key={f}
              source={source}
              field={f}
              state={state}
              savedAt={sourceStatus?.updatedAt ?? null}
              open={isOpen(f)}
              onOpen={() => openField(f)}
              onClose={closable ? () => closeField(f) : undefined}
              suspect={suspect}
              disabledBy={keyMissing ? keyMissingId(source) : undefined}
              busy={busy || isSubmitting}
            >
              <form.AppField
                name={f}
                validators={{ onChange: serverError(f) }}
                listeners={{ onChange: () => forgetServerError(f) }}
                children={(field) => (
                  <field.TextField
                    labelledBy={credentialLabelId(source, f)}
                    type={secret ? 'password' : 'text'}
                    // Browsers ignore "off" on password inputs; "new-password" keeps
                    // a saved login out of them.
                    autoComplete={secret ? 'new-password' : 'off'}
                    inputId={inputId(source, f)}
                    inputData={NO_PASSWORD_MANAGER}
                    autoFocus={f === autoFocusField && !keyMissing}
                    disabled={keyMissing}
                    describedBy={describedBy}
                    description={description}
                    descriptionPlacement="above"
                  />
                )}
              />
            </CredentialFieldRow>
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
                  className="pointer-coarse:h-11 w-full text-destructive hover:text-destructive aria-disabled:opacity-50 sm:w-auto"
                  // aria-disabled, not disabled: the confirm hands focus back
                  // here, and a disabled button would drop it to the page.
                  aria-disabled={busy}
                  onClick={(e) => {
                    if (busy) e.preventDefault()
                  }}
                >
                  {m.charging_credentials_remove()}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{m.charging_credentials_remove_title()}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {removeConfirm}{' '}
                    <span className="mt-1.5 block font-medium text-foreground">{afterRemove}</span>
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
          {/* Nothing open, nothing to save: the dialog only shows where values come from. */}
          <form.CancelButton id={cancelId(source)} onClick={() => onDone(false)}>
            {anyOpen ? m.common_cancel() : m.common_close()}
          </form.CancelButton>
          <form.SubmitButton label={m.common_save()} disabled={keyMissing || !anyOpen} />
        </form.AppForm>
      </ResponsiveDialogFooter>
    </form>
  )
}
